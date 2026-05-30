"""FastAPI application entry point.

Phase 0 shipped the health + auth endpoints; Phase 1 adds the
background `task_jobs` poll loop (dry-run — log + release, never
execute). The poll loop runs as an asyncio task managed by the
FastAPI lifespan: started on app startup, cancelled on shutdown.

Run locally:
    uv run uvicorn agent_py.main:app --reload --port 8000

Run in production (mirrors Dockerfile CMD):
    uv run uvicorn agent_py.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Annotated

import structlog
from fastapi import Depends, FastAPI
from pydantic import BaseModel

from . import __version__, db, poller
from .auth import get_current_user
from .settings import Settings, get_settings

logger = structlog.get_logger(__name__)


def create_app(*, enable_poller: bool = True) -> FastAPI:
    """Application factory.

    Kept as a factory (rather than a module-level `app = FastAPI(...)`)
    so tests can spin up an isolated instance per test with overridden
    settings without leaking state across tests.

    `enable_poller` exists for tests that don't want the background
    task interfering with assertions; production callers leave it on.
    """
    settings = get_settings()

    # FastAPI's lifespan takes a callable that returns a context
    # manager. The closure captures `settings` so tests can swap env
    # vars without rebuilding everything.
    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if not enable_poller:
            yield
            return
        await db.init_pool(settings.SUPABASE_DB_URL)
        task: asyncio.Task[int] | None = None
        if settings.SUPABASE_DB_URL:
            task = asyncio.create_task(
                poller.run_poll_loop(settings),
                name="agent-py.poller",
            )
            logger.info(
                "lifespan.poller.started",
                interval=settings.POLL_INTERVAL_SECONDS,
                dry_run=settings.WORKER_DRY_RUN,
            )
        else:
            logger.info("lifespan.poller.skipped", reason="no_supabase_db_url")
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await db.close_pool()
            logger.info("lifespan.shutdown.complete")

    app = FastAPI(
        title="Hummingbird Agent Service",
        version=__version__,
        description=(
            "Phase 1: health + auth endpoints + a read-only task_jobs poll "
            "loop. See docs/PLAN-agent-api.md for the full phased plan."
        ),
        # /openapi.json is the source of truth for `openapi-typescript`
        # codegen on the Next.js side (see scripts/codegen-agent-types.sh).
        openapi_url="/openapi.json",
        lifespan=lifespan,
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

        Phase 0 only reported config presence; Phase 1 additionally
        reports whether the Postgres pool is open (which is the closest
        we get to "Postgres reachable" without a per-request `SELECT 1`).
        Phase 2+ may add a `SELECT 1` if we see false-positive ready.
        """
        return ReadinessResponse(
            status="ok",
            checks=ReadinessChecks(
                supabase_url_configured=bool(settings.SUPABASE_URL),
                supabase_db_configured=bool(settings.SUPABASE_DB_URL),
                jwt_secret_configured=bool(settings.SUPABASE_JWT_SECRET),
                db_pool_open=db.has_pool(),
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
    supabase_db_configured: bool
    jwt_secret_configured: bool
    db_pool_open: bool


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
# in Phase 2+).
__all__ = ["Settings", "app", "create_app"]
