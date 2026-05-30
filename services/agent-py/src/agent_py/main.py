"""FastAPI application entry point.

Phase 0 (PLAN-agent-api.md): three endpoints — `GET /healthz` (liveness),
`GET /readyz` (dependency reachability), `GET /v1/whoami` (auth smoke test).
No agent logic. Phase 1 adds the queue poller; Phase 2 starts handling
`task_jobs` actions end-to-end.

Run locally:
    uv run uvicorn agent_py.main:app --reload --port 8000

Run in production (mirrors Dockerfile CMD):
    uv run uvicorn agent_py.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI
from pydantic import BaseModel

from . import __version__
from .auth import get_current_user
from .settings import Settings, get_settings


def create_app() -> FastAPI:
    """Application factory.

    Kept as a factory (rather than a module-level `app = FastAPI(...)`)
    so tests can spin up an isolated instance per test with overridden
    settings without leaking state across tests.
    """
    settings = get_settings()
    app = FastAPI(
        title="Hummingbird Agent Service",
        version=__version__,
        description=(
            "Phase 0 scaffolding. See docs/PLAN-agent-api.md for the full "
            "phased plan; this build ships only health + auth endpoints."
        ),
        # /openapi.json is the source of truth for `openapi-typescript`
        # codegen on the Next.js side (see scripts/codegen-agent-types.sh).
        openapi_url="/openapi.json",
    )

    @app.get("/healthz", tags=["meta"], response_model=HealthResponse)
    def healthz() -> HealthResponse:
        """Liveness probe — returns 200 as long as the process is up.

        Does NOT depend on Supabase, the model gateway, or any other
        external service. A failing /healthz means restart the container;
        a failing /readyz means *don't route traffic yet* but the process
        might recover on its own.
        """
        return HealthResponse(status="ok", service=settings.SERVICE_NAME, version=__version__)

    @app.get("/readyz", tags=["meta"], response_model=ReadinessResponse)
    def readyz() -> ReadinessResponse:
        """Readiness probe — reports configured dependencies.

        Phase 0 only reports whether config is *present*, not whether the
        deps are *reachable* (no Supabase round-trip yet). Phase 1 will
        add a `SELECT 1` against Postgres and reach the JWKS / discovery
        endpoint.
        """
        return ReadinessResponse(
            status="ok",
            checks=ReadinessChecks(
                supabase_url_configured=bool(settings.SUPABASE_URL),
                jwt_secret_configured=bool(settings.SUPABASE_JWT_SECRET),
            ),
        )

    @app.get("/v1/whoami", tags=["auth"], response_model=WhoAmIResponse)
    def whoami(
        claims: Annotated[dict[str, object], Depends(get_current_user)],
    ) -> WhoAmIResponse:
        """Auth smoke test — echoes the verified claims (minus secrets).

        Useful during Phase 0 deployment to confirm the JWT secret and
        the Authorization-header plumbing work end-to-end before any
        real endpoints exist. Deliberately under `/v1` so the prefix
        convention exists from day one.
        """
        sub = claims.get("sub")
        role = claims.get("role")
        return WhoAmIResponse(
            user_id=str(sub) if sub is not None else None,
            role=str(role) if role is not None else None,
        )

    return app


# --- Response models --------------------------------------------------------


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


class ReadinessChecks(BaseModel):
    supabase_url_configured: bool
    jwt_secret_configured: bool


class ReadinessResponse(BaseModel):
    status: str
    checks: ReadinessChecks


class WhoAmIResponse(BaseModel):
    user_id: str | None
    role: str | None


# Module-level app for `uvicorn agent_py.main:app`. Tests use `create_app()`
# directly so they get a fresh instance.
app = create_app()


# Re-exports for typed Depends() in callers (mostly tests today; route handlers
# in Phase 1+).
__all__ = ["Settings", "app", "create_app"]
