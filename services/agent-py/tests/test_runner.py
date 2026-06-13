"""Tests for `run_agent_loop` — control flow only.

Pure orchestration tests with a fake `RunStepFn` so we never need a
live model. The contracts:
  - Loop emits `status: running` exactly once at the start.
  - One step per iteration. Step counter on the emitter bumps.
  - `is_cancelled() == True` between steps emits `status: cancelled`
    and returns kind='cancelled'.
  - `done=True` outcome settles with `result: done`.
  - `max_steps` cap settles even without `done`.
"""

from __future__ import annotations

import pytest

from agent_py.emitter import RunEmitter
from agent_py.events import (
    ResultEvent,
    StatusEvent,
    StepEndEvent,
    StepStartEvent,
    TaskEvent,
)
from agent_py.runner import RunStepContext, RunStepOutcome, run_agent_loop


class _Capture:
    def __init__(self) -> None:
        self.events: list[TaskEvent] = []

    async def __call__(self, event: TaskEvent) -> None:
        self.events.append(event)


async def _never_cancelled() -> bool:
    return False


@pytest.mark.asyncio
async def test_loop_settles_after_done_outcome() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    result = await run_agent_loop(
        emitter=em, max_steps=5, run_step=step_fn, is_cancelled=_never_cancelled
    )
    assert result.kind == "settled"
    kinds = [type(e).__name__ for e in sink.events]
    assert kinds == [
        "StatusEvent",
        "StepStartEvent",
        "StepEndEvent",
        "ResultEvent",
    ]
    assert isinstance(sink.events[0], StatusEvent)
    assert sink.events[0].status == "running"
    assert isinstance(sink.events[-1], ResultEvent)
    assert sink.events[-1].status == "done"


@pytest.mark.asyncio
async def test_loop_iterates_until_done() -> None:
    """Two not-done steps then one done — three step pairs total."""
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)

    steps_taken: list[int] = []

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        steps_taken.append(ctx.step)
        return RunStepOutcome(done=len(steps_taken) == 3)

    result = await run_agent_loop(
        emitter=em, max_steps=10, run_step=step_fn, is_cancelled=_never_cancelled
    )
    assert result.kind == "settled"
    assert steps_taken == [1, 2, 3]
    # 1 status + 3 x (start + end) + 1 result.
    assert len(sink.events) == 1 + 6 + 1


@pytest.mark.asyncio
async def test_loop_settles_at_max_steps_without_done() -> None:
    """A model that never declares done still settles cleanly — the
    accumulated tokens are the answer. Matches the TS path."""
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=False)

    result = await run_agent_loop(
        emitter=em, max_steps=2, run_step=step_fn, is_cancelled=_never_cancelled
    )
    assert result.kind == "settled"
    assert em.step == 2
    assert isinstance(sink.events[-1], ResultEvent)


@pytest.mark.asyncio
async def test_finalize_hook_attaches_verification_to_result() -> None:
    """The finalize hook runs just before the terminal `result` and its
    return value rides on `ResultEvent.verification` (citation pass)."""
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)
    payload = {
        "checks": [],
        "summary": {"supported": 1, "partial": 0, "unsupported": 0, "total": 1},
    }

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    async def finalize() -> dict[str, object] | None:
        return payload

    result = await run_agent_loop(
        emitter=em,
        max_steps=5,
        run_step=step_fn,
        is_cancelled=_never_cancelled,
        finalize=finalize,
    )
    assert result.kind == "settled"
    last = sink.events[-1]
    assert isinstance(last, ResultEvent)
    assert last.verification == payload


@pytest.mark.asyncio
async def test_no_finalize_hook_leaves_verification_none() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    await run_agent_loop(emitter=em, max_steps=5, run_step=step_fn, is_cancelled=_never_cancelled)
    last = sink.events[-1]
    assert isinstance(last, ResultEvent)
    assert last.verification is None


@pytest.mark.asyncio
async def test_cancellation_detected_between_steps() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)

    step_count = {"n": 0}

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        step_count["n"] += 1
        return RunStepOutcome(done=False)

    async def cancelled_after_one() -> bool:
        return step_count["n"] >= 1

    result = await run_agent_loop(
        emitter=em, max_steps=10, run_step=step_fn, is_cancelled=cancelled_after_one
    )
    assert result.kind == "cancelled"
    assert step_count["n"] == 1  # second iteration's cancel check fires
    # Terminal is a `status: cancelled`, NOT a `result`.
    assert isinstance(sink.events[-1], StatusEvent)
    assert sink.events[-1].status == "cancelled"


@pytest.mark.asyncio
async def test_loop_emits_step_boundaries_for_each_iteration() -> None:
    """Frontend projections rely on step_start/step_end pairs."""
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)

    async def step_fn(ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    await run_agent_loop(emitter=em, max_steps=3, run_step=step_fn, is_cancelled=_never_cancelled)
    starts = [e for e in sink.events if isinstance(e, StepStartEvent)]
    ends = [e for e in sink.events if isinstance(e, StepEndEvent)]
    assert len(starts) == 1
    assert len(ends) == 1
    assert starts[0].step == 1
    assert ends[0].step == 1
