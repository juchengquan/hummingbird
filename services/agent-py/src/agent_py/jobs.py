"""Task-job queue operations.

Python port of the claim half of `lib/server/agent/jobs.ts`.

The SQL uses `FOR UPDATE SKIP LOCKED` — cleaner than the TS
two-step select-then-guarded-update because we have direct Postgres
access (the TS path goes through PostgREST, which doesn't expose
`SKIP LOCKED`). Race semantics: two workers polling concurrently
never claim the same row; the loser's claim returns `None`.

`release_job_to_queue` hands a claimed job back unexecuted (dry-run,
unflagged user, unsupported action). A job Python executes settles via
`mark_job_done` / `mark_job_failed`.

Lease (migration 0032): the claim stamps `lease_expires_at = now() +
lease`; the poller heartbeats it forward (`extend_lease`) while the job
runs; settle / release clear it. A `running` row whose lease has passed
belongs to a dead worker: the claim reclaims it while `attempts <
max_attempts` (flagging `ClaimedJob.reclaimed` so the poller can decide
how to resume), and `reap_expired_jobs` fails it once the budget is
spent. `hand_back_job` is the graceful-shutdown variant of release: it
expires the lease immediately (refunding the attempt) so the next claim
reclaims the job as interrupted.

Fencing: every claim bumps `attempts`, so `attempts` doubles as the
claim's fencing token. Heartbeat / settle / hand-back pass the value
they claimed with; a stale worker whose job was reclaimed underneath it
matches no row instead of extending or settling the new owner's claim.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

import asyncpg


@dataclass(frozen=True)
class ClaimedJob:
    """Mirror of TS `ClaimedJob` in services/agent-ts/src/jobs.ts.

    Field shapes match the TS interface so logs from both workers are
    directly comparable.
    """

    id: str
    task_id: str
    user_id: str
    action: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int
    # True when this claim took over a `running` row whose lease had
    # expired (its previous worker died mid-run, or handed it back on
    # shutdown), as opposed to a fresh `queued` row. The poller checks
    # the task's state before re-executing such a job — see
    # `poller.reclaim_decision`.
    reclaimed: bool = False


# Default lease for a claim, in seconds. Settings override it
# (`JOB_LEASE_SECONDS`); the default here keeps direct callers (tests,
# scripts) on the same contract.
DEFAULT_LEASE_SECONDS = 120.0


# --- SQL --------------------------------------------------------------------
#
# Single-statement claim: lock the next ready row, mark it running,
# stamp its lease, return it. The `task_jobs_ready_idx` partial index on
# `(scheduled_at) WHERE status = 'queued'` plus `task_jobs_lease_idx` on
# `(lease_expires_at) WHERE status = 'running'` keep the inner SELECT
# cheap. FOR UPDATE SKIP LOCKED is what makes concurrent polling safe —
# two workers each grab a different row, or one gets nothing.
#
# Ready set:
#   - `queued` rows whose `scheduled_at` has arrived, and
#   - when `$2` (reclaim_expired) is true, `running` rows whose lease has
#     expired — their worker died without settling. A NULL lease never
#     matches (`NULL < now()` is not true); 0032 backfilled legacy rows.
# Both only while `attempts < max_attempts`, so a poison row can't be
# re-claimed forever; `reap_expired_jobs` fails the exhausted ones.
#
# `attempts` is bumped here, matching the TS behaviour.
# `release_job_to_queue` undoes the bump (a release is "not mine", not a
# failed attempt — otherwise every unflagged user's job would hit the
# cap after a few polls and be stranded `queued` forever) and pushes
# `scheduled_at` forward; see `_RELEASE_SQL`.

_CLAIM_SQL = """
WITH next_job AS (
    SELECT id, status AS prev_status
    FROM public.task_jobs
    WHERE attempts < max_attempts
      AND (
            (status = 'queued' AND scheduled_at <= now())
         OR ($2::boolean AND status = 'running' AND lease_expires_at < now())
      )
    ORDER BY scheduled_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE public.task_jobs t
SET status = 'running',
    started_at = now(),
    attempts = t.attempts + 1,
    lease_expires_at = now() + $1::double precision * interval '1 second',
    updated_at = now()
FROM next_job
WHERE t.id = next_job.id
RETURNING t.id,
          t.task_id,
          t.user_id,
          t.action,
          t.payload,
          t.attempts,
          t.max_attempts,
          (next_job.prev_status = 'running') AS reclaimed;
"""

# Release a claimed job back to the ready set (dry-run / unflagged
# user / unsupported action). Resets `started_at`, clears the lease and
# undoes the claim's `attempts` bump (mirrors agent-ts's RELEASE_SQL).
#
# Backoff: the claim orders by `scheduled_at`, so leaving it unchanged
# made a released job the head of the queue again on the very next tick
# — the poller hot-looped on it and head-of-line blocked every job
# behind it. Instead push `scheduled_at` to
#   now() + clamp((now() - created_at) / 2, 5 seconds, 5 minutes)
# i.e. wait half the job's current age: the gaps between re-claims
# grow geometrically (~x1.5 per release) without needing a release
# counter, a fresh job is re-offered after 5 s, and nothing waits more
# than 5 min once a worker that can take it appears (e.g. the user's
# flag is flipped). Other ready jobs sort ahead of it meanwhile.
_RELEASE_SQL = """
UPDATE public.task_jobs
SET status = 'queued',
    started_at = NULL,
    lease_expires_at = NULL,
    attempts = GREATEST(attempts - 1, 0),
    scheduled_at = now() + LEAST(
        interval '5 minutes',
        GREATEST(interval '5 seconds', (now() - created_at) / 2)
    ),
    updated_at = now()
WHERE id = $1
  AND status = 'running';
"""


async def claim_next_job(
    pool: asyncpg.Pool,
    *,
    lease_seconds: float = DEFAULT_LEASE_SECONDS,
    reclaim_expired: bool = True,
) -> ClaimedJob | None:
    """Atomically claim the next ready job; return `None` when the
    queue is empty or every candidate is held by another worker.

    `lease_seconds` is how long the claim holds before another worker
    may reclaim it; the executing worker must `extend_lease` well
    within it. `reclaim_expired=False` restricts the claim to `queued`
    rows — the dry-run poller passes it so a passive observer never
    takes over (only to release) a dead worker's job.

    Caller must connect with a role that can bypass RLS on
    `task_jobs` (Supabase service-role, or a worker-owned role).
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_CLAIM_SQL, float(lease_seconds), reclaim_expired)
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
    return _updated_any(result)


