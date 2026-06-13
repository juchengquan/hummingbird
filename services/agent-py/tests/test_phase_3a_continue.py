"""Phase 3a tests — `should_yield` in the runner + `execute_continue`
in the executor.

The runner gains a `should_yield: Callable[[], bool] | None` arg —
polled before each step. When it fires the loop returns
`AgentLoopResult(kind='yielded')` without emitting any terminal event.

`execute_continue` mirrors `execute_start` but seeds the emitter at
the checkpoint's saved seq/step; on yield BOTH actions save a fresh
checkpoint and enqueue another `continue` job so the worker keeps
chunking until the run settles.

We isolate yield-path behaviour from real Postgres via patches on
`store.*` and `jobs.enqueue_continue_job`. All tests stay hermetic.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import events, executor, jobs, store
from agent_py.emitter import RunEmitter
from agent_py.events import ResultEvent, StatusEvent, TaskEvent
from agent_py.runner import (
    AgentLoopResult,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    run_agent_loop,
)

# --- Runner: should_yield -----------------------------------------------


def _list_sink() -> tuple[list[TaskEvent], RunEmitter]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    emitter = RunEmitter(run_id="r1", sink=sink)
    return collected, emitter


@pytest.mark.asyncio
async def test_run_loop_yields_before_next_step() -> None:
    """The yield gate fires BEFORE the next step starts, so a step in
    flight always runs to completion."""
    step_calls = 0

    async def fake_step(_ctx: RunStepContext) -> RunStepOutcome:
        nonlocal step_calls
        step_calls += 1
        return RunStepOutcome(done=False)

    async def is_cancelled() -> bool:
        return False

    # Yield TRUE after the first step has already run.
    yield_calls = 0

    def should_yield() -> bool:
        nonlocal yield_calls
        yield_calls += 1
        return yield_calls > 1  # First check (before first step): False; second: True

    collected, emitter = _list_sink()
    result = await run_agent_loop(
        emitter=emitter,
        max_steps=10,
        run_step=fake_step,
        is_cancelled=is_cancelled,
        should_yield=should_yield,
    )

    assert result == AgentLoopResult(kind="yielded")
    assert step_calls == 1  # One step ran before the yield gate flipped.
    # No terminal `result` event emitted on yield — only `status: running`
    # + start_step/end_step from step 1.
    kinds = [e.kind for e in collected]
    assert "result" not in kinds
    assert kinds[0] == "status"  # The auto `status: running`.
    statuses = [e.status for e in collected if isinstance(e, StatusEvent)]
    assert "cancelled" not in statuses
    assert "running" in statuses


@pytest.mark.asyncio
async def test_run_loop_does_not_yield_when_should_yield_is_none() -> None:
    """When `should_yield` is None we never check it and the loop
    runs to settle. Preserves Phase 2a/2b behaviour for callers that
    don't opt into chunking."""
    calls = 0

    async def fake_step(_ctx: RunStepContext) -> RunStepOutcome:
        nonlocal calls
        calls += 1
        return RunStepOutcome(done=True)

    async def is_cancelled() -> bool:
        return False

    _, emitter = _list_sink()
    result = await run_agent_loop(
        emitter=emitter,
        max_steps=5,
        run_step=fake_step,
        is_cancelled=is_cancelled,
    )
    assert result.kind == "settled"
    assert calls == 1


@pytest.mark.asyncio
async def test_run_loop_yield_takes_precedence_over_cancel_check_order() -> None:
    """Cancel check runs FIRST, then yield. If both fire on the same
    tick the cancel wins (the user explicitly stopped — we don't
    silently chunk past a cancel)."""

    async def fake_step(_ctx: RunStepContext) -> RunStepOutcome:
        return RunStepOutcome(done=True)

    async def is_cancelled() -> bool:
        return True

    def should_yield() -> bool:
        return True  # Both gates fire, cancel wins.

    _, emitter = _list_sink()
    result = await run_agent_loop(
        emitter=emitter,
        max_steps=5,
        run_step=fake_step,
        is_cancelled=is_cancelled,
        should_yield=should_yield,
    )
    assert result.kind == "cancelled"


# --- Executor: execute_continue ----------------------------------------


