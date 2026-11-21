"""Wave 3b-C — chat emits internal events, `/v1/chat` translates them.

`chat_loop.run_turn_loop` is the agent loop; it emits the run model's
internal events. `chat.AiSdkFrameTranslator` turns them back into the
AI SDK frames `/v1/chat` has always sent. The wire-level tests in
`test_chat.py` / `test_chat_tools.py` / `test_chat_route.py` pin the
frames; these pin the events and the translator's mapping.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest

from agent_py.chat import AiSdkFrameTranslator, ChatConfig, ChatMessage, chat_stream_ai_sdk
from agent_py.chat_loop import (
    LoopFailed,
    LoopSucceeded,
    UsageMeter,
    run_turn_loop,
)
from agent_py.emitter import RunEmitter
from agent_py.events import (
    CodeResultEvent,
    McpAppEvent,
    PlanEvent,
    PlanItem,
    RoutedModelEvent,
    StepErrorEvent,
    SuggestionsEvent,
    TaskEvent,
    TokenEvent,
    ToolFileEvent,
    ToolImageEvent,
    ToolOutputEvent,
    UiPartEvent,
    VerificationEvent,
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
    assert result.outcome == LoopFailed(
        code="rate_limit", message="429 slow down", wire_code="rate_limit"
    )


async def test_loop_max_steps_is_a_max_steps_failure_but_upstream_on_the_wire() -> None:
    _, result = await _run(
        [{"tools": [{"id": f"t{i}", "name": "echo", "input": {}}]} for i in range(2)],
        tools=[_tool("echo")],
        max_steps=2,
    )
    assert isinstance(result.outcome, LoopFailed)
    assert (result.outcome.code, result.outcome.wire_code) == ("max_steps", "upstream")
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


# --- the translator -------------------------------------------------------------------


def _ev(cls: type[Any], **fields: Any) -> Any:
    return cls(run_id="r", seq=1, step=1, created_at="t", **fields)


def _frames(t: AiSdkFrameTranslator, *events: Any) -> list[dict[str, Any]]:
    out: list[str] = []
    for e in events:
        out.extend(t.event(e))
    return [json.loads(f.removeprefix("data: ")) for f in out]


def test_translator_maps_part_events_to_todays_data_frames() -> None:
    t = AiSdkFrameTranslator()
    frames = _frames(
        t,
        _ev(ToolImageEvent, tool_call_id="c", mode="t2i", images=({"id": "i"},)),
        _ev(ToolFileEvent, tool_call_id="c", files=({"id": "f"},)),
        _ev(CodeResultEvent, tool_call_id="c", stdout="o", stderr="e", results=()),
        _ev(UiPartEvent, tool_call_id="c", ui_kind="confirm", props={"a": 1}),
        _ev(McpAppEvent, tool_call_id="c", server_id="s", html="<p>", truncated=True),
        _ev(SuggestionsEvent, values=("x", "y")),
        _ev(VerificationEvent, verification={"checks": [], "summary": {}}),
        _ev(RoutedModelEvent, model="m"),
        _ev(PlanEvent, items=(PlanItem(id="1", text="t", status="pending"),)),
    )
    assert frames == [
        {
            "type": "data-tool-image",
            "id": "c",
            "data": {"id": "c", "mode": "t2i", "images": [{"id": "i"}]},
        },
        {"type": "data-tool-file", "id": "c", "data": {"id": "c", "files": [{"id": "f"}]}},
        {
            "type": "data-code-result",
            "id": "c",
            "data": {"id": "c", "stdout": "o", "stderr": "e", "results": []},
        },
        {"type": "data-ui", "id": "c", "data": {"id": "c", "kind": "confirm", "props": {"a": 1}}},
        {
            "type": "data-mcp-app",
            "id": "c",
            "data": {"id": "c", "serverId": "s", "html": "<p>", "truncated": True},
        },
        {"type": "data-suggestions", "data": {"values": ["x", "y"]}},
        {"type": "data-verification", "data": {"checks": [], "summary": {}}},
        {"type": "data-routed-model", "data": {"model": "m"}},
    ]


def test_translator_block_rule_any_non_token_event_closes_the_open_block() -> None:
    ids = (f"b{i}" for i in itertools.count())
    t = AiSdkFrameTranslator(new_id=lambda: next(ids))
    frames = _frames(
        t,
        _ev(TokenEvent, text="a"),
        _ev(TokenEvent, text=""),  # empty: nothing, closes nothing
        _ev(TokenEvent, text="r", channel="reasoning"),
        _ev(StepErrorEvent, message="x"),  # no frame, still closes
        _ev(TokenEvent, text="b"),
    )
    assert frames == [
        {"type": "text-start", "id": "b0"},
        {"type": "text-delta", "id": "b0", "delta": "a"},
        {"type": "text-end", "id": "b0"},
        {"type": "reasoning-start", "id": "b1"},
        {"type": "reasoning-delta", "id": "b1", "delta": "r"},
        {"type": "reasoning-end", "id": "b1"},
        {"type": "text-start", "id": "b2"},
        {"type": "text-delta", "id": "b2", "delta": "b"},
    ]
    closing = t.failed(message="boom", code="upstream")
    assert closing == [
        'data: {"type":"text-end","id":"b2"}\n\n',
        'data: {"type":"error","errorText":"boom","code":"upstream"}\n\n',
        "data: [DONE]\n\n",
    ]


def test_translator_tool_output_without_full_text_falls_back_to_summary() -> None:
    t = AiSdkFrameTranslator()
    (frame,) = _frames(
        t,
        _ev(ToolOutputEvent, tool_call_id="c", tool_name="x", summary="oops", is_error=True),
    )
    assert frame == {
        "type": "tool-output-available",
        "toolCallId": "c",
        "output": "oops",
        "errorText": "oops",
    }


async def test_suggest_hook_becomes_a_data_suggestions_frame_before_finish_step() -> None:
    async def suggest(text: str) -> list[str]:
        assert text == "Hello"
        return ["Why?"]

    config = ChatConfig(model="m", messages=[ChatMessage(role="user", content="hi")])
    frames = [
        f
        async for f in chat_stream_ai_sdk(
            client=_Client([{"events": [_text("Hello")]}]),  # type: ignore[arg-type]
            config=config,
            suggest=suggest,
        )
    ]
    assert frames[-4:] == [
        'data: {"type":"data-suggestions","data":{"values":["Why?"]}}\n\n',
        'data: {"type":"finish-step"}\n\n',
        'data: {"type":"finish"}\n\n',
        "data: [DONE]\n\n",
    ]


async def test_closing_the_stream_cancels_the_loop_task() -> None:
    """The route closes the generator when the client hangs up or the
    idle watchdog fires; the loop task (and its provider stream) must go
    with it."""
    cancelled = asyncio.Event()

    class _Hanging:
        async def __aenter__(self) -> _Hanging:
            return self

        async def __aexit__(self, *args: Any) -> None:
            cancelled.set()

        def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
            return self._iter()

        async def _iter(self) -> AsyncIterator[SimpleNamespace]:
            yield _text("hello")
            await asyncio.sleep(60)

    class _Client2:
        class messages:
            @staticmethod
            def stream(**_kw: Any) -> _Hanging:
                return _Hanging()

    config = ChatConfig(model="m", messages=[ChatMessage(role="user", content="hi")])
    gen = chat_stream_ai_sdk(client=_Client2(), config=config)  # type: ignore[arg-type]
    seen = [await gen.__anext__() for _ in range(4)]  # start, start-step, text-start, delta
    assert '"text-delta"' in seen[-1]
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(gen.__anext__(), timeout=0.05)
    await asyncio.wait_for(cancelled.wait(), timeout=1)
