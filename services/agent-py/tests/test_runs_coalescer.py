"""CoalescingEmitter: deltas merged before they get a seq, never reordered."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from agent_py.events import SuggestionsEvent, TaskEvent, TokenEvent
from agent_py.runs.coalescer import CoalescingEmitter
from agent_py.runs.event_log_memory import MemoryRunEventLog

RUN = "run-1"


class _Sink:
    def __init__(self, delay: float = 0.0) -> None:
        self.events: list[TaskEvent] = []
        self.delay = delay
        self.fail_next = False

    async def __call__(self, event: TaskEvent) -> None:
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail_next:
            self.fail_next = False
            raise ConnectionError("db down")
        self.events.append(event)


def _summary(events: list[TaskEvent]) -> list[tuple[int, str, str]]:
    return [
        (e.seq, e.kind, e.text if isinstance(e, TokenEvent) else "")  # type: ignore[union-attr]
        for e in events
    ]


async def test_deltas_merge_and_take_the_seq_before_the_next_event() -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=60)
    await em.start_step()
    for piece in ("Hel", "lo", ", ", "world"):
        await em.token(piece)
    assert em.buffered == "Hello, world"
    await em.tool_input(tool_call_id="c", tool_name="t", args={})
    await em.end_step()
    assert _summary(sink.events) == [
        (1, "step_start", ""),
        (2, "token", "Hello, world"),
        (3, "tool_input", ""),
        (4, "step_end", ""),
    ]
    assert sink.events[1].step == 1
    assert em.seq == 4
    await em.aclose()


async def test_channel_switch_and_empty_deltas() -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=60)
    await em.token("think ", channel="reasoning")
    await em.token("", channel="text")
    await em.token("more", channel="reasoning")
    await em.token("say", channel="text")
    await em.token("!", channel="text")
    await em.aclose()
    assert [(e.seq, e.channel, e.text) for e in sink.events if isinstance(e, TokenEvent)] == [
        (1, "reasoning", "think more"),
        (2, "text", "say!"),
    ]


async def test_timer_flush() -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=0.02)
    await em.token("a")
    await em.token("b")
    assert sink.events == []
    await asyncio.sleep(0.08)
    assert _summary(sink.events) == [(1, "token", "ab")]
    await em.token("c")
    await asyncio.sleep(0.08)
    assert _summary(sink.events) == [(1, "token", "ab"), (2, "token", "c")]
    await em.aclose()


async def test_size_cap_flush() -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=60, max_chars=5)
    await em.token("abc")
    await em.token("def")  # 6 chars ≥ 5 → flushed now
    assert _summary(sink.events) == [(1, "token", "abcdef")]
    await em.token("g")
    await em.aclose()
    assert _summary(sink.events)[-1] == (2, "token", "g")


EMITS: list[tuple[str, Callable[[CoalescingEmitter], Awaitable[Any]]]] = [
    ("status", lambda em: em.status("running")),
    ("start_step", lambda em: em.start_step()),
    ("end_step", lambda em: em.end_step()),
    ("tool_input", lambda em: em.tool_input(tool_call_id="c", tool_name="t", args={})),
    ("tool_output", lambda em: em.tool_output(tool_call_id="c", tool_name="t", summary="s")),
    ("input_request", lambda em: em.input_request(approval_id="a")),
    ("input_response", lambda em: em.input_response(approval_id="a", approved=True)),
    ("step_error", lambda em: em.step_error("x")),
    ("handoff", lambda em: em.handoff(agent="a")),
    ("result", lambda em: em.result("done")),
    ("emit", lambda em: em.emit(SuggestionsEvent, values=("q",))),
]


@pytest.mark.parametrize("emit", [e[1] for e in EMITS], ids=[e[0] for e in EMITS])
async def test_every_emitter_method_flushes_first(
    emit: Callable[[CoalescingEmitter], Awaitable[Any]],
) -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=60)
    await em.token("buffered")
    await emit(em)
    assert sink.events[0].seq == 1 and isinstance(sink.events[0], TokenEvent)
    assert sink.events[1].seq == 2 and not isinstance(sink.events[1], TokenEvent)
    await em.aclose()


async def test_settle_latches_and_drops_later_deltas() -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=60)
    await em.token("answer")
    await em.result("done", final_text="answer")
    await em.token("late")
    await em.aclose()
    assert _summary(sink.events) == [(1, "token", "answer"), (2, "result", "")]


async def test_timer_and_emit_never_interleave_in_the_sink() -> None:
    """A slow sink: the timer's flush and a concurrent emit still reach it
    one at a time, in seq order."""
    sink = _Sink(delay=0.01)
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=0.005)
    for i in range(30):
        await em.token(f"{i} ")
        if i % 7 == 0:
            await em.step_error(f"e{i}")
        await asyncio.sleep(0.003)
    await em.aclose()
    seqs = [e.seq for e in sink.events]
    assert seqs == list(range(1, len(seqs) + 1))
    text = "".join(e.text for e in sink.events if isinstance(e, TokenEvent))
    assert text == "".join(f"{i} " for i in range(30))


async def test_a_failed_append_is_retried_by_the_next_emit() -> None:
    sink = _Sink()
    em = CoalescingEmitter(run_id=RUN, sink=sink, flush_interval=60)
    await em.token("a")
    sink.fail_next = True
    with pytest.raises(ConnectionError):
        await em.end_step()
    assert sink.events == []
    await em.step_error("next")
    assert _summary(sink.events) == [(1, "token", "a"), (2, "step_end", ""), (3, "step_error", "")]
    await em.aclose()


async def test_into_a_real_log() -> None:
    log = MemoryRunEventLog()
    em = CoalescingEmitter(run_id=RUN, sink=log.append, flush_interval=60, start_seq=4)
    await em.token("x")
    await em.token("y")
    await em.aclose()
    (entry,) = await log.read(RUN)
    assert (entry.seq, entry.kind) == (5, "token")
