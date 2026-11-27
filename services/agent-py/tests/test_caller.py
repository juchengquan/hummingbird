"""The optional-user dependency (wave 12, Q123/Q134): a bearer if sent,
else an anonymous caller keyed by client IP, refused `401 auth_required`
under `REQUIRE_AUTH_FOR_AI`."""

from __future__ import annotations

import time
from typing import Annotated

import jwt
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from agent_py.caller import (
    AnonymousWindow,
    Caller,
    optional_caller,
    optional_caller_ungated,
)
from agent_py.error_envelope import install_error_handlers
from agent_py.settings import get_settings

SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
USER = "00000000-0000-4000-8000-0000000000aa"


def _token(**over: object) -> str:
    claims: dict[str, object] = {
        "sub": USER,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    claims.update(over)
    return jwt.encode(claims, SECRET, algorithm="HS256")


def _app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/gated")
    def gated(caller: Annotated[Caller, Depends(optional_caller)]) -> dict[str, object]:
        return {"user": caller.user_id, "key": caller.client_key, "anon": caller.anonymous}

    @app.get("/ungated")
    def ungated(
        caller: Annotated[Caller, Depends(optional_caller_ungated)],
    ) -> dict[str, object]:
        return {"user": caller.user_id, "ai_denied": caller.ai_denied}

    return app


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "1")
    return TestClient(_app())


def test_a_valid_bearer_is_the_user(client: TestClient) -> None:
    r = client.get("/gated", headers={"Authorization": f"Bearer {_token()}"})
    assert r.status_code == 200
    assert r.json()["user"] == USER
    assert r.json()["anon"] is False


def test_no_bearer_is_anonymous_keyed_by_client_ip(client: TestClient) -> None:
    r = client.get("/gated", headers={"X-Forwarded-For": "203.0.113.9"})
    assert r.status_code == 200
    assert r.json() == {"user": None, "key": "203.0.113.9", "anon": True}


def test_an_invalid_bearer_is_401_never_anonymous(client: TestClient) -> None:
    r = client.get("/gated", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
    assert r.json()["code"] == "auth"
    r = client.get("/gated", headers={"Authorization": f"Bearer {_token(role='anon')}"})
    assert r.status_code == 401
    # A header that isn't a bearer at all is no anonymous pass either.
    r = client.get("/gated", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


def test_require_auth_for_ai_refuses_anonymous(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "true")
    r = client.get("/gated")
    assert r.status_code == 401
    assert r.json()["code"] == "auth_required"
    # Signed in, the gate is no obstacle.
    r = client.get("/gated", headers={"Authorization": f"Bearer {_token()}"})
    assert r.status_code == 200


def test_require_auth_is_inert_without_a_way_to_sign_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """As on Next (`isAiAuthRequired`): the flag only bites where sign-in exists."""
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.setenv("SUPABASE_URL", "")
    monkeypatch.setenv("SUPABASE_JWKS_URL", "")
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "true")
    r = TestClient(_app()).get("/gated")
    assert r.status_code == 200
    assert r.json()["anon"] is True


def test_a_malformed_require_auth_flag_is_a_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "yes")
    r = client.get("/gated")
    assert r.status_code == 500


def test_the_ungated_form_lets_anonymous_through_and_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/v1/extract` stays open under the gate but skips vision."""
    assert client.get("/ungated").json() == {"user": None, "ai_denied": False}
    monkeypatch.setenv("REQUIRE_AUTH_FOR_AI", "true")
    get_settings.cache_clear()
    assert client.get("/ungated").json() == {"user": None, "ai_denied": True}
    r = client.get("/ungated", headers={"Authorization": f"Bearer {_token()}"})
    assert r.json() == {"user": USER, "ai_denied": False}
    assert client.get("/ungated", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_an_anonymous_window_limits_anonymous_callers_only() -> None:
    window = AnonymousWindow(per_minute=2, message="Too many fetches.")
    anon = Caller(user_id=None, client_key="198.51.100.1")
    user = Caller(user_id=USER, client_key="198.51.100.1")
    window.check(anon)
    window.check(anon)
    with pytest.raises(Exception) as exc:
        window.check(anon)
    err = exc.value
    assert getattr(err, "status_code", None) == 429
    assert getattr(err, "detail", {})["code"] == "rate_limit"
    assert int(getattr(err, "headers", {})["Retry-After"]) >= 1
    # Another IP has its own bucket; a signed-in caller isn't counted.
    window.check(Caller(user_id=None, client_key="198.51.100.2"))
    for _ in range(5):
        window.check(user)
    window.reset()
    window.check(anon)
