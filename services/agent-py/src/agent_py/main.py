"""FastAPI application entry point.

Composes the per-domain routers under `agent_py.routers.*` into a
single app, owns the lifespan (DB pool + task-jobs poller), and
re-exports a few internal symbols that test files still import via
`from agent_py.main import ...`.

Run locally:
    uv run uvicorn agent_py.main:app --reload --port 8000

Run in production (mirrors Dockerfile CMD):
    uv run uvicorn agent_py.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

import structlog
from fastapi import FastAPI

from . import __version__, db, poller
from .body_limit import BodySizeLimitMiddleware, body_limit_for
from .model_allowlist import get_model_allowlist
from .routers import chat, extract, health, images, mcp, summarize, url, whoami

# Re-exports for symbols that tests + other callers still import
# directly from `agent_py.main`. The endpoints + their models now
# live in the per-domain routers, but the indirection here avoids
# touching test imports.
from .routers.chat import ChatRequest, _collect_skill_configs
from .routers.health import HealthResponse, ReadinessChecks, ReadinessResponse
from .routers.mcp import _decode_mcp_credential_header
from .settings import Settings, get_settings

logger = structlog.get_logger(__name__)


async def stop_poller(task: asyncio.Task[int], stop: asyncio.Event, *, grace_s: float) -> None:
    """Graceful poller shutdown: ask the loop to stop after its current
    tick, give an in-flight job up to `grace_s` to finish in place, then
    cancel — the poller hands a cancelled job back to the queue (lease
    expired on the spot) so the next worker resumes it. The DB pool must
    still be open while this runs."""
    stop.set()
    done, _ = await asyncio.wait({task}, timeout=max(0.0, grace_s))
    if not done:
        logger.warning("lifespan.poller.grace_expired", grace_s=grace_s)
        task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


def create_app(*, enable_poller: bool = True) -> FastAPI:
    """Application factory.

    Kept as a factory (rather than a module-level `app = FastAPI(...)`)
    so tests can spin up an isolated instance per test with overridden
    settings without leaking state across tests.

    `enable_poller` exists for tests that don't want the background
    task interfering with assertions; production callers leave it on.
    """
    settings = get_settings()

    # Fail fast: load `config/models.json` + check `AGENT_DEFAULT_MODEL`
    # is on the anthropic/* allowlist now, not on the first request.
    # Raises `ModelConfigError`, which aborts `uvicorn agent_py.main:app`.
    # (No log line here: structlog writes to stdout, and the OpenAPI
    # codegen script reads this module's stdout as the schema.)
    get_model_allowlist()

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
        stop = asyncio.Event()
        if settings.SUPABASE_DB_URL:
            task = asyncio.create_task(
                poller.run_poll_loop(settings, stop=stop),
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
                await stop_poller(task, stop, grace_s=settings.SHUTDOWN_GRACE_SECONDS)
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

    # Order is documentation-only — routers don't share path prefixes.
    app.include_router(health.router)
    app.include_router(whoami.router)
    app.include_router(extract.router)
    app.include_router(chat.router)
    app.include_router(url.router)
    app.include_router(images.router)
    app.include_router(summarize.router)
    app.include_router(mcp.router)

    # Cap request bodies before routing / auth: FastAPI reads (and
    # spools multipart parts of) the body before the auth dependency
    # runs, so this is what bounds an unauthenticated upload.
    app.add_middleware(BodySizeLimitMiddleware, limit_for=body_limit_for(settings))

    return app


# Module-level app for `uvicorn agent_py.main:app`. Tests use `create_app()`
# directly so they get a fresh instance.
app = create_app()


# Re-exports for typed Depends() in callers (mostly tests today; route handlers
# in Phase 2+).
__all__ = [
    "ChatRequest",
    "HealthResponse",
    "ReadinessChecks",
    "ReadinessResponse",
    "Settings",
    "_collect_skill_configs",
    "_decode_mcp_credential_header",
    "app",
    "create_app",
]
