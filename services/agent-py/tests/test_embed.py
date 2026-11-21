"""`/v1/embed` + `agent_py.embeddings` (port of `app/api/embed/route.ts`,
`lib/server/embeddings/{provider,index-file}.ts`).

The DB is a scripted fake connection (every query recorded with whether
it ran inside a user-impersonating transaction); the embedder is either an
injected function or an `httpx.MockTransport`.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import asyncpg
import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import embeddings as emb
from agent_py.chunk import chunk_text
from agent_py.embeddings import (
    EmbeddingConfig,
    EmbeddingError,
    embed_texts,
    embedding_config,
    index_file_sections,
)
from agent_py.main import create_app
from agent_py.routers import embed as embed_router
from agent_py.settings import Settings

SECRET = "embed-test-secret-at-least-32-bytes-long"
USER = "00000000-0000-4000-8000-0000000000aa"
FILE = "11111111-1111-4111-8111-111111111111"
PATH = "/v1/embed"


# --- Fake asyncpg ---------------------------------------------------------

Responder = Callable[[str, str, tuple[Any, ...]], Any]


class FakeConn:
    """Records `(method, normalised sql, args, impersonated)` per call and
    answers through `responder(method, sql, args)` (raise to fail)."""

    def __init__(self, responder: Responder, log: list[tuple[str, str, tuple[Any, ...], bool]]):
        self._responder = responder
        self.log = log
        self.in_txn = False
        self.impersonated = False

    def _call(self, method: str, sql: str, args: tuple[Any, ...]) -> Any:
        norm = " ".join(sql.split())
        if "SET LOCAL ROLE authenticated" in norm or "request.jwt.claims" in norm:
            assert self.in_txn, "user context must be set inside a transaction"
            self.impersonated = True
            return "SET"
        self.log.append((method, norm, args, self.impersonated))
        return self._responder(method, norm, args)

    async def execute(self, sql: str, *args: Any) -> Any:
        return self._call("execute", sql, args)

    async def fetch(self, sql: str, *args: Any) -> Any:
        return self._call("fetch", sql, args)

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        return self._call("fetchrow", sql, args)

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return self._call("fetchval", sql, args)

    def transaction(self) -> Any:
        conn = self

        class _Txn:
            async def __aenter__(self) -> None:
                conn.in_txn = True

            async def __aexit__(self, *_exc: Any) -> None:
                conn.in_txn = False
                conn.impersonated = False

        return _Txn()


def fake_pool(
    responder: Responder,
) -> tuple[MagicMock, list[tuple[str, str, tuple[Any, ...], bool]]]:
    log: list[tuple[str, str, tuple[Any, ...], bool]] = []

    def acquire() -> Any:
        cm = MagicMock()
        cm.__aenter__ = AsyncMock(return_value=FakeConn(responder, log))
        cm.__aexit__ = AsyncMock(return_value=None)
        return cm

    pool = MagicMock()
    pool.acquire = MagicMock(side_effect=acquire)
    return pool, log


def pg_error(sqlstate: str, message: str = "boom") -> asyncpg.PostgresError:
    exc = asyncpg.PostgresError(message)
    exc.sqlstate = sqlstate  # type: ignore[attr-defined]
    return exc


def db(
    *,
    file_exists: bool = True,
    existing_sections: int = 0,
    insert_error: BaseException | None = None,
    count_error: bool = False,
) -> Responder:
    def respond(method: str, sql: str, args: tuple[Any, ...]) -> Any:
        if sql.startswith("SELECT id FROM public.files"):
            return {"id": args[0]} if file_exists else None
        if sql.startswith("SELECT count(*) FROM public.file_sections"):
            if count_error:
                raise pg_error("42501", "permission denied")
            return existing_sections
        if sql.startswith("DELETE FROM public.file_sections"):
            return "DELETE 3"
        if sql.startswith("INSERT INTO public.file_sections"):
            if insert_error is not None:
                raise insert_error
            return "INSERT 0 1"
        raise AssertionError(f"unexpected SQL: {sql}")

    return respond


class Embedder:
    def __init__(self, dim: int = 3, short: int = 0) -> None:
        self.calls: list[list[str]] = []
        self.dim = dim
        self.short = short

    async def __call__(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        n = len(texts) - self.short
        return [[float(i)] * self.dim for i in range(n)]


def _inserted_rows(log: list[tuple[str, str, tuple[Any, ...], bool]]) -> list[dict[str, Any]]:
    insert = next(e for e in log if e[1].startswith("INSERT"))
    assert "json_populate_recordset(NULL::public.file_sections" in insert[1]
    rows: list[dict[str, Any]] = json.loads(insert[2][0])
    return rows


LONG_TEXT = "\n\n".join(f"Paragraph {i}. " + "word " * 120 for i in range(12))


# --- index_file_sections --------------------------------------------------


async def test_indexes_chunks_as_the_user() -> None:
    pool, log = fake_pool(db())
    embed = Embedder()
    result = await index_file_sections(
        pool, user_id=USER, file_id=FILE, text=LONG_TEXT, embed=embed
    )
    chunks = chunk_text(LONG_TEXT)
    assert len(chunks) > 1
    assert result == emb.IndexFileResult("indexed", len(chunks))
    assert embed.calls == [chunks]
    # Every query ran impersonated (RLS applies).
    assert all(entry[3] for entry in log)
    rows = _inserted_rows(log)
    assert [r["section_index"] for r in rows] == list(range(len(chunks)))
    assert {(r["user_id"], r["file_id"]) for r in rows} == {(USER, FILE)}
    assert [r["content"] for r in rows] == chunks
    assert rows[0]["embedding"] == "[0.0,0.0,0.0]"
    assert json.loads(rows[1]["embedding"]) == [1.0, 1.0, 1.0]


async def test_empty_text_is_skipped_without_db() -> None:
    pool, log = fake_pool(db())
    embed = Embedder()
    result = await index_file_sections(pool, user_id=USER, file_id=FILE, text=" \n ", embed=embed)
    assert result == emb.IndexFileResult("skipped", 0, "empty")
    assert log == []
    assert embed.calls == []


async def test_missing_file_is_skipped_before_embedding() -> None:
    pool, log = fake_pool(db(file_exists=False))
    embed = Embedder()
    result = await index_file_sections(pool, user_id=USER, file_id=FILE, text="hi", embed=embed)
    assert result == emb.IndexFileResult("skipped", 0, "file_not_found")
    assert embed.calls == []
    assert [e[1].split()[0] for e in log] == ["SELECT"]


async def test_already_indexed_is_skipped_with_count() -> None:
    pool, _ = fake_pool(db(existing_sections=7))
    embed = Embedder()
    result = await index_file_sections(pool, user_id=USER, file_id=FILE, text="hi", embed=embed)
    assert result == emb.IndexFileResult("skipped", 7, "already_indexed")
    assert embed.calls == []


async def test_force_drops_and_rebuilds() -> None:
    pool, log = fake_pool(db(existing_sections=7))
    embed = Embedder()
    result = await index_file_sections(
        pool, user_id=USER, file_id=FILE, text="hi", embed=embed, force=True
    )
    assert result == emb.IndexFileResult("indexed", 1)
    ops = [e[1].split()[0] for e in log]
    assert ops == ["SELECT", "DELETE", "INSERT"]  # no count with force


async def test_failed_count_is_ignored() -> None:
    pool, _ = fake_pool(db(count_error=True))
    result = await index_file_sections(
        pool, user_id=USER, file_id=FILE, text="hi", embed=Embedder()
    )
    assert result.status == "indexed"


async def test_fk_violation_on_insert_is_file_not_found() -> None:
    pool, _ = fake_pool(db(insert_error=pg_error("23503")))
    result = await index_file_sections(
        pool, user_id=USER, file_id=FILE, text="hi", embed=Embedder()
    )
    assert result == emb.IndexFileResult("skipped", 0, "file_not_found")


async def test_other_insert_errors_raise() -> None:
    pool, _ = fake_pool(db(insert_error=pg_error("22000", "expected 768 dimensions, not 3")))
    with pytest.raises(RuntimeError, match="file_sections insert failed: expected 768"):
        await index_file_sections(pool, user_id=USER, file_id=FILE, text="hi", embed=Embedder())


async def test_short_batch_leaves_null_vectors() -> None:
    pool, log = fake_pool(db())
    text = "\n\n".join("x" * 1000 for _ in range(3))
    await index_file_sections(pool, user_id=USER, file_id=FILE, text=text, embed=Embedder(short=1))
    rows = _inserted_rows(log)
    assert rows[-1]["embedding"] is None and rows[0]["embedding"] is not None


async def test_lone_surrogates_are_replaced_before_leaving_the_process() -> None:
    pool, log = fake_pool(db())
    embed = Embedder()
    # A hard split at 1500 UTF-16 units cuts the first emoji pair.
    text = "a" + "😀" * 1000
    await index_file_sections(pool, user_id=USER, file_id=FILE, text=text, embed=embed)
    sent = embed.calls[0]
    assert all(ch < "\ud800" or ch > "\udfff" for chunk in sent for ch in chunk)
    assert any("\ufffd" in chunk for chunk in sent)
    assert [r["content"] for r in _inserted_rows(log)] == sent


# --- embedder config + HTTP -----------------------------------------------


def test_config_precedence_matches_ts() -> None:
    assert embedding_config(Settings(_env_file=None)) is None  # type: ignore[call-arg]
    ollama = embedding_config(
        Settings(_env_file=None, OLLAMA_BASE_URL="http://localhost:11434/v1", OLLAMA_API_KEY="o")  # type: ignore[call-arg]
    )
    assert ollama == EmbeddingConfig("http://localhost:11434/v1", "o", "nomic-embed-text")
    dedicated = embedding_config(
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            EMBEDDINGS_BASE_URL="https://emb.example/v1/",
            EMBEDDINGS_API_KEY="",
            EMBEDDINGS_MODEL="text-embedding-3-small",
            OLLAMA_BASE_URL="http://ollama/v1",
            OLLAMA_API_KEY="o",
        )
    )
    # Empty EMBEDDINGS_API_KEY falls through to OLLAMA_API_KEY (TS `||`).
    assert dedicated == EmbeddingConfig("https://emb.example/v1/", "o", "text-embedding-3-small")
    assert dedicated is not None and dedicated.endpoint == "https://emb.example/v1/embeddings"


def _mock_client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_embed_texts_sends_the_ai_sdk_wire_shape() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        body = json.loads(req.content)
        return httpx.Response(200, json={"data": [{"embedding": [0.5, 1]} for _ in body["input"]]})

    config = EmbeddingConfig("http://localhost:11434/v1", "", "nomic-embed-text")
    async with _mock_client(handler) as client:
        out = await embed_texts(["a", "b"], config=config, client=client)
    assert out == [[0.5, 1.0], [0.5, 1.0]]
    assert str(seen[0].url) == "http://localhost:11434/v1/embeddings"
    assert seen[0].headers["authorization"] == "Bearer not-needed"
    assert json.loads(seen[0].content) == {
        "model": "nomic-embed-text",
        "input": ["a", "b"],
        "encoding_format": "float",
    }


async def test_embed_texts_batches_at_2048() -> None:
    sizes: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        n = len(json.loads(req.content)["input"])
        sizes.append(n)
        return httpx.Response(200, json={"data": [{"embedding": [1.0]}] * n})

    config = EmbeddingConfig("http://e/v1", "k", "m")
    async with _mock_client(handler) as client:
        out = await embed_texts(["t"] * 4100, config=config, client=client)
    assert sizes == [2048, 2048, 4]
    assert len(out) == 4100


async def test_embed_texts_empty_makes_no_call() -> None:
    config = EmbeddingConfig("http://e/v1", "k", "m")
    async with _mock_client(lambda r: httpx.Response(500)) as client:
        assert await embed_texts([], config=config, client=client) == []


async def test_retryable_errors_are_retried_then_succeed(monkeypatch: pytest.MonkeyPatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr(emb.asyncio, "sleep", fake_sleep)
    replies = iter(
        [
            httpx.Response(503, json={"error": {"message": "overloaded"}}),
            httpx.Response(429, headers={"retry-after": "1"}),
            httpx.Response(200, json={"data": [{"embedding": [1.0]}]}),
        ]
    )
    config = EmbeddingConfig("http://e/v1", "k", "m")
    async with _mock_client(lambda r: next(replies)) as client:
        assert await embed_texts(["a"], config=config, client=client) == [[1.0]]
    assert sleeps == [2.0, 1.0]


async def test_gives_up_after_two_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(emb.asyncio, "sleep", fake_sleep)
    calls = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500, json={"error": {"message": "down"}})

    config = EmbeddingConfig("http://e/v1", "k", "m")
    async with _mock_client(handler) as client:
        with pytest.raises(EmbeddingError, match=r"Failed after 3 attempts\. Last error: down"):
            await embed_texts(["a"], config=config, client=client)
    assert calls == 3


async def test_non_retryable_and_malformed_answers_fail_fast() -> None:
    config = EmbeddingConfig("http://e/v1", "k", "m")
    async with _mock_client(
        lambda r: httpx.Response(401, json={"error": {"message": "bad key"}})
    ) as c:
        with pytest.raises(EmbeddingError, match="bad key"):
            await embed_texts(["a"], config=config, client=c)
    async with _mock_client(lambda r: httpx.Response(200, json={"data": [{"vec": []}]})) as c:
        with pytest.raises(EmbeddingError, match="expected shape"):
            await embed_texts(["a"], config=config, client=c)


# --- route -------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("EMBEDDINGS_BASE_URL", "http://embedder.test/v1")
    embed_router._embed_limit.reset()
    return TestClient(create_app(enable_poller=False))


def _auth(sub: str = USER) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": sub,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


BODY = {"fileId": FILE, "text": "Some extracted text."}


def _with_pool(responder: Responder) -> Any:
    pool, _ = fake_pool(responder)
    return (
        patch.object(embed_router, "has_pool", return_value=True),
        patch.object(embed_router, "get_pool", return_value=pool),
    )


def test_requires_auth(client: TestClient) -> None:
    assert client.post(PATH, json=BODY).status_code == 401
    assert client.post(PATH, json=BODY, headers={"Authorization": "Bearer nope"}).status_code == 401


@pytest.mark.parametrize(
    "body",
    [{}, {"fileId": "", "text": "x"}, {"fileId": "f" * 65, "text": "x"}, {"fileId": "f"}],
)
def test_invalid_body_is_422(client: TestClient, body: dict[str, Any]) -> None:
    assert client.post(PATH, json=body, headers=_auth()).status_code == 422


def test_text_cap_counts_utf16_units(client: TestClient) -> None:
    # 600_001 emoji = 1_200_002 UTF-16 units (> Zod's cap) but only
    # 600_001 code points (under Pydantic's).
    r = client.post(PATH, json={"fileId": FILE, "text": "😀" * 600_001}, headers=_auth())
    assert r.status_code == 422


def test_not_configured_is_a_200_skip(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMBEDDINGS_BASE_URL", "")
    monkeypatch.setenv("OLLAMA_BASE_URL", "")
    from agent_py import settings as settings_module

    settings_module.get_settings.cache_clear()
    r = client.post(PATH, json=BODY, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"status": "skipped", "sections": 0, "reason": "not_configured"}


def test_no_db_pool_is_503(client: TestClient) -> None:
    r = client.post(PATH, json=BODY, headers=_auth())
    assert r.status_code == 503
    assert r.json()["code"] == "db_unconfigured"


def test_happy_path_indexes(client: TestClient) -> None:
    fake_embed = AsyncMock(return_value=[[0.1, 0.2]])
    has, get = _with_pool(db())
    with has, get, patch.object(embed_router, "embed_texts", fake_embed):
        r = client.post(PATH, json=BODY, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"status": "indexed", "sections": 1}
    assert fake_embed.await_args is not None
    assert fake_embed.await_args.args[0] == ["Some extracted text."]


def test_force_flag_reaches_the_indexer(client: TestClient) -> None:
    fake_index = AsyncMock(return_value=emb.IndexFileResult("indexed", 2))
    has, get = _with_pool(db())
    with has, get, patch.object(embed_router, "index_file_sections", fake_index):
        r = client.post(PATH, json={**BODY, "force": True}, headers=_auth())
    assert r.json() == {"status": "indexed", "sections": 2}
    assert fake_index.await_args is not None
    assert fake_index.await_args.kwargs["force"] is True
    assert fake_index.await_args.kwargs["user_id"] == USER


@pytest.mark.parametrize(
    ("result", "wire"),
    [
        (
            emb.IndexFileResult("skipped", 0, "file_not_found"),
            {"status": "skipped", "sections": 0, "reason": "file_not_found"},
        ),
        (
            emb.IndexFileResult("skipped", 4, "already_indexed"),
            {"status": "skipped", "sections": 4, "reason": "already_indexed"},
        ),
        (
            emb.IndexFileResult("skipped", 0, "empty"),
            {"status": "skipped", "sections": 0, "reason": "empty"},
        ),
    ],
)
def test_skips_are_200(
    client: TestClient, result: emb.IndexFileResult, wire: dict[str, Any]
) -> None:
    has, get = _with_pool(db())
    with (
        has,
        get,
        patch.object(embed_router, "index_file_sections", AsyncMock(return_value=result)),
    ):
        r = client.post(PATH, json=BODY, headers=_auth())
    assert r.status_code == 200
    assert r.json() == wire


def test_failures_are_500_embed_failed(client: TestClient) -> None:
    has, get = _with_pool(db())
    boom = AsyncMock(side_effect=EmbeddingError("Failed after 3 attempts. Last error: down"))
    with has, get, patch.object(embed_router, "index_file_sections", boom):
        r = client.post(PATH, json=BODY, headers=_auth())
    assert r.status_code == 500
    assert r.json() == {
        "code": "embed_failed",
        "message": "Failed after 3 attempts. Last error: down",
    }


def test_rate_limited_per_user(client: TestClient) -> None:
    fake_index = AsyncMock(return_value=emb.IndexFileResult("indexed", 1))
    has, get = _with_pool(db())
    with has, get, patch.object(embed_router, "index_file_sections", fake_index):
        for _ in range(30):
            assert client.post(PATH, json=BODY, headers=_auth()).status_code == 200
        r = client.post(PATH, json=BODY, headers=_auth())
        assert r.status_code == 429
        assert r.json()["code"] == "rate_limit"
        assert int(r.headers["retry-after"]) >= 1
        other = client.post(PATH, json=BODY, headers=_auth("00000000-0000-4000-8000-0000000000bb"))
        assert other.status_code == 200


def test_body_over_4_mib_is_413(client: TestClient) -> None:
    big = json.dumps({"fileId": FILE, "text": "x" * (4 * 1024 * 1024)})
    r = client.post(PATH, content=big, headers={**_auth(), "content-type": "application/json"})
    assert r.status_code == 413
