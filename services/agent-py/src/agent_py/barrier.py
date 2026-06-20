"""Subagent join barrier.

When a child task settles, transition it to terminal exactly once,
decrement its parent's `pending_children`, and re-enqueue the parent's
`continue` job when the counter reaches zero — but only if the parent is
still live (never resurrect a cancelled/finished orchestrator). All three
steps run in one transaction so the decrement and the zero-check are
race-free. Idempotent against job retries: the terminal transition's
`WHERE status NOT IN (terminal)` clause fires at most once per task, so
the decrement fires at most once.

PR-1 ships this module standalone (proven with mocked pools); PR-2 wires
the executor/settlement path to call it.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

import asyncpg

from agent_py.jobs import ENQUEUE_CONTINUE_SQL

_TERMINAL = ("done", "failed", "cancelled")

_TRANSITION_SQL = """
UPDATE public.tasks
SET status = $2, finished_at = now(), updated_at = now()
WHERE id = $1 AND status NOT IN ('done', 'failed', 'cancelled')
RETURNING parent_task_id;
"""

_DECREMENT_SQL = """
UPDATE public.tasks
SET pending_children = pending_children - 1, updated_at = now()
WHERE id = $1
RETURNING pending_children, status;
"""


@dataclass(frozen=True)
class SettleResult:
    """Outcome of a settle attempt. `transitioned` is False when the task
    was already terminal (idempotent no-op)."""

    transitioned: bool
    parent_task_id: str | None
    parent_remaining: int | None
    reenqueued_parent: bool


async def settle_task_terminal(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
    status: str,
) -> SettleResult:
    """Move `task_id` to terminal `status`, settle its parent's barrier.

    `status` must be one of 'done' | 'failed' | 'cancelled'.
    """
    if status not in _TERMINAL:
        raise ValueError(f"settle_task_terminal: status must be terminal, got {status!r}")

    task_uuid = uuid.UUID(task_id)
    user_uuid = uuid.UUID(user_id)

    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(_TRANSITION_SQL, task_uuid, status)
        if row is None:
            return SettleResult(
                transitioned=False,
                parent_task_id=None,
                parent_remaining=None,
                reenqueued_parent=False,
            )

        parent = row["parent_task_id"]
        if parent is None:
            return SettleResult(
                transitioned=True,
                parent_task_id=None,
                parent_remaining=None,
                reenqueued_parent=False,
            )

        dec = await conn.fetchrow(_DECREMENT_SQL, parent)
        remaining: int | None = dec["pending_children"] if dec else None
        parent_status = dec["status"] if dec else None

        reenqueued = False
        if remaining == 0 and parent_status not in _TERMINAL:
            await conn.execute(
                ENQUEUE_CONTINUE_SQL,
                parent,
                user_uuid,
                "continue",
                json.dumps({}),
            )
            reenqueued = True

        return SettleResult(
            transitioned=True,
            parent_task_id=str(parent),
            parent_remaining=remaining,
            reenqueued_parent=reenqueued,
        )
