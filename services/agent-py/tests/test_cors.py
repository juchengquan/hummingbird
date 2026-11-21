"""Opt-in CORS (`CORS_ALLOWED_ORIGINS`).

Without it a browser on another origin can't call the API at all: the
preflight for a bearer-authenticated POST gets a 405. With it, only the
listed exact origins are allowed, and never with credentials.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_py.main import cors_allowed_origins, create_app
from agent_py.settings import Settings

PREFLIGHT = {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type",
}


def _client(monkeypatch: pytest.MonkeyPatch, origins: str) -> TestClient:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-secret-do-not-use-in-prod-32-bytes!")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", origins)
    return TestClient(create_app(enable_poller=False))


def test_off_by_default_sends_no_cors_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(monkeypatch, "")
    res = client.options("/v1/chat", headers={"Origin": "http://localhost:3000", **PREFLIGHT})
    assert "access-control-allow-origin" not in res.headers


def test_listed_origin_preflight_is_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(monkeypatch, "http://localhost:3000")
    res = client.options("/v1/chat", headers={"Origin": "http://localhost:3000", **PREFLIGHT})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "http://localhost:3000"
    allowed = res.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed
    assert "access-control-allow-credentials" not in res.headers


def test_unlisted_origin_gets_no_allow_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(monkeypatch, "http://localhost:3000")
    res = client.options("/v1/chat", headers={"Origin": "https://evil.example", **PREFLIGHT})
    assert res.headers.get("access-control-allow-origin") != "https://evil.example"


def test_simple_request_from_listed_origin_carries_allow_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, "http://localhost:3000")
    res = client.get("/healthz", headers={"Origin": "http://localhost:3000"})
    assert res.status_code == 200
    assert res.headers["access-control-allow-origin"] == "http://localhost:3000"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", []),
        ("http://localhost:3000", ["http://localhost:3000"]),
        (" http://a.test , https://b.test:8443/ ", ["http://a.test", "https://b.test:8443"]),
        ("*", []),
        ("localhost:3000", []),
        ("ftp://a.test", []),
        ("https://a.test/path", []),
        ("https://", []),
    ],
)
def test_origin_parsing_keeps_only_exact_origins(raw: str, expected: list[str]) -> None:
    assert cors_allowed_origins(Settings(CORS_ALLOWED_ORIGINS=raw)) == expected
