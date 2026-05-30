"""The Phase 1 read-only poll loop.

Runs as a background asyncio task started from FastAPI's lifespan.
On each tick:
  1. Try to claim the next ready job (`jobs.claim_next_job`).
  2. If a job was claimed, structured-log the claim.
  3. **Release it immediately** so the TS worker picks it up.

That's the whole job. No checkpoint reads, no event writes, no tool
execution. The point is to prove connectivity + RLS + the claim
contract without touching production work paths.

When `WORKER_DRY_RUN` is False (Phase 2+), the poller stops releasing
— the loop will hand off to the executor instead. Today's code path
keeps the release unconditional; a future PR adds the dispatch
branch.

Stopping:
  - The loop runs until the asyncio task is cancelled.
  - `main.py`'s lifespan calls `task.cancel()` on shutdown.
  - Cancellation is observed inside `asyncio.sleep` so a slow tick
    can't delay shutdown by more than the configured interval.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import structlog

from . import db, jobs
from .settings import Settings

logger = structlog.get_logger(__name__)

# Sleep is parameterised so tests can inject a fake clock without
# touching asyncio internals.
SleepFn = Callable[[float], Awaitable[None]]


async def _default_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


async def run_poll_loop(
    settings: Settings,
    *,
    sleep: SleepFn = _default_sleep,
    stop_after_iterations: int | None = None,
) -> int:
    """Drive the dry-run poll loop until cancelled.

    `stop_after_iterations` exists only for tests — production calls
    leave it `None` so the loop runs forever. Returns the number of
    iterations completed (useful for the tests' invariants).

    Steady-state behaviour:
      - No DB pool → tick is a no-op, just sleep. Lets the service
        boot in dev without `SUPABASE_DB_URL`.
      - Pool present, no job → log nothing (a job-empty log every
        tick would be noisy), sleep.
      - Job claimed → log + release.
      - Claim raises → log error, sleep. We don't crash the loop on
        a transient error; the TS worker stays canonical.
    """
    interval = settings.POLL_INTERVAL_SECONDS
    iterations = 0

    while True:
        try:
            await _tick(settings)
        except asyncio.CancelledError:
            logger.info("poller.cancelled", iterations=iterations)
            raise
        except Exception as exc:
            # Loop must survive transient errors. Log with the
            # exception payload so monitoring catches it; sleep, retry.
            logger.error("poller.tick.failed", error=str(exc))

        iterations += 1
        if stop_after_iterations is not None and iterations >= stop_after_iterations:
            return iterations

        try:
            await sleep(interval)
        except asyncio.CancelledError:
            logger.info("poller.cancelled", iterations=iterations)
            raise


async def _tick(settings: Settings) -> None:
    """One poll iteration. Extracted so tests can drive it directly
    without juggling sleep timing."""
    if not db.has_pool():
        # Boot mode — no Postgres configured. The lifespan still
        # started us so the rest of the app stays consistent, but
        # there's nothing to poll.
        return

    pool = db.get_pool()
    job = await jobs.claim_next_job(pool)
    if job is None:
        return

    # Phase 1 contract: log every claim. The shape mirrors the TS
    # worker's structured logs so dashboards can union them.
    logger.info(
        "poller.claimed",
        job_id=job.id,
        task_id=job.task_id,
        user_id=job.user_id,
        action=job.action,
        attempts=job.attempts,
        payload_keys=sorted(job.payload.keys()) if job.payload else [],
    )

    if settings.WORKER_DRY_RUN:
        released = await jobs.release_job_to_queue(pool, job.id)
        logger.info(
            "poller.released",
            job_id=job.id,
            released=released,
            reason="dry_run",
        )
        return

    # Phase 2 lands the execute branch here. For now, a non-dry-run
    # claim is a misconfiguration — log loudly and release anyway
    # so we don't accidentally swallow work.
    logger.error(
        "poller.dry_run_disabled_but_no_executor",
        job_id=job.id,
        hint="Set WORKER_DRY_RUN=true until Phase 2 lands.",
    )
    await jobs.release_job_to_queue(pool, job.id)
