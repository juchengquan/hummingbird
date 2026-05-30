"""Task-job queue operations.

Python port of the claim half of `lib/server/agent/jobs.ts`. Phase 1
of PLAN-agent-api: claim and release only. No execute. No event
writes. The TS worker remains canonical.

The SQL uses `FOR UPDATE SKIP LOCKED` — cleaner than the TS
two-step select-then-guarded-update because we have direct Postgres
access (the TS path goes through PostgREST, which doesn't expose
`SKIP LOCKED`). Race semantics: two workers polling concurrently
never claim the same row; the loser's claim returns `None`.

The `release_job_to_queue` helper is unique to Phase 1's dry-run
mode — it puts a claimed job back so the TS worker can pick it up.
Phase 2 deletes the release path; once Python actually executes, a
claimed job either completes (`mark_job_done`) or fails
(`mark_job_failed`), it doesn't get returned to the queue.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

import asyncpg


@dataclass(frozen=True)
class ClaimedJob:
    """Mirror of TS `ClaimedJob` in lib/server/agent/jobs.ts.

    Field shapes match the TS interface verbatim so logs from both
    workers are directly comparable.
    """

    id: str
    task_id: str
    user_id: str
    action: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int


# --- SQL --------------------------------------------------------------------
#
# Single-statement claim: lock the next ready row, mark it running,
# return it. The `task_jobs_ready_idx` partial index on
# `(scheduled_at) WHERE status = 'queued'` makes the inner SELECT
# O(log N). FOR UPDATE SKIP LOCKED is what makes concurrent polling
# safe — two workers each grab a different row, or one gets nothing.
#
# `attempts` is bumped here, matching the TS behaviour. The Phase 1
# dry-run path then immediately calls `release_job_to_queue`, which
# undoes the running→queued flip BUT keeps the bumped `attempts` so
# stuck loops still surface via `attempts >= max_attempts`. This is
# deliberate (not a bug) — if the Python claim path is somehow
# misbehaving, the run-count tells us.

_CLAIM_SQL = """
WITH next_job AS (
    SELECT id
    FROM public.task_jobs
    WHERE status = 'queued'
      AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE public.task_jobs t
SET status = 'running',
    started_at = now(),
    attempts = t.attempts + 1,
    updated_at = now()
FROM next_job
WHERE t.id = next_job.id
RETURNING t.id,
          t.task_id,
          t.user_id,
          t.action,
          t.payload,
          t.attempts,
          t.max_attempts;
"""

# Release a job claimed in dry-run mode back to the ready set. Resets
# `started_at` so the TS worker treats it as a fresh queued job.
# `attempts` stays bumped on purpose (see above).
_RELEASE_SQL = """
UPDATE public.task_jobs
SET status = 'queued',
    started_at = NULL,
    updated_at = now()
WHERE id = $1
  AND status = 'running';
"""


async def claim_next_job(pool: asyncpg.Pool) -> ClaimedJob | None:
    """Atomically claim the next ready job; return `None` when the
    queue is empty or every candidate is held by another worker.

    Caller must connect with a role that can bypass RLS on
    `task_jobs` (Supabase service-role, or a worker-owned role).
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_CLAIM_SQL)
    if row is None:
        return None
    return _row_to_claimed(row)


async def release_job_to_queue(pool: asyncpg.Pool, job_id: str) -> bool:
    """Put a claimed job back. Returns True if a row was actually
    flipped (someone else may have completed it in the meantime,
    in which case the predicate excludes it).
    """
    async with pool.acquire() as conn:
        result = await conn.execute(_RELEASE_SQL, _coerce_uuid(job_id))
    # asyncpg returns "UPDATE <n>"; parse the trailing count.
    parts = result.split()
    return len(parts) == 2 and parts[0] == "UPDATE" and parts[1] != "0"


_MARK_DONE_SQL = """
UPDATE public.task_jobs
SET status = 'done',
    finished_at = now(),
    updated_at = now()
WHERE id = $1;
"""


async def mark_job_done(pool: asyncpg.Pool, job_id: str) -> None:
    """Settle a job as completed. Phase 2a calls this after the
    executor returns successfully — the task row's terminal status
    is set separately by the executor via `store.update_run`."""
    async with pool.acquire() as conn:
        await conn.execute(_MARK_DONE_SQL, _coerce_uuid(job_id))


_MARK_FAILED_SQL = """
UPDATE public.task_jobs
SET status = 'failed',
    finished_at = now(),
    error = jsonb_build_object('message', $2::text),
    updated_at = now()
WHERE id = $1;
"""


async def mark_job_failed(
    pool: asyncpg.Pool,
    job_id: str,
    *,
    error: str,
) -> None:
    """Mark a job as failed terminally. Phase 2a calls this when the
    executor returns an error outcome. The TS path uses retryable
    backoff via `markJobFailed`; Phase 2a defers that to keep the
    executor's failure semantics simple — a failure here is
    terminal until Phase 3 wires the retry logic."""
    async with pool.acquire() as conn:
        await conn.execute(_MARK_FAILED_SQL, _coerce_uuid(job_id), error)


def _row_to_claimed(row: asyncpg.Record) -> ClaimedJob:
    payload = row["payload"]
    # asyncpg returns jsonb as a string by default unless a codec is
    # registered; cover both cases so this stays resilient to future
    # pool config changes.
    if isinstance(payload, str):
        payload = json.loads(payload)
    return ClaimedJob(
        id=str(row["id"]),
        task_id=str(row["task_id"]),
        user_id=str(row["user_id"]),
        action=row["action"],
        payload=payload if isinstance(payload, dict) else {},
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
    )


def _coerce_uuid(value: str) -> uuid.UUID:
    """asyncpg's UUID parameter binder wants `uuid.UUID`. Accept a
    string for ergonomics (the loop passes IDs around as strings)."""
    return uuid.UUID(value)
