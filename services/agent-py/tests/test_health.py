"""Phase 0 smoke tests — health + readiness endpoints.

These are the only invariants Phase 0 commits to:
  - /healthz returns 200 regardless of configuration
  - /readyz returns 200 and accurately reports which configs are present
  - the response shape matches the documented schema (mirrored in the
    OpenAPI doc consumed by the Next.js codegen pipeline)
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_healthz_returns_ok(client: TestClient) -> None:
    """Liveness probe should always return 200 — even with zero config.

    A 5xx here would tell ops to restart the container; we want that to
    be a meaningful signal, so don't add deps to this endpoint.
    """
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "agent-py"
    # version pinned to the package's __version__; doesn't fail across bumps
    # as long as the field is present and a string.
    assert isinstance(body["version"], str) and body["version"]


def test_readyz_reports_config_state(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Readiness should report which configs are set.

    In Phase 0 readiness == config-present, not config-reachable. Phase 1
    will tighten this by actually hitting Supabase.
    """
    # Both unset (default in tests).
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    fresh_client = TestClient(create_app())
    r = fresh_client.get("/readyz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["checks"] == {
        "supabase_url_configured": False,
        "jwt_secret_configured": False,
    }


def test_readyz_picks_up_configured_envs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When env vars are set, readiness reflects that.

    Creating a fresh app picks up the new env via the settings factory
    (the conftest fixture clears the cache before this test runs).
    """
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-secret")
    client = TestClient(create_app())
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json()["checks"] == {
        "supabase_url_configured": True,
        "jwt_secret_configured": True,
    }
