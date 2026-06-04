"""Route-level tests for `/v1/url/fetch` + `/v1/images/refresh-url`
(Phase 4-4-a)."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app
from agent_py.routers import images as images_router
from agent_py.routers import url as url_router
from agent_py.url_fetch import BookmarkSnapshot, FetchError, FetchOk

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app(enable_poller=False))


def _token(sub: str = "user-uuid-123") -> str:
    return jwt.encode(
        {"sub": sub, "role": "authenticated", "exp": int(time.time()) + 3600},
        SECRET,
        algorithm="HS256",
    )


def _auth(sub: str = "user-uuid-123") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


# --- /v1/url/fetch ----------------------------------------------------


def test_url_fetch_rejects_missing_token(client: TestClient) -> None:
    r = client.post("/v1/url/fetch", json={"url": "https://example.com"})
    assert r.status_code == 401


def test_url_fetch_rejects_empty_body(client: TestClient) -> None:
    r = client.post("/v1/url/fetch", json={"url": ""}, headers=_auth())
    assert r.status_code == 422


def test_url_fetch_invalid_url_returns_400(client: TestClient) -> None:
    """Input that doesn't normalize (whitespace-only after strip) →
    400 with the documented `invalid_url` code. Non-empty garbage
    falls through to the validator, which raises its own
    `validation` code (covered by the parametrised test below)."""
    r = client.post("/v1/url/fetch", json={"url": "   "}, headers=_auth())
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_url"


def test_url_fetch_happy_path_returns_bookmark(client: TestClient) -> None:
    snap = BookmarkSnapshot(
        url="https://example.com/p",
        title="Example",
        content="hello",
        content_truncated=False,
        content_hash="deadbeef00000000",
        description="A page",
        favicon_url="https://example.com/favicon.ico",
    )
    with patch.object(
        url_router,
        "fetch_url_bookmark",
        new=AsyncMock(return_value=FetchOk(snapshot=snap)),
    ):
        r = client.post("/v1/url/fetch", json={"url": "example.com/p"}, headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["bookmark"]["title"] == "Example"
    assert body["bookmark"]["url"] == "https://example.com/p"
    assert body["bookmark"]["content_truncated"] is False
    assert body["bookmark"]["favicon_url"] == "https://example.com/favicon.ico"


@pytest.mark.parametrize(
    "code, expected_status",
    [
        ("validation", 400),
        ("unsupported_content_type", 400),
        ("timeout", 408),
        ("body_too_large", 413),
        ("too_many_redirects", 502),
        ("http_error", 502),
        ("network", 502),
    ],
)
def test_url_fetch_error_codes_to_http_status(
    client: TestClient, code: str, expected_status: int
) -> None:
    """Each `FetchError.code` maps to the documented HTTP status."""
    err = FetchError(code=code, message="x", status=503 if code == "http_error" else None)  # type: ignore[arg-type]
    with patch.object(url_router, "fetch_url_bookmark", new=AsyncMock(return_value=err)):
        r = client.post("/v1/url/fetch", json={"url": "https://example.com"}, headers=_auth())
    assert r.status_code == expected_status
    assert r.json()["detail"]["code"] == code


# --- /v1/images/refresh-url -------------------------------------------


def test_refresh_url_rejects_missing_token(client: TestClient) -> None:
    r = client.post("/v1/images/refresh-url", json={"storage_path": "u/g/x.png"})
    assert r.status_code == 401


def test_refresh_url_403_when_path_doesnt_match_user(
    client: TestClient,
) -> None:
    """The storage path's first segment must equal the JWT sub.
    Without this, a signed-in user could re-sign someone else's
    storage path. RLS would also refuse but a clean 403 is friendlier."""
    r = client.post(
        "/v1/images/refresh-url",
        json={"storage_path": "other-user/generated/img.png"},
        headers=_auth("user-uuid-123"),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"


def test_refresh_url_404_when_sign_fails(client: TestClient) -> None:
    """`sign_storage_path` returns None (object missing OR Storage
    unconfigured) → 404."""
    with patch.object(images_router, "sign_storage_path", new=AsyncMock(return_value=None)):
        r = client.post(
            "/v1/images/refresh-url",
            json={"storage_path": "user-uuid-123/generated/img.png"},
            headers=_auth("user-uuid-123"),
        )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"


def test_refresh_url_happy_path_returns_signed_url(client: TestClient) -> None:
    with patch.object(
        images_router,
        "sign_storage_path",
        new=AsyncMock(return_value="https://proj.supabase.test/x?token=abc"),
    ):
        r = client.post(
            "/v1/images/refresh-url",
            json={"storage_path": "user-uuid-123/generated/img.png"},
            headers=_auth("user-uuid-123"),
        )
    assert r.status_code == 200
    assert r.json()["url"] == "https://proj.supabase.test/x?token=abc"


def test_refresh_url_validates_storage_path_length(client: TestClient) -> None:
    """Length capped to 1000 chars — anything bigger → 422 before
    we touch Storage."""
    long_path = "user-uuid-123/" + ("a" * 2000)
    r = client.post(
        "/v1/images/refresh-url",
        json={"storage_path": long_path},
        headers=_auth(),
    )
    assert r.status_code == 422


# --- sign_storage_path helper (direct) --------------------------------


def test_sign_storage_path_unconfigured_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The standalone helper returns None when SUPABASE_URL / service
    key aren't both set. Used by the route to surface a 404."""
    from agent_py import image_storage
    from agent_py import settings as settings_module

    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    settings_module.get_settings.cache_clear()

    import asyncio

    out = asyncio.run(image_storage.sign_storage_path("u/g/img.png"))
    assert out is None


def test_sign_storage_path_happy_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Patched httpx returns a `signedURL` payload → helper joins it
    onto the project origin."""
    import asyncio

    import httpx

    from agent_py import image_storage
    from agent_py import settings as settings_module

    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k" * 32)
    settings_module.get_settings.cache_clear()

    def handler(req: httpx.Request) -> httpx.Response:
        assert "/storage/v1/object/sign/user-files/u/g/img.png" in str(req.url)
        return httpx.Response(
            200, json={"signedURL": "/object/sign/user-files/u/g/img.png?token=abc"}
        )

    async def run() -> str | None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client_:
            return await image_storage.sign_storage_path("u/g/img.png", client=client_)

    url = asyncio.run(run())
    assert url is not None
    assert url == (
        "https://proj.supabase.test/storage/v1/object/sign/user-files/u/g/img.png?token=abc"
    )
