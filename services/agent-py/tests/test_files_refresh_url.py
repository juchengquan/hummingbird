"""`/v1/files/refresh-url` — Python mirror of
`app/api/files/refresh-url/route.ts`. Storage signing is patched at the
router's `sign_storage_path` import; `is_storage_configured` likewise."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from unittest.mock import AsyncMock, patch

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import image_storage
from agent_py import settings as settings_module
from agent_py.main import create_app
from agent_py.routers import files as files_router

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-000000000123"
OWN_PATH = f"{USER}/generated/f1-report.csv"
PATH = "/v1/files/refresh-url"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
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


@pytest.fixture
def storage_on() -> Iterator[None]:
    with patch.object(files_router, "is_storage_configured", return_value=True):
        yield


def test_rejects_missing_token(client: TestClient) -> None:
    r = client.post(PATH, json={"storagePath": OWN_PATH})
    assert r.status_code == 401


@pytest.mark.usefixtures("storage_on")
def test_happy_path_returns_signed_url(client: TestClient) -> None:
    sign = AsyncMock(return_value="https://proj.supabase.test/x?token=abc")
    with patch.object(files_router, "sign_storage_path", new=sign):
        r = client.post(PATH, json={"storagePath": OWN_PATH}, headers=_auth())
    assert r.status_code == 200
    assert r.json() == {"url": "https://proj.supabase.test/x?token=abc"}
    sign.assert_awaited_once_with(OWN_PATH)


@pytest.mark.usefixtures("storage_on")
def test_foreign_uid_path_is_403(client: TestClient) -> None:
    """The path's first segment must equal the JWT `sub` — the
    service-role key bypasses RLS, so this is the authorisation."""
    sign = AsyncMock(return_value="https://never")
    with patch.object(files_router, "sign_storage_path", new=sign):
        r = client.post(
            PATH,
            json={"storagePath": "11111111-1111-4111-8111-111111111111/generated/x.csv"},
            headers=_auth(),
        )
    assert r.status_code == 403
    assert r.json() == {
        "code": "forbidden",
        "message": "Storage path does not belong to you.",
    }
    sign.assert_not_awaited()


@pytest.mark.usefixtures("storage_on")
def test_uid_prefix_without_separator_is_403(client: TestClient) -> None:
    """`<uid>evil/...` shares a prefix with the uid but isn't its folder."""
    r = client.post(PATH, json={"storagePath": f"{USER}evil/x.csv"}, headers=_auth())
    assert r.status_code == 403


@pytest.mark.usefixtures("storage_on")
def test_sign_failure_is_404(client: TestClient) -> None:
    with patch.object(files_router, "sign_storage_path", new=AsyncMock(return_value=None)):
        r = client.post(PATH, json={"storagePath": OWN_PATH}, headers=_auth())
    assert r.status_code == 404
    assert r.json() == {
        "code": "not_found",
        "message": "Could not re-sign the URL — object may be missing.",
    }


def test_storage_unconfigured_is_503(client: TestClient) -> None:
    with patch.object(files_router, "is_storage_configured", return_value=False):
        r = client.post(PATH, json={"storagePath": OWN_PATH}, headers=_auth())
    assert r.status_code == 503
    assert r.json() == {"code": "unavailable", "message": "Supabase is not configured."}


@pytest.mark.usefixtures("storage_on")
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"storagePath": ""},
        {"storagePath": f"{USER}/" + "a" * 600},  # > 512
        {"storagePath": f"{USER}/../other/x.csv"},  # traversal
        {"storagePath": f"/{USER}/x.csv"},  # leading slash
        {"storage_path": OWN_PATH},  # the Zod field is camelCase
    ],
)
def test_invalid_body_is_422(client: TestClient, body: dict[str, str]) -> None:
    sign = AsyncMock(return_value="https://never")
    with patch.object(files_router, "sign_storage_path", new=sign):
        r = client.post(PATH, json=body, headers=_auth())
    assert r.status_code == 422
    sign.assert_not_awaited()


def test_sign_storage_path_percent_encodes_the_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """`?` / `#` / `%` in a caller-supplied path stay part of the object
    name — they can't add a query string or smuggle `%2E%2E` past the
    route's first-segment check."""
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.test")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k" * 32)
    settings_module.get_settings.cache_clear()
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.raw_path.decode())
        return httpx.Response(200, json={"signedURL": "/object/sign/user-files/x?token=t"})

    async def run() -> str | None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await image_storage.sign_storage_path(f"{USER}/%2E%2E/a?b#c", client=c)

    assert asyncio.run(run()) is not None
    assert seen == [f"/storage/v1/object/sign/user-files/{USER}/%252E%252E/a%3Fb%23c"]
