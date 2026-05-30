"""Tests for the executor.

The executor is the bridge between the queue (a claimed job) and the
agent loop (events + state). Tests focus on:
  1. Happy path: stub step fn runs, terminal events emitted, task row
     updated, ExecutorOutcome(settled=True) returned.
  2. Cancellation mid-loop: task status flipped → executor returns
     settled=True with `cancelled` terminal.
  3. Loop raises: ExecutorOutcome(settled=False), task row updated to
     `failed`, terminal `result: failed` event emitted.
  4. handler stamped: `set_task_handler` called with 'python'.

The DB layer is patched so tests don't need a real Postgres.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import store
from agent_py.executor import (
    ExecutorOutcome,
    StartActionPayload,
    execute_start,
)
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome

RUN_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def payload() -> StartActionPayload:
    return StartActionPayload(run_id=RUN_ID, user_id=USER_ID, max_steps=5)


@pytest.mark.asyncio
async def test_happy_path_settles_and_updates_task(
    payload: StartActionPayload,
) -> None:
    pool = MagicMock()
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()) as set_handler,
        patch.object(store, "append_event", new=AsyncMock()) as append,
        patch.object(store, "update_run", new=AsyncMock()) as update,
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
    ):
        outcome = await execute_start(pool, payload)
    assert outcome == ExecutorOutcome(settled=True)
    # handler stamped exactly once with 'python'.
    set_handler.assert_awaited_once()
    assert set_handler.await_args.kwargs["handler"] == "python"
    # Terminal task update marks done + finished.
    update.assert_awaited()
    last_update = update.await_args
    assert last_update.kwargs["status"] == "done"
    assert last_update.kwargs["finished"] is True
    # Events were persisted (at least: status, step_start, tokens,
    # step_end, result). Exact count depends on stub.
    assert append.await_count >= 4


@pytest.mark.asyncio
async def test_cancellation_returns_cancelled_terminal(
    payload: StartActionPayload,
) -> None:
    """Out-of-band cancel between steps → executor emits `status:
    cancelled` and updates the row terminal."""
    pool = MagicMock()
    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "update_run", new=AsyncMock()) as update,
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=True)),
    ):
        outcome = await execute_start(pool, payload)
    # `settled=True` because the cancel landed cleanly (not a fault).
    assert outcome.settled is True
    update.assert_awaited()
    assert update.await_args.kwargs["status"] == "cancelled"
    assert update.await_args.kwargs["finished"] is True


@pytest.mark.asyncio
async def test_step_fn_raising_marks_failed(
    payload: StartActionPayload,
) -> None:
    """A model/tool error inside the loop bubbles out as an
    ExecutorOutcome(settled=False) and gets reflected into the task
    row as `status: failed`."""
    pool = MagicMock()

    async def broken_step(ctx: RunStepContext) -> RunStepOutcome:
        raise RuntimeError("model timeout")

    def make_broken() -> RunStepFn:
        return broken_step

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock()),
        patch.object(store, "update_run", new=AsyncMock()) as update,
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_broken)
    assert outcome.settled is False
    assert outcome.error is not None
    assert "model timeout" in outcome.error
    # Task row updated to failed.
    update.assert_awaited()
    assert update.await_args.kwargs["status"] == "failed"
    assert update.await_args.kwargs["finished"] is True


@pytest.mark.asyncio
async def test_step_fn_returning_done_settles_after_one_step(
    payload: StartActionPayload,
) -> None:
    """An immediate `done` from the step fn → exactly one step pair
    + status:running + result:done. The minimum viable agent run."""
    pool = MagicMock()
    persisted: list[str] = []

    async def append(_pool, event, *, user_id):  # type: ignore[no-untyped-def]
        persisted.append(event.kind)

    async def immediate_done(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    def make_immediate() -> RunStepFn:
        return immediate_done

    with (
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "append_event", new=AsyncMock(side_effect=append)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
    ):
        outcome = await execute_start(pool, payload, make_step_fn=make_immediate)
    assert outcome.settled is True
    # Order: status:running, step_start, step_end, result.
    assert persisted == ["status", "step_start", "step_end", "result"]
