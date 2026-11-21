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
import os
import signal
from collections.abc import AsyncIterator, Callable
from types import FrameType

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__, db, poller
from .body_limit import BodySizeLimitMiddleware, body_limit_for
from .model_allowlist import get_model_allowlist
from .routers import (
    chat,
    csp_report,
    embed,
    extract,
    extract_table,
    files,
    health,
    images,
    mcp,
    memory,
    summarize,
    url,
    whoami,
)

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


_SignalHandler = Callable[[int, FrameType | None], object] | int | signal.Handlers | None


def install_shutdown_signal_hook(begin_shutdown: Callable[[], None]) -> Callable[[], None]:
    """Start the poller's graceful stop the moment SIGTERM / SIGINT
    arrives, then let the server's own handler run.

    Without this the stop waits for the lifespan's shutdown half, which
    uvicorn only runs after every open connection closed — a long-lived
    SSE stream (/v1/chat) holds it past the container's stop timeout, so
    the in-flight job was never handed back and its attempt burned on a
    lapsed lease. The hook chains the handlers installed before it (the
    server's), runs `begin_shutdown` on the event loop, and returns a
    function that restores them. A no-op off the main thread (signal
    handlers can only be set there — e.g. tests' in-thread lifespans)."""
    loop = asyncio.get_running_loop()
    previous: dict[int, _SignalHandler] = {}

    def handler(signum: int, frame: FrameType | None) -> None:
        loop.call_soon_threadsafe(begin_shutdown)
        prev = previous.get(signum)
        if callable(prev):
            prev(signum, frame)
        elif prev == signal.SIG_DFL:
            # Nothing chained (no server handler): keep the default
            # behaviour — terminate.
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            previous[sig] = signal.getsignal(sig)
            signal.signal(sig, handler)
        except (ValueError, OSError):
            previous.pop(sig, None)

    def restore() -> None:
        for sig, prev in previous.items():
            with contextlib.suppress(ValueError, OSError, TypeError):
                if signal.getsignal(sig) is handler:
                    signal.signal(sig, prev)

    return restore


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
        stopping: asyncio.Task[None] | None = None
        restore_signals: Callable[[], None] | None = None

        def begin_shutdown() -> None:
            # Idempotent: the signal hook and the lifespan both call it.
            nonlocal stopping
            if task is not None and stopping is None:
                logger.info("lifespan.poller.stopping")
                stopping = asyncio.create_task(
                    stop_poller(task, stop, grace_s=settings.SHUTDOWN_GRACE_SECONDS),
                    name="agent-py.poller.stop",
                )

        if settings.SUPABASE_DB_URL:
            task = asyncio.create_task(
                poller.run_poll_loop(settings, stop=stop),
                name="agent-py.poller",
            )
            poller.register_loop_task(task)
            restore_signals = install_shutdown_signal_hook(begin_shutdown)
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
            if restore_signals is not None:
                restore_signals()
            begin_shutdown()
            if stopping is not None:
                # The pool must stay open until the in-flight job is
                # settled or handed back.
                await stopping
            poller.register_loop_task(None)
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
    app.include_router(files.router)
    app.include_router(extract_table.router)
    app.include_router(summarize.router)
    app.include_router(mcp.router)
    app.include_router(embed.router)
    app.include_router(memory.router)
    app.include_router(csp_report.router)

    # Cap request bodies before routing / auth: FastAPI reads (and
    # spools multipart parts of) the body before the auth dependency
    # runs, so this is what bounds an unauthenticated upload.
    app.add_middleware(BodySizeLimitMiddleware, limit_for=body_limit_for(settings))

    # Opt-in CORS for a frontend on a different origin (e.g. Next on :3000
    # calling agent-py on :8000). Without it the browser's preflight for a
    # bearer-authenticated request gets a 405 and every call fails. Added
    # last so it is the outermost middleware and answers preflights before
    # the body limit or routing see them.
    cors_origins = cors_allowed_origins(settings)
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["authorization", "content-type", "last-event-id"],
            max_age=600,
        )

    return app


def cors_allowed_origins(settings: Settings) -> list[str]:
    """Exact origins from `CORS_ALLOWED_ORIGINS`; a `*` or anything that is
    not a bare scheme://host[:port] origin is dropped (and logged) rather
    than widening access."""
    out: list[str] = []
    for raw in settings.CORS_ALLOWED_ORIGINS.split(","):
        origin = raw.strip().rstrip("/")
        if not origin:
            continue
        scheme, sep, rest = origin.partition("://")
        if origin == "*" or not sep or scheme not in ("http", "https") or not rest or "/" in rest:
            logger.warning("cors.origin_ignored", origin=origin)
            continue
        out.append(origin)
    return out


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
