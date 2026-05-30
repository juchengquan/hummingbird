"""JWT middleware tests — the auth contract for every protected endpoint.

Phase 0 only has one protected endpoint (`/v1/whoami`), but the failure
shapes here are the contract the rest of the service depends on. Tests are
exhaustive on the failure modes because getting auth wrong silently is
how cross-user leaks happen.
"""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    return TestClient(create_app())


def _make_jwt(claims: dict[str, object], secret: str = SECRET) -> str:
    base = {"exp": int(time.time()) + 3600, "iat": int(time.time())}
    return jwt.encode({**base, **claims}, secret, algorithm="HS256")


def test_whoami_returns_claims_with_valid_token(client: TestClient) -> None:
    token = _make_jwt({"sub": "user-uuid-123", "role": "authenticated"})
    r = client.get("/v1/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"user_id": "user-uuid-123", "role": "authenticated"}


def test_whoami_rejects_missing_header(client: TestClient) -> None:
    r = client.get("/v1/whoami")
    assert r.status_code == 401
    assert r.headers.get("www-authenticate") == "Bearer"


def test_whoami_rejects_non_bearer_scheme(client: TestClient) -> None:
    r = client.get("/v1/whoami", headers={"Authorization": "Basic abc=="})
    assert r.status_code == 401


def test_whoami_rejects_garbage_token(client: TestClient) -> None:
    r = client.get("/v1/whoami", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


def test_whoami_rejects_wrong_secret(client: TestClient) -> None:
    """A token signed with a different secret must NOT be accepted."""
    bad = _make_jwt({"sub": "u"}, secret="different-secret-also-32-bytes-long!")
    r = client.get("/v1/whoami", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_whoami_rejects_expired_token(client: TestClient) -> None:
    expired = jwt.encode(
        {"sub": "u", "exp": int(time.time()) - 60, "iat": int(time.time()) - 3600},
        SECRET,
        algorithm="HS256",
    )
    r = client.get("/v1/whoami", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401


def test_whoami_returns_503_when_secret_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Distinct from 401: misconfig is a deployment problem, not a user
    problem. /healthz alerts should be able to fire on this without
    being drowned out by every unauthenticated request."""
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    client = TestClient(create_app())
    token = _make_jwt({"sub": "u"})
    r = client.get("/v1/whoami", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 503
