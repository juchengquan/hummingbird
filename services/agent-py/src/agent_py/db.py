"""Postgres connection lifecycle.

Phase 1 of PLAN-agent-api: a direct asyncpg pool against Supabase's
Postgres. Direct connection (not the transaction pooler) is required —
`FOR UPDATE SKIP LOCKED` needs an open transaction, which the pooler
mode `transaction` doesn't expose. The connection string lives in
`SUPABASE_DB_URL`.

Pool lifecycle:
  - `init_pool(dsn)` creates the singleton at FastAPI startup.
  - `get_pool()` returns it from request paths / the poll loop.
  - `close_pool()` runs on shutdown.

A `None` DSN at init time leaves the pool unset (`get_pool()` raises);
this lets the service boot in environments that don't have a Postgres
yet (e.g. local dev without `SUPABASE_DB_URL` set), while still being
able to serve `/healthz` and `/readyz`.
"""

from __future__ import annotations

import asyncpg
import structlog

logger = structlog.get_logger(__name__)

# Module-level singleton. `init_pool` sets it; `close_pool` clears it.
_pool: asyncpg.Pool | None = None


async def init_pool(dsn: str | None, *, min_size: int = 1, max_size: int = 4) -> None:
    """Open the Postgres connection pool.

    Idempotent — calling twice is a no-op (used by tests that
    `create_app()` repeatedly). Min-size 1 so the worker always has a
    connection ready; max-size 4 leaves room for occasional bursts
    without overwhelming a single-instance worker.

    If `dsn` is empty / None, the pool stays unset and the worker
    won't start polling. Useful for local dev where Postgres isn't
    configured but `/healthz` should still respond.
    """
    global _pool
    if _pool is not None:
        return
    if not dsn:
        logger.info("db.init_pool.skipped", reason="no_dsn")
        return
    _pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=min_size,
        max_size=max_size,
        # Worker queries are short. Long-held connections are a smell;
        # surface them as timeouts so they show up in logs.
        command_timeout=30.0,
    )
    logger.info("db.init_pool.opened", min_size=min_size, max_size=max_size)


async def close_pool() -> None:
    """Close the pool. Idempotent."""
    global _pool
    if _pool is None:
        return
    await _pool.close()
    _pool = None
    logger.info("db.close_pool.closed")


def get_pool() -> asyncpg.Pool:
    """Return the open pool or raise. Call sites that can run before
    init (e.g. tests that import the module without lifespan) should
    handle the `RuntimeError`; the production paths always run after
    `init_pool`."""
    if _pool is None:
        raise RuntimeError("DB pool not initialised — call init_pool() during app startup.")
    return _pool


def has_pool() -> bool:
    """Probe without raising. Used by the poller to decide whether to
    bother polling and by `/readyz` to report DB readiness."""
    return _pool is not None
