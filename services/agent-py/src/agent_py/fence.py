"""DB-side lease fencing for the executor's run-state writes.

`lease.check_current()` before a write only proves the lease was held
when the check ran. Between it and the statement landing, a worker can
wait on the pool (max 4 connections) or on a slow statement — long
enough for its lease to lapse and another worker to reclaim the job, so
the stale write lands on the new owner's run.

`fenced_connection(pool)` closes that gap for every write the executor
makes while a lease is bound:

  1. the acquire is bounded (`ACQUIRE_TIMEOUT_S`) — a starved pool fails
     the write instead of parking it indefinitely;
  2. the lease is re-checked AFTER the acquire;
  3. when the lease carries its fencing token (`JobLease.attempts`, the
     claim's `task_jobs.attempts`), the write runs in a transaction that
     first takes `FOR SHARE` on the job row — still `running` at our
     `attempts`. A reclaim (`UPDATE … attempts = attempts + 1`) blocks
     on that lock until the write commits, so it can never interleave;
     a claim that is already gone matches no row → `LeaseLostError`.

Outside a bound lease (HTTP routes, the reaper, tests) it is a plain
bounded acquire.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg

from . import lease

# Upper bound on waiting for a pooled connection.
ACQUIRE_TIMEOUT_S = 10.0

_FENCE_SQL = """
SELECT 1 FROM public.task_jobs
WHERE id = $1 AND attempts = $2 AND status = 'running'
FOR SHARE;
"""


@asynccontextmanager
async def fenced_connection(pool: asyncpg.Pool) -> AsyncIterator[asyncpg.Connection]:
    """Acquire a connection for a run-state write, fenced on the bound
    job lease (see the module docstring). Raises `LeaseLostError` when
    the claim is gone."""
    job_lease = lease.current()
    async with pool.acquire(timeout=ACQUIRE_TIMEOUT_S) as conn:
        if job_lease is None:
            yield conn
            return
        job_lease.check()
        if job_lease.attempts is None:
            yield conn
            return
        async with conn.transaction():
            row = await conn.fetchrow(_FENCE_SQL, uuid.UUID(job_lease.job_id), job_lease.attempts)
            if row is None:
                job_lease.mark_lost("db_fence_claim_gone")
                raise lease.LeaseLostError(job_lease.job_id, "db_fence_claim_gone")
            yield conn
