"""JWT middleware tests — the auth contract for every protected endpoint.

Tests are exhaustive on the failure modes because getting auth wrong
silently is how cross-user leaks happen. In particular: a token that is
validly signed with the project secret is NOT enough — the legacy
Supabase anon key is exactly such a token (role `anon`, no `sub`) and
ships in the browser bundle.
"""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER_ID = "6f1c2a4e-8b3d-4f0a-9c1e-2d3b4a5c6d7e"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app())


def _make_jwt(claims: dict[str, object], secret: str = SECRET) -> str:
    """A valid Supabase user access token, with `claims` overriding.
    Pass a value of `None` to drop a claim entirely."""
    base: dict[str, object] = {
        "sub": USER_ID,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
        "iat": int(time.time()),
    }
    merged = {**base, **claims}
    payload = {k: v for k, v in merged.items() if v is not None}
    return jwt.encode(payload, secret, algorithm="HS256")


def _get(client: TestClient, token: str):  # type: ignore[no-untyped-def]
    return client.get("/v1/whoami", headers={"Authorization": f"Bearer {token}"})


def test_whoami_returns_claims_with_valid_token(client: TestClient) -> None:
    r = _get(client, _make_jwt({}))
    assert r.status_code == 200
    assert r.json() == {"user_id": USER_ID, "role": "authenticated"}


def test_whoami_rejects_missing_header(client: TestClient) -> None:
    r = client.get("/v1/whoami")
    assert r.status_code == 401
    assert r.headers.get("www-authenticate") == "Bearer"


def test_whoami_rejects_non_bearer_scheme(client: TestClient) -> None:
    r = client.get("/v1/whoami", headers={"Authorization": "Basic abc=="})
    assert r.status_code == 401


def test_whoami_rejects_garbage_token(client: TestClient) -> None:
    r = _get(client, "not-a-jwt")
    assert r.status_code == 401


def test_whoami_rejects_wrong_secret(client: TestClient) -> None:
    """A token signed with a different secret must NOT be accepted."""
    bad = _make_jwt({}, secret="different-secret-also-32-bytes-long!")
    assert _get(client, bad).status_code == 401


def test_whoami_rejects_expired_token(client: TestClient) -> None:
    expired = _make_jwt({"exp": int(time.time()) - 60, "iat": int(time.time()) - 3600})
    assert _get(client, expired).status_code == 401


def test_whoami_rejects_token_without_exp(client: TestClient) -> None:
    assert _get(client, _make_jwt({"exp": None})).status_code == 401


def test_rejects_legacy_anon_key_shape(client: TestClient) -> None:
    """The legacy Supabase anon key: HS256 with the project secret,
    `role: anon`, no `sub`, issuer `supabase`. It's public (in the
    browser bundle) so it must never authenticate."""
    anon = _make_jwt({"role": "anon", "sub": None, "aud": None, "iss": "supabase"})
    assert _get(client, anon).status_code == 401


def test_rejects_anon_role_even_with_sub_and_aud(client: TestClient) -> None:
    assert _get(client, _make_jwt({"role": "anon"})).status_code == 401


def test_rejects_service_role_token(client: TestClient) -> None:
    """User-facing endpoints never accept the service role."""
    assert _get(client, _make_jwt({"role": "service_role"})).status_code == 401


def test_rejects_missing_role(client: TestClient) -> None:
    assert _get(client, _make_jwt({"role": None})).status_code == 401


def test_rejects_missing_sub(client: TestClient) -> None:
    assert _get(client, _make_jwt({"sub": None})).status_code == 401


def test_rejects_non_uuid_sub(client: TestClient) -> None:
    assert _get(client, _make_jwt({"sub": "user-123"})).status_code == 401


def test_rejects_missing_aud(client: TestClient) -> None:
    assert _get(client, _make_jwt({"aud": None})).status_code == 401


def test_rejects_wrong_aud(client: TestClient) -> None:
    assert _get(client, _make_jwt({"aud": "something-else"})).status_code == 401


def test_audience_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("SUPABASE_JWT_AUDIENCE", "custom-aud")
    c = TestClient(create_app())
    assert _get(c, _make_jwt({"aud": "custom-aud"})).status_code == 200
    assert _get(c, _make_jwt({})).status_code == 401


def test_error_body_does_not_echo_jwt_library_message(client: TestClient) -> None:
    """The 401 body is generic — no PyJWT exception text (which would
    tell a prober exactly which check failed)."""
    r = _get(client, _make_jwt({"exp": int(time.time()) - 60}))
    assert r.status_code == 401
    assert r.json() == {"code": "auth", "message": "Invalid token."}
    r = _get(client, _make_jwt({"aud": "nope"}))
    assert r.json() == {"code": "auth", "message": "Invalid token."}
    r = _get(client, "not-a-jwt")
    assert r.json() == {"code": "auth", "message": "Invalid token."}


def test_whoami_returns_503_when_secret_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Distinct from 401: misconfig is a deployment problem, not a user
    problem. /healthz alerts should be able to fire on this without
    being drowned out by every unauthenticated request."""
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    client = TestClient(create_app())
    assert _get(client, _make_jwt({})).status_code == 503
