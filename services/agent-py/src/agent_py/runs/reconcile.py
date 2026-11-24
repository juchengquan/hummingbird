"""The no-worker reconciler — wave 6, survey bug 17.

A background task nobody executes stays `queued` forever on the runs
path: Next fails it only when its own task stream route is opened
(`reconcileStaleRuns` in `lib/server/agent/store.ts`). This is that
rule's "never started" case, run by agent-py for every user:

* a background run (`mode = 'background'`, a task's root, a resume or a
  sub-agent run alike) still `queued`,
* with nothing in its log past the `status: queued` entry (seq 1: a
  worker's first entry is seq 2),
* created more than `TASK_NO_WORKER_TIMEOUT_MINUTES` ago,
* whose job no worker holds (no `running` job under an unexpired lease),

is failed with Next's `NO_WORKER_ERROR` — but only when no worker
executed anything in that window (`public.task_worker_active_within`,
migration 0040), probed once per pass: a busy worker's backlog waits.

Each failure is one transaction as the DSN role, in 0045's lock order
(`private.lock_task_scope`, then the row), re-checking every condition
in the update itself, so a worker claiming the job or a cancel landing
meanwhile wins cleanly. It writes what Next's synthetic result writes —
`status = 'failed'`, `finished_at`, a `result` entry after the log's last
— plus the `outcome` (`no_worker`, which users can't write), so reading
the run needs no log scan. The barrier trigger (`tasks_ended`, 0045)
settles a parent waiting on it, and the task no longer counts against
the 5-task cap (0047).

Not ported: Next's "stalled" case (a started run with no recent event
and no live job). agent-py's job leases already hand a dead worker's
job to the next worker (`poller`, lease reclaim).
"""

from __future__ import annotations

import asyncio
import json
import math
import uuid
from datetime import timedelta

import asyncpg
import structlog

from .. import db
from ..settings import Settings

__all__ = ["NO_WORKER_ERROR", "reconcile_no_worker", "run_reconcile_loop"]

logger = structlog.get_logger(__name__)

NO_WORKER_ERROR = (
    "No task worker available: this task was never picked up. Try again later, "
    "or contact the administrator if it keeps happening."
)
"""`NO_WORKER_ERROR` in `lib/server/agent/store.ts`, verbatim."""

LAST_PRE_START_SEQ = 1
"""The route's / `create_run`'s `status: queued` entry; a worker's first
entry is seq 2."""

_NEVER_STARTED = f"""
      t.mode = 'background'
  AND t.status = 'queued'
  AND COALESCE(t.created_at, t.started_at) < now() - make_interval(secs => $1)
  AND NOT EXISTS (SELECT 1 FROM public.task_events e
                   WHERE e.task_id = t.id AND e.seq > {LAST_PRE_START_SEQ})
  AND NOT EXISTS (SELECT 1 FROM public.task_jobs j
                   WHERE j.task_id = t.id AND j.status = 'running'
                     AND j.lease_expires_at > now())
"""

_CANDIDATES_SQL = f"""
SELECT t.id, t.user_id FROM public.tasks t
 WHERE {_NEVER_STARTED}
 ORDER BY t.created_at
 LIMIT $2
"""

_FAIL_SQL = f"""
UPDATE public.tasks t
   SET status = 'failed', outcome = $3::jsonb, finished_at = now(), updated_at = now()
 WHERE t.id = $2 AND {_NEVER_STARTED}
RETURNING t.id
"""

_RESULT_SQL = """
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload)
SELECT $1, $2, COALESCE(MAX(e.seq), 0) + 1, 0, 'result', $3::jsonb
  FROM public.task_events e
 WHERE e.task_id = $1
ON CONFLICT (task_id, seq) DO NOTHING
"""

_OUTCOME = json.dumps({"type": "error", "code": "no_worker", "message": NO_WORKER_ERROR})
_RESULT = json.dumps({"status": "failed", "error": NO_WORKER_ERROR, "errorCode": "no_worker"})


async def reconcile_no_worker(
    pool: asyncpg.Pool, *, timeout: timedelta, limit: int = 100
) -> list[str]:
    """One pass: fail the background runs no worker picked up within
    `timeout` (see the module docstring). Returns their ids, oldest
    first."""
    seconds = max(timeout.total_seconds(), 0.0)
    async with pool.acquire() as conn:
        candidates = await conn.fetch(_CANDIDATES_SQL, seconds, limit)
        if not candidates:
            return []
        active = await conn.fetchval(
            "SELECT public.task_worker_active_within($1)", math.ceil(seconds)
        )
    if active:
        return []
    failed: list[str] = []
    for row in candidates:
        task: uuid.UUID = row["id"]
        user: uuid.UUID = row["user_id"]
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("SELECT private.lock_task_scope($1, $2)", user, task)
            if await conn.fetchval(_FAIL_SQL, seconds, task, _OUTCOME) is None:
                continue  # a worker, a cancel or another replica got there first
            await conn.execute(_RESULT_SQL, task, user, _RESULT)
        failed.append(str(task))
        logger.info("runs.reconcile.no_worker", run_id=str(task), user_id=str(user))
    return failed


async def run_reconcile_loop(settings: Settings, *, stop: asyncio.Event) -> None:
    """Every `RUNS_RECONCILE_INTERVAL_SECONDS` until `stop` is set: one
    pass on the process's pool. A failed pass is logged and retried at
    the next tick."""
    timeout = timedelta(minutes=settings.TASK_NO_WORKER_TIMEOUT_MINUTES)
    interval = max(settings.RUNS_RECONCILE_INTERVAL_SECONDS, 0.05)
    while not stop.is_set():
        try:
            if db.has_pool():
                await reconcile_no_worker(db.get_pool(), timeout=timeout)
        except Exception as exc:  # pragma: no cover — logged, retried next tick
            logger.warning("runs.reconcile.failed", error=str(exc))
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue
