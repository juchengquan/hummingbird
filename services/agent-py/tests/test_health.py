"""Phase 1 smoke tests — health + readiness endpoints.

Invariants:
  - /healthz returns 200 regardless of configuration
  - /readyz returns 200 and accurately reports which configs are
    present + whether the DB pool is open
  - the response shape matches the documented schema (mirrored in the
    OpenAPI doc consumed by the Next.js codegen pipeline)

The poll loop is disabled in these tests (`enable_poller=False`) so
the lifespan doesn't try to open a Postgres pool against env-derived
config that isn't a real DB.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from agent_py.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(enable_poller=False))


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


def test_readyz_reports_config_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Readiness should report which configs are set + DB pool state."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    client = TestClient(create_app(enable_poller=False))
    r = client.get("/readyz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["checks"] == {
        "supabase_url_configured": False,
        "supabase_db_configured": False,
        "jwt_secret_configured": False,
        "db_pool_open": False,
    }


def test_readyz_picks_up_configured_envs(monkeypatch: pytest.MonkeyPatch) -> None:
    """When env vars are set, readiness reflects that.

    `db_pool_open` stays False because we don't actually open a pool
    in this test (no real Postgres). Phase 1 readiness reports
    "config + pool state", not "Postgres reachable".
    """
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-secret-32-bytes-minimum-len!")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://localhost/example")
    client = TestClient(create_app(enable_poller=False))
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json()["checks"] == {
        "supabase_url_configured": True,
        "supabase_db_configured": True,
        "jwt_secret_configured": True,
        "db_pool_open": False,
    }