def _make_step_fn(
    *,
    yield_at: int | None = None,
    done_at: int = 1,
) -> tuple[
    list[int],
    executor.MakeStepFn,
]:
    """Build a `MakeStepFn` whose step fn counts invocations. `yield_at`
    + `done_at` are 1-based step numbers — the step returns done=True
    at `done_at`. Yield is driven by the executor's deadline, not by
    the step itself; the step always returns done=False until done_at.
    """
    called_with: list[int] = []

    def make(
        _payload: Any, _checkpoint: Any, _messages: list[Any], _context: Any = None
    ) -> RunStepFn:
        async def step(ctx: RunStepContext) -> RunStepOutcome:
            called_with.append(ctx.step)
            return RunStepOutcome(done=ctx.step >= done_at)

        return step

    return called_with, make


@pytest.mark.asyncio
async def test_execute_continue_seeds_emitter_from_checkpoint() -> None:
    """The checkpoint's `seq` / `step` seed the emitter so resumed
    events follow monotonically from the previous chunk."""
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )
    _, make_step = _make_step_fn(done_at=1)

    # Capture the emitter at construction time.
    captured_emitters: list[RunEmitter] = []
    original_init = RunEmitter.__init__

    def patched_init(
        self: RunEmitter,
        *,
        run_id: str,
        sink: Any,
        start_seq: int = 0,
        start_step: int = 0,
    ) -> None:
        original_init(
            self,
            run_id=run_id,
            sink=sink,
            start_seq=start_seq,
            start_step=start_step,
        )
        captured_emitters.append(self)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "hi"}],
                    "step": 5,
                    "seq": 12,
                    "config": {"model": "claude-sonnet-4-6", "maxSteps": 10},
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(RunEmitter, "__init__", patched_init),
    ):
        outcome = await executor.execute_continue(pool, payload, make_step_fn=make_step)

    assert outcome.settled is True
    assert len(captured_emitters) == 1
    emitter = captured_emitters[0]
    assert emitter.step >= 5  # Emitter started at step 5; one step ran → 6.
    assert emitter.seq > 12  # Seq advanced past the checkpoint's last.


@pytest.mark.asyncio
async def test_execute_start_seeds_at_zero_not_from_checkpoint() -> None:
    """A `start` action ignores any pre-existing checkpoint seq/step.
    Defends against a race where the route's initial checkpoint write
    had stale data — `start` always starts from zero."""
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )
    _, make_step = _make_step_fn(done_at=1)

    captured_emitters: list[RunEmitter] = []
    original_init = RunEmitter.__init__

    def patched_init(
        self: RunEmitter,
        *,
        run_id: str,
        sink: Any,
        start_seq: int = 0,
        start_step: int = 0,
    ) -> None:
        original_init(
            self,
            run_id=run_id,
            sink=sink,
            start_seq=start_seq,
            start_step=start_step,
        )
        captured_emitters.append(self)

    # Even though the checkpoint claims step=7, start ignores it.
    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "hi"}],
                    "step": 7,
                    "seq": 19,
                    "config": {"model": "claude-sonnet-4-6", "maxSteps": 10},
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(RunEmitter, "__init__", patched_init),
    ):
        await executor.execute_start(pool, payload, make_step_fn=make_step)

    emitter = captured_emitters[0]
    # The first step bumped step 0 → 1; seq advanced 0 → small.
    assert emitter.step == 1


@pytest.mark.asyncio
async def test_yielded_chunk_saves_checkpoint_and_enqueues_continue() -> None:
    """When the runner returns `kind='yielded'`, the executor saves a
    fresh checkpoint (with current messages + emitter seq/step) and
    enqueues another `continue` job."""
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )

    # Fake step always returns done=False; the should_yield gate
    # (controlled by the executor's deadline plumbing) ends the chunk.
    # We force should_yield True by setting WORKER_CHUNK_BUDGET_S=-1
    # so the deadline is in the past from the start.
    def make(_p: Any, _c: Any, _m: list[Any], _ctx: Any = None) -> RunStepFn:
        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            return RunStepOutcome(done=False)

        return step

    # Force should_yield True from the first check by patching the
    # deadline helper to return a timestamp already in the past.
    with (
        patch.object(executor, "_chunk_deadline_s", return_value=0.0),
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "hi"}],
                    "step": 3,
                    "seq": 9,
                    "config": {"model": "claude-sonnet-4-6", "maxSteps": 10},
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()) as update_run,
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch.object(jobs, "enqueue_continue_job", new=AsyncMock()) as enqueue,
    ):
        outcome = await executor.execute_continue(pool, payload, make_step_fn=make)

    assert outcome.settled is True
    # Yielded path: save_checkpoint + enqueue_continue_job called.
    save_checkpoint.assert_awaited_once()
    enqueue.assert_awaited_once_with(pool, task_id=payload.run_id, user_id=payload.user_id)
    # The `tasks` row is NOT marked `done` on yield (the run isn't
    # over yet; it's just chunking).
    update_run.assert_not_called()

    saved_kwargs = save_checkpoint.await_args.kwargs
    saved = saved_kwargs["checkpoint"]
    # Checkpoint shape mirrors `RunCheckpoint`.
    assert set(saved.keys()) == {"messages", "step", "seq", "config"}
    assert saved["step"] == 3  # No step ran (yield fired before step 1).
    assert saved["seq"] == 9
    assert saved["config"]["model"] == "claude-sonnet-4-6"