# Settle writes. `status = 'running'` keeps a zombie worker from
# flipping a row the reaper already failed; the optional `attempts`
# fence (`$n IS NULL OR attempts = $n`) keeps it from settling a claim a
# newer worker took over after the lease expired.

_MARK_DONE_SQL = """
UPDATE public.task_jobs
SET status = 'done',
    finished_at = now(),
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND ($2::integer IS NULL OR attempts = $2::integer);
"""


async def mark_job_done(
    pool: asyncpg.Pool,
    job_id: str,
    *,
    attempts: int | None = None,
) -> bool:
    """Settle a job as completed. The task row's terminal status is set
    separately by the executor (`settle_task_terminal`). Pass the
    claim's `attempts` to fence against a reclaimed job. Returns True
    iff a row was settled."""
    async with pool.acquire() as conn:
        result = await conn.execute(_MARK_DONE_SQL, _coerce_uuid(job_id), attempts)
    return _updated_any(result)


_MARK_FAILED_SQL = """
UPDATE public.task_jobs
SET status = 'failed',
    finished_at = now(),
    lease_expires_at = NULL,
    error = jsonb_build_object('message', $2::text),
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND ($3::integer IS NULL OR attempts = $3::integer);
"""


async def mark_job_failed(
    pool: asyncpg.Pool,
    job_id: str,
    *,
    error: str,
    attempts: int | None = None,
) -> bool:
    """Mark a job as failed terminally (no retry — the executor has
    already settled the task). Pass the claim's `attempts` to fence
    against a reclaimed job. Returns True iff a row was settled."""
    async with pool.acquire() as conn:
        result = await conn.execute(_MARK_FAILED_SQL, _coerce_uuid(job_id), error, attempts)
    return _updated_any(result)


