"""Wave 3b-C — the agent loop emits the run model's internal events.

`chat_loop.run_turn_loop` is the agent loop the native harness drives;
these pin the events it emits and how it ends a turn. (The AI SDK
translator `/v1/chat` used went with that route in wave 13, Q121.)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

from agent_py.chat_loop import (
    LoopFailed,
    LoopSucceeded,
    UsageMeter,
    run_turn_loop,
)
from agent_py.emitter import RunEmitter
from agent_py.events import (
    StepErrorEvent,
    TaskEvent,
    TokenEvent,
    ToolOutputEvent,
    event_to_row_payload,
)
from agent_py.tools.registry import ToolDescriptor, ToolError, ToolInvocationResult

# --- fakes ---------------------------------------------------------------------


def _text(t: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="text_delta", text=t)
    )


def _thinking(t: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta", delta=SimpleNamespace(type="thinking_delta", thinking=t)
    )


def _usage_events(inp: int, out: int, cached: int = 0) -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            type="message_start",
            message=SimpleNamespace(
                usage=SimpleNamespace(input_tokens=inp, cache_read_input_tokens=cached)
            ),
        ),
        SimpleNamespace(type="message_delta", usage=SimpleNamespace(output_tokens=out)),
    ]


class _Stream:
    def __init__(self, step: dict[str, Any]) -> None:
        self._step = step

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[SimpleNamespace]:
        for e in self._step.get("events", []):
            yield e
        if "raise" in self._step:
            raise self._step["raise"]

    async def get_final_message(self) -> dict[str, Any]:
        content = [{"type": "tool_use", **t} for t in self._step.get("tools", [])]
        return {"content": content}


class _Client:
    def __init__(self, steps: list[dict[str, Any]]) -> None:
        steps = list(steps)

        class _Messages:
            def stream(self, **_kw: Any) -> _Stream:
                return _Stream(steps.pop(0))

        self.messages = _Messages()


def _tool(name: str, *, fail: bool = False) -> ToolDescriptor:
    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        if fail:
            raise ToolError("nope")
        return ToolInvocationResult(text=f"full:{args.get('q', '')}", summary="short")

    return ToolDescriptor(
        name=name, description="d", input_schema={"type": "object"}, execute=execute
    )


async def _run(steps: list[dict[str, Any]], **kwargs: Any) -> tuple[list[TaskEvent], Any]:
    events: list[TaskEvent] = []

    async def sink(e: TaskEvent) -> None:
        events.append(e)

    result = await run_turn_loop(
        client=_Client(steps),  # type: ignore[arg-type]
        emitter=RunEmitter(run_id="r", sink=sink),
        model="claude-test",
        messages=[{"role": "user", "content": "hi"}],
        **kwargs,
    )
    return events, result


# --- the loop's events ------------------------------------------------------------


async def test_loop_emits_internal_events_for_a_tool_round_trip() -> None:
    events, result = await _run(
        [
            {
                "events": [_thinking("hmm"), _text("a"), *_usage_events(10, 3, cached=4)],
                "tools": [{"id": "t1", "name": "webFetch", "input": {"q": "x"}}],
            },
            {"events": [_text("done"), *_usage_events(20, 5)]},
        ],
        tools=[_tool("webFetch")],
    )
    assert [e.kind for e in events] == [
        "step_start",
        "token",
        "token",
        "tool_input",
        "tool_output",
        "step_end",
        "step_start",
        "token",
        "step_end",
    ]
    assert [e.seq for e in events] == list(range(1, 10))
    assert [e.step for e in events] == [1, 1, 1, 1, 1, 1, 2, 2, 2]
    assert isinstance(events[1], TokenEvent) and events[1].channel == "reasoning"
    out = events[4]
    assert isinstance(out, ToolOutputEvent)
    assert (out.summary, out.output, out.is_error) == ("short", "full:x", False)
    assert isinstance(result.outcome, LoopSucceeded)
    assert result.text == "adone"
    assert result.tainted_by == "webFetch"
    (usage,) = result.usage
    assert (usage.provider, usage.model) == ("anthropic", "claude-test")
    # AG-UI accounting: cache reads are part of the input total.
    assert (usage.input_tokens, usage.output_tokens, usage.cached_input_tokens) == (34, 8, 4)


async def test_loop_failed_tool_emits_step_error_and_an_error_output() -> None:
    events, result = await _run(
        [{"tools": [{"id": "t1", "name": "bad", "input": {}}]}, {"events": [_text("ok")]}],
        tools=[_tool("bad", fail=True)],
    )
    kinds = [e.kind for e in events]
    assert kinds[:5] == ["step_start", "tool_input", "step_error", "tool_output", "step_end"]
    assert isinstance(events[2], StepErrorEvent) and events[2].message == "nope"
    out = events[3]
    assert isinstance(out, ToolOutputEvent) and out.is_error and out.summary == "nope"
    assert isinstance(result.outcome, LoopSucceeded)


async def test_loop_provider_error_leaves_the_step_open() -> None:
    events, result = await _run([{"events": [_text("a")], "raise": RuntimeError("429 slow down")}])
    assert [e.kind for e in events] == ["step_start", "token"]
    assert result.step_open
    assert result.outcome == LoopFailed(code="rate_limit", message="429 slow down")


async def test_loop_max_steps_is_a_max_steps_failure() -> None:
    _, result = await _run(
        [{"tools": [{"id": f"t{i}", "name": "echo", "input": {}}]} for i in range(2)],
        tools=[_tool("echo")],
        max_steps=2,
    )
    assert isinstance(result.outcome, LoopFailed)
    assert result.outcome.code == "max_steps"
    assert not result.step_open


async def test_usage_meter_merges_calls_per_model() -> None:
    meter = UsageMeter()
    meter.add_anthropic("a", {"input_tokens": 1, "output_tokens": 2})
    meter.add_anthropic("a", SimpleNamespace(input_tokens=3, output_tokens=4))
    meter.add_anthropic(
        "b", {"input_tokens": 5, "output_tokens": 6, "cache_creation_input_tokens": 1}
    )
    assert not meter.add_anthropic("c", {})
    a, b = meter.totals()
    assert (a.model, a.input_tokens, a.output_tokens) == ("a", 4, 6)
    assert (b.input_tokens, b.cache_write_input_tokens) == (6, 1)


def test_tool_output_full_text_is_never_written_to_the_log() -> None:
    ev = ToolOutputEvent(
        run_id="r",
        seq=1,
        step=1,
        created_at="t",
        tool_call_id="c",
        tool_name="webFetch",
        summary="Fetched X",
        output="<a whole page>",
    )
    assert event_to_row_payload(ev) == {
        "toolCallId": "c",
        "toolName": "webFetch",
        "summary": "Fetched X",
    }