@pytest.mark.asyncio
async def test_settled_chunk_marks_task_done_no_enqueue() -> None:
    """The normal settle path: step returns done=True → update_run
    `done` + finished_at, no enqueue."""
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )
    _, make_step = _make_step_fn(done_at=1)

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "hi"}],
                    "config": {"model": "claude-sonnet-4-6"},
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()) as update_run,
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch.object(jobs, "enqueue_continue_job", new=AsyncMock()) as enqueue,
    ):
        outcome = await executor.execute_start(pool, payload, make_step_fn=make_step)

    assert outcome.settled is True
    update_run.assert_awaited()
    save_checkpoint.assert_not_called()
    enqueue.assert_not_called()


# --- Commit 4: cross-chunk verification on the resumed (continue) path --


@pytest.mark.asyncio
async def test_execute_continue_reaggregates_verification_from_event_log() -> None:
    """A research run that yielded at chunk 1 and settles on a
    `continue` chunk re-aggregates report text + sources from the FULL
    task_events log in `finalize`, so the terminal result still carries
    a verification. Pre-commit-4 the resumed chunk returned None — the
    per-chunk in-memory accumulators only held the resumed chunk's
    slice."""
    pool = MagicMock()
    payload = executor.StartActionPayload(
        run_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
    )
    _, make_step = _make_step_fn(done_at=1)

    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    # The full event log the DB holds for the whole run (both chunks):
    # a text token + a webSearch result. `aggregate_from_events` runs
    # for real over this; `_maybe_verify` is stubbed to capture the
    # (text, sources) it receives and return a canned payload.
    full_log: list[TaskEvent] = [
        events.TokenEvent(
            run_id="r", seq=2, step=0, created_at="t",
            text="Sky is blue [1].", channel="text",
        ),
        events.ToolOutputEvent(
            run_id="r", seq=3, step=0, created_at="t",
            tool_call_id="t1", tool_name="webSearch", summary="1 result",
            results=[events.ToolCallResult(title="A", url="https://a", snippet="s")],
        ),
    ]
    verify_payload: dict[str, object] = {
        "checks": [],
        "summary": {"supported": 1, "partial": 0, "unsupported": 0, "total": 1},
    }

    with (
        patch.object(
            store,
            "load_checkpoint",
            new=AsyncMock(
                return_value={
                    "messages": [{"role": "user", "content": "hi"}],
                    "step": 5,
                    "seq": 12,
                    "config": {"model": "claude-sonnet-4-6", "mode": "research"},
                }
            ),
        ),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "load_run_events", new=AsyncMock(return_value=full_log)) as load_events,
        patch.object(
            executor, "_maybe_verify", new=AsyncMock(return_value=verify_payload)
        ) as maybe_verify,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_continue(pool, payload, make_step_fn=make_step)

    assert outcome.settled is True
    # finalize re-aggregated from the DB on the resumed chunk.
    load_events.assert_awaited_once()
    # `_maybe_verify` saw the text + sources re-derived from the FULL
    # log, not this chunk's empty in-memory accumulators.
    assert maybe_verify.await_count == 1
    kwargs = maybe_verify.await_args.kwargs
    assert kwargs["mode"] == "research"
    assert kwargs["text"] == "Sky is blue [1]."
    assert kwargs["sources"] == [("A", "https://a", "s")]
    # The verification rides on the terminal result.
    final_result = next(e for e in collected if isinstance(e, ResultEvent))
    assert final_result.verification == verify_payload
