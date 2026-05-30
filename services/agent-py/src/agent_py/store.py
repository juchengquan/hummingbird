"""RunStore — Supabase Postgres writes for tasks + task_events.

Python mirror of `lib/server/agent/store.ts`. All writes are
`user_id`-scoped on top of the own-your-rows RLS (defence in depth).

Phase 2a scope: the writes the executor needs to drive a `start`
action end-to-end:

  - `update_run` — flip task status / step / handler / mark finished.
  - `append_event` — idempotent on `(task_id, seq)` so a retried emit
    (or an overlapping replay) is a no-op rather than a duplicate.
  - `set_task_handler` — stamp `tasks.metadata.handler = 'python'` so
    postmortems can tell which service ran which run.
  - `is_run_cancelled` — cheap probe the runner polls between steps.

`create_run` and `save_checkpoint` are deliberately NOT in this PR —
the route already creates the task row before enqueueing the
`start` job, and Phase 2a doesn't yet implement HITL pause/resume.
Both land alongside Phase 2b / Phase 3.
"""

from __future__ import annotations

import json
import uuid

import asyncpg

from .events import TaskEvent, event_to_row_payload


async def update_run(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    status: str | None = None,
    step: int | None = None,
    finished: bool = False,
) -> None:
    """Patch a `tasks` row. Only the fields explicitly passed get
    written — partial updates are intentional so the executor can
    bump just `step` between steps without touching status."""
    sets: list[str] = ["updated_at = now()"]
    args: list[object] = []
    if status is not None:
        sets.append(f"status = ${len(args) + 1}")
        args.append(status)
    if step is not None:
        sets.append(f"step = ${len(args) + 1}")
        args.append(step)
    if finished:
        sets.append("finished_at = now()")
    args.append(_coerce_uuid(run_id))
    args.append(_coerce_uuid(user_id))
    sql = (
        "UPDATE public.tasks "
        f"SET {', '.join(sets)} "
        f"WHERE id = ${len(args) - 1} AND user_id = ${len(args)};"
    )
    async with pool.acquire() as conn:
        await conn.execute(sql, *args)


_APPEND_EVENT_SQL = """
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (task_id, seq) DO NOTHING;
"""


async def append_event(
    pool: asyncpg.Pool,
    event: TaskEvent,
    *,
    user_id: str,
) -> None:
    """Insert one event row. Idempotent — a duplicate seq hits the
    `(task_id, seq)` unique constraint and is silently ignored,
    matching the TS path's `onConflict: 'task_id,seq', ignoreDuplicates: true`.
    """
    payload = event_to_row_payload(event)
    async with pool.acquire() as conn:
        await conn.execute(
            _APPEND_EVENT_SQL,
            _coerce_uuid(event.run_id),
            _coerce_uuid(user_id),
            event.seq,
            event.step,
            event.kind,
            json.dumps(payload),
        )


_SET_HANDLER_SQL = """
UPDATE public.tasks
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('handler', $3::text),
    updated_at = now()
WHERE id = $1 AND user_id = $2;
"""


async def set_task_handler(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    handler: str,
) -> None:
    """Stamp `tasks.metadata.handler` so post-hoc analysis can tell
    which service executed a given run. The TS worker leaves this
    unset; Python writes 'python'. Lets us audit the Phase 2 cutover
    without instrumenting the worker code paths."""
    async with pool.acquire() as conn:
        await conn.execute(
            _SET_HANDLER_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
            handler,
        )


_IS_CANCELLED_SQL = """
SELECT status FROM public.tasks
WHERE id = $1 AND user_id = $2;
"""


async def is_run_cancelled(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> bool:
    """Cheap status probe the runner polls between steps. A probe
    failure (DB blip, RLS reject) returns False — the run keeps
    going. The TS path makes the same call."""
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                _IS_CANCELLED_SQL,
                _coerce_uuid(run_id),
                _coerce_uuid(user_id),
            )
    except Exception:
        return False
    return bool(row and row["status"] == "cancelled")


_LOAD_CHECKPOINT_SQL = """
SELECT checkpoint FROM public.tasks
WHERE id = $1 AND user_id = $2;
"""


async def load_checkpoint(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> dict[str, object] | None:
    """Read the `tasks.checkpoint` jsonb column.

    Shape mirrors `RunCheckpoint` in `lib/server/agent/checkpoint.ts` —
    `{messages, step, seq, config: {model, system?, workspaceId?,
    skills, maxSteps, mode?, ...}}`. Returns the raw dict; the
    executor / step fn coerce the bits they need.

    Returns `None` when the row isn't found (RLS reject, race with
    delete) or when `checkpoint` is null (never written — shouldn't
    happen post-route but defensive against the early Phase 2a flow
    which can race in tests). The caller decides whether to bail or
    fall back."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            _LOAD_CHECKPOINT_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
        )
    if not row:
        return None
    raw = row["checkpoint"]
    if raw is None:
        return None
    if isinstance(raw, str):
        # asyncpg returns jsonb as `str` unless a codec is registered.
        # Decode lazily here so callers don't have to.
        try:
            decoded = json.loads(raw)
        except Exception:
            return None
        return decoded if isinstance(decoded, dict) else None
    if isinstance(raw, dict):
        return raw
    return None


def _coerce_uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)
