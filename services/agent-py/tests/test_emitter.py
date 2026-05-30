"""Tests for the RunEmitter — seq monotonicity + settle-once."""

from __future__ import annotations

import pytest

from agent_py.emitter import RunEmitter
from agent_py.events import ResultEvent, StatusEvent, TaskEvent, TokenEvent


class _Capture:
    """Sink that records every event for assertions."""

    def __init__(self) -> None:
        self.events: list[TaskEvent] = []

    async def __call__(self, event: TaskEvent) -> None:
        self.events.append(event)


@pytest.mark.asyncio
async def test_seq_is_monotonic_and_gap_free() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)
    await em.status("running")
    await em.start_step()
    await em.token("hi")
    await em.token(" there")
    await em.end_step()
    await em.result("done")

    seqs = [e.seq for e in sink.events]
    assert seqs == [1, 2, 3, 4, 5, 6]
    # Last event is the latched terminal.
    assert isinstance(sink.events[-1], ResultEvent)


@pytest.mark.asyncio
async def test_step_counter_bumps_on_start_step() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)
    assert em.step == 0
    await em.start_step()
    assert em.step == 1
    await em.start_step()
    assert em.step == 2


@pytest.mark.asyncio
async def test_seeded_start_seq_and_step_for_resume() -> None:
    """A continuation invocation seeds seq + step from the checkpoint
    so the next emit is monotonic across invocations."""
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink, start_seq=7, start_step=3)
    await em.token("resumed")
    assert sink.events[0].seq == 8
    assert sink.events[0].step == 3


@pytest.mark.asyncio
async def test_terminal_status_latches_emitter() -> None:
    """After `status: cancelled` lands, further emits are no-ops —
    matches the TS invariant that a late tool callback can't append
    past the end."""
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)
    await em.status("cancelled")
    assert em.settled
    # These should all be dropped silently.
    await em.token("ghost")
    await em.start_step()
    await em.result("done")
    assert len(sink.events) == 1
    assert isinstance(sink.events[0], StatusEvent)


@pytest.mark.asyncio
async def test_result_terminates_emitter() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)
    await em.result("done", final_text="bye")
    assert em.settled
    await em.token("ghost")
    assert len(sink.events) == 1
    last = sink.events[0]
    assert isinstance(last, ResultEvent)
    assert last.final_text == "bye"


@pytest.mark.asyncio
async def test_non_terminal_status_does_not_latch() -> None:
    sink = _Capture()
    em = RunEmitter(run_id="r", sink=sink)
    await em.status("running")
    assert not em.settled
    await em.token("more")
    assert len(sink.events) == 2
    assert isinstance(sink.events[1], TokenEvent)