# --- Lease ------------------------------------------------------------------

_EXTEND_LEASE_SQL = """
UPDATE public.task_jobs
SET lease_expires_at = now() + $3::double precision * interval '1 second',
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND attempts = $2::integer;
"""


async def extend_lease(
    pool: asyncpg.Pool,
    job_id: str,
    *,
    attempts: int,
    lease_seconds: float = DEFAULT_LEASE_SECONDS,
) -> bool:
    """Heartbeat: push this claim's lease to `now() + lease_seconds`.

    Returns False when the claim is no longer ours — the row was
    settled, reaped, or reclaimed by another worker after our lease
    lapsed (its `attempts` moved past ours)."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            _EXTEND_LEASE_SQL, _coerce_uuid(job_id), attempts, float(lease_seconds)
        )
    return _updated_any(result)


# Graceful-shutdown hand-back. The job stays `running` but its lease is
# expired on the spot, so the next live claim reclaims it immediately
# with `reclaimed=True` — the poller then resumes it from the task's
# current state instead of blindly re-running it (a plain release would
# lose the "was mid-run" signal). The attempt is refunded: an operator
# restart is not the job's fault.
_HAND_BACK_SQL = """
UPDATE public.task_jobs
SET lease_expires_at = now() - interval '1 second',
    attempts = GREATEST(attempts - 1, 0),
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND attempts = $2::integer;
"""


async def hand_back_job(pool: asyncpg.Pool, job_id: str, *, attempts: int) -> bool:
    """Give an in-flight job back on shutdown (see `_HAND_BACK_SQL`).
    Returns True iff the row was still our claim."""
    async with pool.acquire() as conn:
        result = await conn.execute(_HAND_BACK_SQL, _coerce_uuid(job_id), attempts)
    return _updated_any(result)


@dataclass(frozen=True)
class ReapedJob:
    """A job `reap_expired_jobs` failed. The caller settles its task."""

    id: str
    task_id: str
    user_id: str
    action: str
    attempts: int


# Expired leases with no attempts left: the job ran `max_attempts` times
# and every worker died (or hung past its lease). Fail it terminally so
# it stops being a candidate; the caller settles the task.
_REAP_EXPIRED_SQL = """
WITH expired AS (
    SELECT id
    FROM public.task_jobs
    WHERE status = 'running'
      AND lease_expires_at < now()
      AND attempts >= max_attempts
    ORDER BY lease_expires_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE public.task_jobs t
SET status = 'failed',
    finished_at = now(),
    lease_expires_at = NULL,
    error = jsonb_build_object(
        'message',
        'worker lease expired after ' || t.attempts || ' attempt(s); giving up'
    ),
    updated_at = now()
FROM expired
WHERE t.id = expired.id
RETURNING t.id, t.task_id, t.user_id, t.action, t.attempts;
"""


async def reap_expired_jobs(pool: asyncpg.Pool, *, limit: int = 10) -> list[ReapedJob]:
    """Fail up to `limit` expired, attempt-exhausted jobs. Returns them
    so the caller can settle each one's task
    (`executor.settle_stranded_task`)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(_REAP_EXPIRED_SQL, limit)
    return [
        ReapedJob(
            id=str(row["id"]),
            task_id=str(row["task_id"]),
            user_id=str(row["user_id"]),
            action=str(row["action"]),
            attempts=int(row["attempts"]),
        )
        for row in rows
    ]


@dataclass(frozen=True)
class JobTaskState:
    """The task a job drives, as seen when deciding whether to (re)run
    the job or settle the task. See `load_job_task_state`."""

    task_status: str
    step: int
    pending_children: int
    # `tasks.checkpoint` carries `awaiting_children` — the run is a
    # parent paused on its subagents (fan-in pending).
    awaiting_children: bool
    # Another job for the same task is queued (and claimable) or holds
    # an unexpired lease — something else will still drive the task.
    has_other_live_job: bool
    # A job for the same task was enqueued after this one — the run has
    # moved past it (its yield enqueued a `continue`, a pause got a
    # `respond`, …).
    superseded: bool


_JOB_TASK_STATE_SQL = """
SELECT t.status,
       t.step,
       t.pending_children,
       COALESCE(t.checkpoint ? 'awaiting_children', false) AS awaiting_children,
       EXISTS (
           SELECT 1 FROM public.task_jobs j
           WHERE j.task_id = t.id
             AND j.id IS DISTINCT FROM $3::uuid
             AND (
                    (j.status = 'queued' AND j.attempts < j.max_attempts)
                 OR (j.status = 'running' AND j.lease_expires_at > now())
             )
       ) AS has_other_live_job,
       EXISTS (
           SELECT 1
           FROM public.task_jobs self
           JOIN public.task_jobs later
             ON later.task_id = self.task_id
            AND later.id <> self.id
            AND later.created_at > self.created_at
           WHERE self.id = $3::uuid
       ) AS superseded
FROM public.tasks t
WHERE t.id = $1 AND t.user_id = $2;
"""


async def load_job_task_state(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    job_id: str | None,
) -> JobTaskState | None:
    """Read the task's status plus job liveness around `job_id` (which
    is excluded from `has_other_live_job`). `None` when the task isn't
    found for `user_id`."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            _JOB_TASK_STATE_SQL,
            _coerce_uuid(task_id),
            _coerce_uuid(user_id),
            _coerce_uuid(job_id) if job_id else None,
        )
    if row is None:
        return None
    return JobTaskState(
        task_status=str(row["status"]),
        step=int(row["step"] or 0),
        pending_children=int(row["pending_children"] or 0),
        awaiting_children=bool(row["awaiting_children"]),
        has_other_live_job=bool(row["has_other_live_job"]),
        superseded=bool(row["superseded"]),
    )


ENQUEUE_CONTINUE_SQL = """
INSERT INTO public.task_jobs (task_id, user_id, action, payload, status, scheduled_at)
VALUES ($1, $2, $3, $4::jsonb, 'queued', now());
"""


async def enqueue_continue_job(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
) -> None:
    """Insert a `continue` job. Phase 3a calls this on the chunk-break
    path — the executor saved a checkpoint, now the worker (Python OR
    TS, whichever wins the next claim) picks up from there. Payload is
    empty: `continue` reads everything from `tasks.checkpoint`."""
    async with pool.acquire() as conn:
        await conn.execute(
            ENQUEUE_CONTINUE_SQL,
            _coerce_uuid(task_id),
            _coerce_uuid(user_id),
            "continue",
            json.dumps({}),
        )


async def enqueue_start_job(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
) -> None:
    """Insert a `start` job for a (child) task. Payload empty — `start`
    reads everything from `tasks.checkpoint`."""
    async with pool.acquire() as conn:
        await conn.execute(
            ENQUEUE_CONTINUE_SQL,
            _coerce_uuid(task_id),
            _coerce_uuid(user_id),
            "start",
            json.dumps({}),
        )


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
        reclaimed=bool(row.get("reclaimed")),
    )


def _updated_any(result: object) -> bool:
    """asyncpg's `execute` returns "UPDATE <n>"; True iff n > 0."""
    parts = result.split() if isinstance(result, str) else []
    return len(parts) == 2 and parts[0] == "UPDATE" and parts[1] != "0"


def _coerce_uuid(value: str) -> uuid.UUID:
    """asyncpg's UUID parameter binder wants `uuid.UUID`. Accept a
    string for ergonomics (the loop passes IDs around as strings)."""
    return uuid.UUID(value)
