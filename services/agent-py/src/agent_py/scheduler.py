"""The schedule dispatcher loop — agent-py's replacement for the Vercel
Cron that calls `/api/tasks/jobs/tick` every minute
(docs/PLAN-frontend-backend-split.md, Q9).

Started from FastAPI's lifespan next to the job poller when
`SCHEDULER_ENABLED` is true (and `SUPABASE_DB_URL` is set). Every
`SCHEDULER_INTERVAL_SECONDS` it runs one `schedules.dispatch_due_schedules`
pass, which fires due `task_schedules` rows exactly like the TS tick.

Running it at the same time as the Vercel Cron — or on several replicas —
is safe: every fire is preceded by a guarded update
(`… WHERE next_run_at = <the value read>`), and under Postgres' row lock
only the first dispatcher's update matches; the others touch nothing and
skip the row. So the switch-over is: enable this, watch it fire, then
remove the cron from `vercel.json`.

Like the poller, the loop survives transient errors (a failed tick is
logged and retried next interval), only a real `task.cancel()` stops it,
and on shutdown the `stop` event lets the current tick finish (the
lifespan cancels it after `SHUTDOWN_GRACE_SECONDS`). `/readyz` reports its
liveness (`scheduler_alive`, `scheduler_last_tick_age_seconds`).
"""

from __future__ import annotations

import asyncio
import dataclasses
import time

import structlog

from . import db, schedules
from .poller import SleepFn, _cancel_requested, _default_sleep, _sleep_unless_stopped
from .settings import Settings

logger = structlog.get_logger(__name__)


async def tick() -> int:
    """One dispatcher pass. No pool → nothing to do (returns 0)."""
    if not db.has_pool():
        return 0
    fired = await schedules.dispatch_due_schedules(schedules.PgScheduleStore(db.get_pool()))
    if fired:
        logger.info("scheduler.fired", count=fired)
    return fired


async def run_scheduler_loop(
    settings: Settings,
    *,
    sleep: SleepFn = _default_sleep,
    stop_after_iterations: int | None = None,
    stop: asyncio.Event | None = None,
) -> int:
    """Tick until cancelled or `stop` is set; returns the iterations run
    (`stop_after_iterations` is for tests)."""
    interval = settings.SCHEDULER_INTERVAL_SECONDS
    iterations = 0
    while stop is None or not stop.is_set():
        try:
            await tick()
        except asyncio.CancelledError as exc:
            if _cancel_requested():
                logger.info("scheduler.cancelled", iterations=iterations)
                raise
            logger.error("scheduler.stray_cancelled_error", error=str(exc))
        except Exception as exc:
            # Transient DB trouble must not kill the loop: log, retry later.
            logger.error("scheduler.tick.failed", error=str(exc))
        _liveness.last_tick_at = time.monotonic()

        iterations += 1
        if stop_after_iterations is not None and iterations >= stop_after_iterations:
            return iterations
        try:
            await _sleep_unless_stopped(sleep, interval, stop)
        except asyncio.CancelledError:
            if _cancel_requested():
                logger.info("scheduler.cancelled", iterations=iterations)
                raise
            logger.error("scheduler.stray_cancelled_error", where="sleep")
    logger.info("scheduler.stopped", iterations=iterations)
    return iterations


@dataclasses.dataclass
class _Liveness:
    task: asyncio.Task[int] | None = None
    last_tick_at: float | None = None


_liveness = _Liveness()


def register_loop_task(task: asyncio.Task[int] | None) -> None:
    """Record the running loop task (`main.py`) for `/readyz`."""
    _liveness.task = task
    _liveness.last_tick_at = None


def liveness() -> tuple[bool | None, float | None]:
    """`(alive, seconds since the last finished tick)`; `alive` is None
    when no loop was started (disabled, or no `SUPABASE_DB_URL`)."""
    task = _liveness.task
    alive = None if task is None else not task.done()
    last = _liveness.last_tick_at
    return alive, (None if last is None else max(0.0, time.monotonic() - last))
