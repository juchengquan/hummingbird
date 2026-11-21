"""`agent_py.shares` — the data layer behind `/v1/share`.

An in-memory fake of the asyncpg pool answers each statement from
seeded rows, filtering on the bound parameters the way Postgres would.
A resolver that forgot the owner filter would therefore leak another
user's rows here exactly as it would against the real DB (the public
read runs without RLS) — the same approach as
`lib/server/share/resolve.test.ts`.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import pytest

from agent_py import shares

ALICE = "00000000-0000-4000-8000-00000000a11c"
MALLORY = "00000000-0000-4000-8000-0000000ba11e"
ALICE_CONV = "10000000-0000-4000-8000-000000000001"
MALLORY_CONV = "10000000-0000-4000-8000-000000000002"
ALICE_DOC = "20000000-0000-4000-8000-000000000001"
MALLORY_DOC = "20000000-0000-4000-8000-000000000002"
CREATED = datetime(2026, 1, 1, tzinfo=UTC)

Row = dict[str, Any]


def _share(**over: Any) -> Row:
    row: Row = {
        "token": "tok",
        "user_id": ALICE,
        "kind": "conversation",
        "conversation_id": None,
        "document_id": None,
        "created_at": CREATED,
        "revoked_at": None,
    }
    row.update(over)
    return row


def _msg(id_: str, conv: str, user: str, position: int) -> Row:
    return {
        "id": id_,
        "conversation_id": conv,
        "user_id": user,
        "role": "user",
        "content": id_,
        "reasoning": None,
        "position": position,
    }


def _base() -> dict[str, list[Row]]:
    return {
        "shares": [],
        "conversations": [
            {"id": ALICE_CONV, "user_id": ALICE, "title": "Alice chat"},
            {"id": MALLORY_CONV, "user_id": MALLORY, "title": "Mallory chat"},
        ],
        "documents": [
            {"id": ALICE_DOC, "user_id": ALICE, "title": "Alice doc", "content": "secret"},
            {"id": MALLORY_DOC, "user_id": MALLORY, "title": "", "content": "mine"},
        ],
        "messages": [
            _msg("m2", ALICE_CONV, ALICE, 2),
            _msg("m1", ALICE_CONV, ALICE, 1),
            # Injected into Alice's conversation by another user.
            _msg("evil", ALICE_CONV, MALLORY, 3),
            _msg("other", MALLORY_CONV, MALLORY, 1),
        ],
    }


class FakeConn:
    """Answers the statements `agent_py.shares` issues. Records every
    statement so tests can assert on impersonation and filters."""

    def __init__(self, tables: dict[str, list[Row]], *, fail_on: str | None = None) -> None:
        self.tables = tables
        self.fail_on = fail_on
        self.statements: list[tuple[str, tuple[Any, ...]]] = []
        self.transactions: list[dict[str, Any]] = []

    @asynccontextmanager
    async def transaction(self, **kwargs: Any) -> AsyncIterator[None]:
        self.transactions.append(kwargs)
        yield

    def _check_fail(self, sql: str) -> None:
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError(f"boom: {self.fail_on}")

    async def execute(self, sql: str, *args: Any) -> str:
        self.statements.append((sql, args))
        self._check_fail(sql)
        if sql.startswith("INSERT INTO public.shares"):
            token, user_id, kind, conv, doc = args
            self.tables["shares"].append(
                _share(
                    token=token,
                    user_id=user_id,
                    kind=kind,
                    conversation_id=conv,
                    document_id=doc,
                )
            )
        return "OK"

    def _select(self, table: str, sql: str, args: tuple[Any, ...]) -> list[Row]:
        # Map `col = $n` predicates onto the bound args.
        preds = re.findall(r"(\w+) = \$(\d)", sql.split("WHERE", 1)[1])
        rows = [
            r for r in self.tables[table] if all(r.get(col) == args[int(n) - 1] for col, n in preds)
        ]
        if "ORDER BY position" in sql:
            rows.sort(key=lambda r: r["position"])
        return rows

    async def fetchval(self, sql: str, *args: Any) -> Any:
        self.statements.append((sql, args))
        self._check_fail(sql)
        table = re.search(r"FROM public\.(\w+)", sql)
        assert table
        return 1 if self._select(table.group(1), sql, args) else None

    async def fetchrow(self, sql: str, *args: Any) -> Row | None:
        self.statements.append((sql, args))
        self._check_fail(sql)
        if sql.startswith("UPDATE public.shares"):
            hits = self._select("shares", sql, args)
            for r in hits:
                r["revoked_at"] = CREATED
            return {"token": hits[0]["token"]} if hits else None
        table = re.search(r"FROM public\.(\w+)", sql)
        assert table
        rows = self._select(table.group(1), sql, args)
        assert len(rows) <= 1, "fetchrow matched several rows"
        return rows[0] if rows else None

    async def fetch(self, sql: str, *args: Any) -> list[Row]:
        self.statements.append((sql, args))
        self._check_fail(sql)
        table = re.search(r"FROM public\.(\w+)", sql)
        assert table
        return self._select(table.group(1), sql, args)


class FakePool:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[FakeConn]:
        yield self.conn


def _pool(tables: dict[str, list[Row]], **kw: Any) -> tuple[Any, FakeConn]:
    conn = FakeConn(tables, **kw)
    return FakePool(conn), conn


def _impersonated(conn: FakeConn, user_id: str) -> bool:
    """`store._set_user_context` ran for `user_id` before any data SQL."""
    sqls = [s for s, _ in conn.statements]
    if not sqls or "SET LOCAL ROLE authenticated" not in sqls[0]:
        return False
    claims = conn.statements[1][1][0]
    return f'"sub": "{user_id}"' in claims


# --- mint_token --------------------------------------------------------------


def test_mint_token_is_22_char_base64url() -> None:
    tokens = {shares.mint_token() for _ in range(200)}
    assert len(tokens) == 200
    for t in tokens:
        assert re.fullmatch(r"[A-Za-z0-9_-]{22}", t), t


# --- create --------------------------------------------------------------------


def test_create_conversation_share_inserts_under_user_rls() -> None:
    tables = _base()
    pool, conn = _pool(tables)
    res = asyncio.run(
        shares.create_share(pool, user_id=ALICE, kind="conversation", target_id=ALICE_CONV)
    )
    assert res.error is None and res.token is not None
    assert _impersonated(conn, ALICE)
    assert conn.transactions == [{}]
    [row] = tables["shares"]
    assert row["token"] == res.token
    assert row["user_id"] == ALICE
    assert row["kind"] == "conversation"
    assert row["conversation_id"] == ALICE_CONV
    assert row["document_id"] is None


def test_create_document_share_sets_document_id_only() -> None:
    tables = _base()
    pool, _ = _pool(tables)
    res = asyncio.run(
        shares.create_share(pool, user_id=ALICE, kind="document", target_id=ALICE_DOC)
    )
    assert res.token
    [row] = tables["shares"]
    assert (row["kind"], row["conversation_id"], row["document_id"]) == (
        "document",
        None,
        ALICE_DOC,
    )


@pytest.mark.parametrize(
    ("kind", "target"),
    [("conversation", MALLORY_CONV), ("document", MALLORY_DOC), ("conversation", ALICE_DOC)],
)
def test_create_rejects_foreign_or_missing_target(kind: Any, target: str) -> None:
    tables = _base()
    pool, _ = _pool(tables)
    res = asyncio.run(shares.create_share(pool, user_id=ALICE, kind=kind, target_id=target))
    assert res.error == "not_found" and res.token is None
    assert tables["shares"] == []


def test_create_insert_failure_is_failed_not_raised() -> None:
    pool, _ = _pool(_base(), fail_on="INSERT INTO public.shares")
    res = asyncio.run(
        shares.create_share(pool, user_id=ALICE, kind="conversation", target_id=ALICE_CONV)
    )
    assert res.error == "failed" and res.token is None


# --- revoke --------------------------------------------------------------------


def test_revoke_own_share() -> None:
    tables = _base()
    tables["shares"].append(_share(conversation_id=ALICE_CONV))
    pool, conn = _pool(tables)
    assert asyncio.run(shares.revoke_share(pool, user_id=ALICE, token="tok")) is True
    assert tables["shares"][0]["revoked_at"] is not None
    assert _impersonated(conn, ALICE)


def test_revoke_someone_elses_share_matches_nothing() -> None:
    tables = _base()
    tables["shares"].append(_share(conversation_id=ALICE_CONV))
    pool, _ = _pool(tables)
    assert asyncio.run(shares.revoke_share(pool, user_id=MALLORY, token="tok")) is False
    assert tables["shares"][0]["revoked_at"] is None


def test_revoke_unknown_token() -> None:
    pool, _ = _pool(_base())
    assert asyncio.run(shares.revoke_share(pool, user_id=ALICE, token="nope")) is False


def test_revoke_db_error_raises() -> None:
    pool, _ = _pool(_base(), fail_on="UPDATE public.shares")
    with pytest.raises(RuntimeError):
        asyncio.run(shares.revoke_share(pool, user_id=ALICE, token="tok"))


# --- resolve -------------------------------------------------------------------


def _resolve(tables: dict[str, list[Row]], token: str = "tok") -> tuple[Any, FakeConn]:
    pool, conn = _pool(tables)
    return asyncio.run(shares.resolve_share(pool, token)), conn


def test_resolve_unknown_token() -> None:
    res, _ = _resolve(_base())
    assert res is None


def test_resolve_revoked_share() -> None:
    tables = _base()
    tables["shares"].append(_share(conversation_id=ALICE_CONV, revoked_at=CREATED))
    res, _ = _resolve(tables)
    assert res is None


def test_resolve_conversation_owner_messages_only_in_order() -> None:
    tables = _base()
    tables["shares"].append(_share(conversation_id=ALICE_CONV))
    res, conn = _resolve(tables)
    assert isinstance(res, shares.ResolvedConversationShare)
    assert res.conversation_title == "Alice chat"
    assert [m.id for m in res.messages] == ["m1", "m2"]
    assert res.created_at == CREATED
    # Public read: no impersonation, read-only snapshot.
    assert conn.transactions == [{"readonly": True}]
    assert not any("SET LOCAL ROLE" in s for s, _ in conn.statements)
    msg_sql = next(s for s, _ in conn.statements if "FROM public.messages" in s)
    assert f"LIMIT {shares.MAX_SHARED_MESSAGES}" in msg_sql


def test_resolve_conversation_share_pointing_at_foreign_conversation() -> None:
    tables = _base()
    tables["shares"].append(_share(user_id=MALLORY, conversation_id=ALICE_CONV))
    res, conn = _resolve(tables)
    assert res is None
    # Never read the victim's messages.
    assert not any("FROM public.messages" in s for s, _ in conn.statements)


def test_resolve_document_share() -> None:
    tables = _base()
    tables["shares"].append(_share(kind="document", document_id=MALLORY_DOC, user_id=MALLORY))
    res, _ = _resolve(tables)
    assert res == shares.ResolvedDocumentShare(
        document_title="Untitled", document_content="mine", created_at=CREATED
    )


def test_resolve_document_share_pointing_at_foreign_document() -> None:
    tables = _base()
    tables["shares"].append(_share(kind="document", document_id=ALICE_DOC, user_id=MALLORY))
    res, _ = _resolve(tables)
    assert res is None


def test_resolve_share_without_target_id() -> None:
    tables = _base()
    tables["shares"].append(_share(kind="document"))
    tables["shares"].append(_share(token="tok2"))
    assert _resolve(tables)[0] is None
    assert _resolve(tables, "tok2")[0] is None


def test_resolve_db_error_is_none() -> None:
    tables = _base()
    tables["shares"].append(_share(conversation_id=ALICE_CONV))
    pool, _ = _pool(tables, fail_on="FROM public.messages")
    assert asyncio.run(shares.resolve_share(pool, "tok")) is None
