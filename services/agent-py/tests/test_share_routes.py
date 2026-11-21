"""`/v1/share` routes — Python mirror of `app/api/share/route.ts`,
`app/api/share/[token]/route.ts` and the share pages' `resolveShare`.

The data layer (`agent_py.shares`, covered by `test_shares.py`) is
patched at the router's module so these tests pin the HTTP contract:
auth, status codes, error codes and the exact response bodies.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import shares
from agent_py.main import create_app
from agent_py.routers import share as share_router

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
OTHER = "00000000-0000-4000-8000-000000000456"
CONV = "10000000-0000-4000-8000-000000000001"
DOC = "20000000-0000-4000-8000-000000000001"
CREATED = datetime(2026, 1, 1, 12, 30, tzinfo=UTC)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


@pytest.fixture(autouse=True)
def _reset_limiter() -> Iterator[None]:
    share_router._share_read_per_ip_limit.reset()
    yield
    share_router._share_read_per_ip_limit.reset()


@pytest.fixture
def db_on() -> Iterator[object]:
    pool = object()
    with (
        patch.object(share_router, "has_pool", return_value=True),
        patch.object(share_router, "get_pool", return_value=pool),
    ):
        yield pool


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


def _detail(r: Any) -> dict[str, Any]:
    body = r.json()
    detail: dict[str, Any] = body.get("detail", body)
    return detail


# --- POST /v1/share -------------------------------------------------------------


def test_create_requires_auth(client: TestClient) -> None:
    r = client.post("/v1/share", json={"kind": "conversation", "conversationId": CONV})
    assert r.status_code == 401


def test_create_conversation_share(client: TestClient, db_on: object) -> None:
    create = AsyncMock(return_value=shares.CreateShareResult(token="t" * 22))
    with patch.object(share_router.shares, "create_share", new=create):
        r = client.post(
            "/v1/share",
            json={"kind": "conversation", "conversationId": CONV},
            headers=_auth(),
        )
    assert r.status_code == 200
    assert r.json() == {"token": "t" * 22, "kind": "conversation"}
    create.assert_awaited_once_with(db_on, user_id=USER, kind="conversation", target_id=CONV)


def test_create_document_share(client: TestClient, db_on: object) -> None:
    create = AsyncMock(return_value=shares.CreateShareResult(token="d" * 22))
    with patch.object(share_router.shares, "create_share", new=create):
        r = client.post("/v1/share", json={"kind": "document", "documentId": DOC}, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"token": "d" * 22, "kind": "document"}
    create.assert_awaited_once_with(db_on, user_id=USER, kind="document", target_id=DOC)


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"kind": "conversation", "conversationId": CONV}, "Conversation not found"),
        ({"kind": "document", "documentId": DOC}, "Document not found"),
    ],
)
@pytest.mark.usefixtures("db_on")
def test_create_foreign_or_missing_target_is_404(
    client: TestClient, body: dict[str, str], message: str
) -> None:
    """Someone else's id (RLS hides it) and a missing one look the same."""
    create = AsyncMock(return_value=shares.CreateShareResult(error="not_found"))
    with patch.object(share_router.shares, "create_share", new=create):
        r = client.post("/v1/share", json=body, headers=_auth(OTHER))
    assert r.status_code == 404
    assert _detail(r) == {"code": "not_found", "message": message}


@pytest.mark.usefixtures("db_on")
def test_create_insert_failure_is_500_without_db_message(client: TestClient) -> None:
    create = AsyncMock(return_value=shares.CreateShareResult(error="failed"))
    with patch.object(share_router.shares, "create_share", new=create):
        r = client.post(
            "/v1/share", json={"kind": "conversation", "conversationId": CONV}, headers=_auth()
        )
    assert r.status_code == 500
    assert _detail(r)["code"] == "unknown"


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "conversation", "documentId": DOC},  # wrong field for the kind
        {"kind": "document", "conversationId": CONV},
        {"kind": "conversation", "conversationId": "not-a-uuid"},
        {"kind": "workspace", "conversationId": CONV},
        {},
    ],
)
@pytest.mark.usefixtures("db_on")
def test_create_rejects_invalid_body(client: TestClient, body: dict[str, str]) -> None:
    create = AsyncMock()
    with patch.object(share_router.shares, "create_share", new=create):
        r = client.post("/v1/share", json=body, headers=_auth())
    assert r.status_code == 422
    create.assert_not_awaited()


def test_create_without_db_is_503(client: TestClient) -> None:
    r = client.post(
        "/v1/share", json={"kind": "conversation", "conversationId": CONV}, headers=_auth()
    )
    assert r.status_code == 503
    assert _detail(r)["code"] == "unavailable"


def test_create_body_cap_is_16k(client: TestClient) -> None:
    r = client.post(
        "/v1/share",
        content=b'{"kind":"conversation","pad":"' + b"x" * (17 * 1024) + b'"}',
        headers={**_auth(), "Content-Type": "application/json"},
    )
    assert r.status_code == 413


# --- DELETE /v1/share/{token} ---------------------------------------------------


