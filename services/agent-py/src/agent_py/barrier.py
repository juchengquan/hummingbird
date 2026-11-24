"""Settle a task terminal — the worker's half of the join barrier.

The barrier itself is the database's (migration 0045, `tasks_ended` /
`tasks_deleted` → `private.settle_barrier`): whatever ends a child — this
settle, a cancel, the reconciler, the owner's update or delete — recounts
its parent's live children exactly once and queues the parent's
`continue` when the last one ended. So the worker only makes the
transition, at most once (`WHERE status NOT IN (terminal)`), with the
run's terminal event in the same transaction: a settle that loses to a
cancel writes neither.

The transition also writes `tasks.outcome` (wave 6, survey bug 7) in the
shape the interactive driver writes (`runs.model.outcome_to_json`), from
the terminal event: `success` with the `RunResult` (`text`,
`memoryTainted`, `stoppedAt`, `verification`), `error` with the event's code and message,
or `cancelled`. Readers (`Run.result` / `Run.error`, the stream's closing
event, the sub-agent fan-in) then never rebuild it from the log.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

import asyncpg

from agent_py import store
from agent_py.events import ResultEvent, TaskEvent, event_to_row_payload
from agent_py.fence import fenced_connection

_TERMINAL = ("done", "failed", "cancelled")

_TRANSITION_SQL = """
UPDATE public.tasks
SET status = $2, outcome = $4::jsonb, finished_at = now(), updated_at = now()
WHERE id = $1 AND user_id = $3 AND status NOT IN ('done', 'failed', 'cancelled')
RETURNING parent_task_id;
"""

# The event's own seq, or past the log's end when someone else took it
# (the row lock just taken keeps other fenced appends out).
_TERMINAL_EVENT_SQL = """
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload)
VALUES (
    $1, $2,
    GREATEST(
        $3::integer,
        (SELECT COALESCE(MAX(e.seq), 0) + 1 FROM public.task_events e WHERE e.task_id = $1)
    ),
    $4, $5, $6::jsonb
)
ON CONFLICT (task_id, seq) DO NOTHING;
"""


def terminal_outcome(status: str, event: TaskEvent | None) -> dict[str, object]:
    """The `tasks.outcome` a background settle writes (RUN_EVENTS.md § 5):
    built from the terminal `result` entry, with the same defaults the
    log fallback uses (`unknown` / "Run failed.")."""
    result = event if isinstance(event, ResultEvent) else None
    if status == "done":
        body: dict[str, object] = {}
        if result is not None:
            if result.final_text is not None:
                body["text"] = result.final_text
            if result.memory_tainted:
                body["memoryTainted"] = True
            if result.stopped_at is not None:
                body["stoppedAt"] = result.stopped_at
            if result.verification is not None:
                # The citation check (Q78), as the `hummingbird.verification`
                # activity carries it, next to the text it checked.
                body["verification"] = dict(result.verification)
            if result.images:
                # Q87: the task's images, its sub-agents' included.
                body["images"] = [dict(i) for i in result.images]
        return {"type": "success", "result": body}
    if status == "failed":
        return {
            "type": "error",
            "code": (result.error_code if result is not None else None) or "unknown",
            "message": (result.error if result is not None else None) or "Run failed.",
        }
    return {"type": "cancelled"}


@dataclass(frozen=True)
class SettleResult:
    """Outcome of a settle attempt. `transitioned` is False when the task
    was already terminal (idempotent no-op)."""

    transitioned: bool
    parent_task_id: str | None


async def settle_task_terminal(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    status: str,
    event: TaskEvent | None = None,
) -> SettleResult:
    """Move `task_id` to terminal `status` and write `event`, its
    terminal log entry, if — and only if — this call made the transition.

    `status` must be one of 'done' | 'failed' | 'cancelled'. The
    transition is `user_id`-scoped (defence in depth — the worker pool
    bypasses RLS), so a job carrying a mismatched user can never settle
    another user's task.
    """
    if status not in _TERMINAL:
        raise ValueError(f"settle_task_terminal: status must be terminal, got {status!r}")

    task_uuid = uuid.UUID(task_id)
    user_uuid = uuid.UUID(user_id)

    async with fenced_connection(pool) as conn, conn.transaction():
        # 0045's lock order: the trigger goes on to the parent's row.
        await conn.execute(store.LOCK_TASK_SCOPE_SQL, user_uuid, task_uuid)
        row = await conn.fetchrow(
            _TRANSITION_SQL,
            task_uuid,
            status,
            user_uuid,
            json.dumps(terminal_outcome(status, event)),
        )
        if row is None:
            return SettleResult(transitioned=False, parent_task_id=None)
        if event is not None:
            await conn.execute(
                _TERMINAL_EVENT_SQL,
                task_uuid,
                user_uuid,
                event.seq,
                event.step,
                event.kind,
                json.dumps(event_to_row_payload(event)),
            )
        parent = row["parent_task_id"]
        return SettleResult(
            transitioned=True, parent_task_id=None if parent is None else str(parent)
        )