def test_revoke_requires_auth(client: TestClient) -> None:
    assert client.delete("/v1/share/tok").status_code == 401


def test_revoke_own_share(client: TestClient, db_on: object) -> None:
    revoke = AsyncMock(return_value=True)
    with patch.object(share_router.shares, "revoke_share", new=revoke):
        r = client.delete("/v1/share/tok", headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    revoke.assert_awaited_once_with(db_on, user_id=USER, token="tok")


@pytest.mark.usefixtures("db_on")
def test_revoke_unknown_or_foreign_token_is_404(client: TestClient) -> None:
    with patch.object(share_router.shares, "revoke_share", new=AsyncMock(return_value=False)):
        r = client.delete("/v1/share/tok", headers=_auth(OTHER))
    assert r.status_code == 404
    assert _detail(r)["code"] == "not_found"


@pytest.mark.usefixtures("db_on")
def test_revoke_db_error_is_500(client: TestClient) -> None:
    revoke = AsyncMock(side_effect=RuntimeError("connection reset: secret dsn"))
    with patch.object(share_router.shares, "revoke_share", new=revoke):
        r = client.delete("/v1/share/tok", headers=_auth())
    assert r.status_code == 500
    assert "secret" not in r.text


def test_revoke_without_db_is_503(client: TestClient) -> None:
    assert client.delete("/v1/share/tok", headers=_auth()).status_code == 503


# --- GET /v1/share/{token} (public) ---------------------------------------------

_CONVERSATION = shares.ResolvedConversationShare(
    conversation_title="Alice chat",
    messages=[
        shares.SharedMessage(id="m1", role="user", content="hi", reasoning=None, position=1),
        shares.SharedMessage(
            id="m2", role="assistant", content="**hello**", reasoning="think", position=2
        ),
    ],
    created_at=CREATED,
)
_DOCUMENT = shares.ResolvedDocumentShare(
    document_title="Untitled", document_content="# Doc", created_at=CREATED
)


def test_get_conversation_share_is_public(client: TestClient, db_on: object) -> None:
    resolve = AsyncMock(return_value=_CONVERSATION)
    with patch.object(share_router.shares, "resolve_share", new=resolve):
        r = client.get("/v1/share/tok")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "kind": "conversation",
        "conversationTitle": "Alice chat",
        "messages": [
            {"id": "m1", "role": "user", "content": "hi", "reasoning": None, "position": 1},
            {
                "id": "m2",
                "role": "assistant",
                "content": "**hello**",
                "reasoning": "think",
                "position": 2,
            },
        ],
        "createdAt": body["createdAt"],
    }
    assert datetime.fromisoformat(body["createdAt"]) == CREATED
    resolve.assert_awaited_once_with(db_on, "tok")


@pytest.mark.usefixtures("db_on")
def test_get_document_share(client: TestClient) -> None:
    with patch.object(share_router.shares, "resolve_share", new=AsyncMock(return_value=_DOCUMENT)):
        r = client.get("/v1/share/tok")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"kind", "documentTitle", "documentContent", "createdAt"}
    assert (body["kind"], body["documentTitle"], body["documentContent"]) == (
        "document",
        "Untitled",
        "# Doc",
    )


@pytest.mark.usefixtures("db_on")
def test_get_share_payload_has_no_user_ids(client: TestClient) -> None:
    for resolved in (_CONVERSATION, _DOCUMENT):
        with patch.object(
            share_router.shares, "resolve_share", new=AsyncMock(return_value=resolved)
        ):
            r = client.get("/v1/share/tok")
        assert "user_id" not in r.text and "userId" not in r.text
        assert USER not in r.text


@pytest.mark.usefixtures("db_on")
def test_get_ignores_a_bogus_authorization_header(client: TestClient) -> None:
    with patch.object(share_router.shares, "resolve_share", new=AsyncMock(return_value=_DOCUMENT)):
        r = client.get("/v1/share/tok", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 200


@pytest.mark.usefixtures("db_on")
def test_get_unknown_or_revoked_token_is_404(client: TestClient) -> None:
    with patch.object(share_router.shares, "resolve_share", new=AsyncMock(return_value=None)):
        r = client.get("/v1/share/tok")
    assert r.status_code == 404
    assert _detail(r) == {"code": "not_found", "message": "Share not found."}


def test_get_without_db_is_the_same_404(client: TestClient) -> None:
    r = client.get("/v1/share/tok")
    assert r.status_code == 404
    assert _detail(r) == {"code": "not_found", "message": "Share not found."}


@pytest.mark.usefixtures("db_on")
def test_get_is_rate_limited_per_ip(client: TestClient) -> None:
    resolve = AsyncMock(return_value=None)
    with patch.object(share_router.shares, "resolve_share", new=resolve):
        limit = share_router._share_read_per_ip_limit.max
        for _ in range(limit):
            assert client.get("/v1/share/tok").status_code == 404
        r = client.get("/v1/share/tok")
    assert r.status_code == 429
    assert _detail(r)["code"] == "rate_limit"
    assert int(r.headers["Retry-After"]) >= 1
    # The limited request never reached the DB.
    assert resolve.await_count == limit
