"""Phase 4-3 tests — tool-enabled streaming in `/v1/chat`.

Covers both wire formats (`chat_stream_with_tools` for the custom
shape, `chat_stream_with_tools_ai_sdk` for AI SDK v5). The Anthropic
SDK is faked at the boundary so tests stay hermetic and the multi-step
loop can be exercised deterministically.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from agent_py.chat import (
    ChatConfig,
    ChatMessage,
    chat_stream_with_tools,
    chat_stream_with_tools_ai_sdk,
)
from agent_py.tools.registry import (
    ToolDescriptor,
    ToolError,
    ToolInvocationResult,
)

# --- fakes -----------------------------------------------------------


class _Step:
    """One iteration of the `messages.stream` loop. `deltas` are the
    text the model emits this step; `tool_uses` are the `tool_use`
    blocks captured in `final_message.content`. Final step has empty
    `tool_uses` so the loop terminates."""

    def __init__(
        self,
        *,
        deltas: list[str] | None = None,
        tool_uses: list[dict[str, Any]] | None = None,
        raises: Exception | None = None,
    ) -> None:
        self.deltas = deltas or []
        self.tool_uses = tool_uses or []
        self.raises = raises


def _text_event(text: str) -> SimpleNamespace:
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="text_delta", text=text),
    )


class _FakeStream:
    def __init__(self, step: _Step) -> None:
        self._step = step

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        return self._iter_events()

    async def _iter_events(self) -> AsyncIterator[SimpleNamespace]:
        if self._step.raises is not None:
            raise self._step.raises
        for d in self._step.deltas:
            yield _text_event(d)

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter_text()

    async def _iter_text(self) -> AsyncIterator[str]:
        # Back-compat; not used by the production code anymore.
        if self._step.raises is not None:
            raise self._step.raises
        for d in self._step.deltas:
            yield d

    async def get_final_message(self) -> dict[str, Any]:
        content: list[dict[str, Any]] = []
        # Text blocks first, then tool_use blocks — mirrors the
        # Anthropic SDK's typical content ordering.
        for d in self._step.deltas:
            content.append({"type": "text", "text": d})
        for tu in self._step.tool_uses:
            content.append({"type": "tool_use", **tu})
        return {"content": content}


class _FakeMessages:
    def __init__(self, steps: list[_Step]) -> None:
        self._steps = list(steps)
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> _FakeStream:
        # Snapshot the kwargs at call time. The route reuses the same
        # `messages` list across iterations and mutates it in place,
        # so a shallow copy of the dict isn't enough — we need a
        # snapshot of the list and its current entries so assertions
        # can compare per-iteration state.
        snapshot = dict(kwargs)
        if "messages" in snapshot:
            snapshot["messages"] = [dict(m) for m in snapshot["messages"]]
        self.calls.append(snapshot)
        if not self._steps:
            return _FakeStream(_Step())
        return _FakeStream(self._steps.pop(0))


class _FakeClient:
    def __init__(self, steps: list[_Step]) -> None:
        self.messages = _FakeMessages(steps)


def _config(*, tools: list[ToolDescriptor], max_steps: int = 6) -> ChatConfig:
    return ChatConfig(
        model="claude-3-5-sonnet-20241022",
        messages=[ChatMessage(role="user", content="hi")],
        tools=tuple(tools),
        max_steps=max_steps,
    )


def _make_echo_tool(name: str = "echo") -> ToolDescriptor:
    """Build a no-arg ToolDescriptor whose execute returns a fixed
    `ToolInvocationResult`. Tests patch the descriptor's execute via
    a fresh AsyncMock when they need to assert on the call."""

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        return ToolInvocationResult(text=f"echo:{args.get('q', '')}", summary="echoed")

    return ToolDescriptor(
        name=name,
        description="echo back",
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
        execute=execute,
    )


def _parse_custom_frames(frames: list[str]) -> list[Any]:
    return [json.loads(f.removeprefix("data: ").rstrip()) for f in frames]


def _parse_ai_sdk_frames(frames: list[str]) -> list[Any]:
    out: list[Any] = []
    for f in frames:
        s = f.removeprefix("data: ").rstrip()
        if s == "[DONE]":
            out.append("[DONE]")
        else:
            out.append(json.loads(s))
    return out


# --- custom-format tool stream ----------------------------------------


@pytest.mark.asyncio
async def test_with_tools_custom_runs_one_tool_then_settles() -> None:
    """Step 1: model emits a tool_use. Step 2: model emits final text
    + no tools. Output sequence: text-pre? + tool_call + tool_result +
    text + done."""
    steps = [
        _Step(
            deltas=["thinking… "],
            tool_uses=[{"id": "tu_1", "name": "echo", "input": {"q": "world"}}],
        ),
        _Step(deltas=["Hello, world."]),
    ]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    payloads = _parse_custom_frames(frames)
    types = [p["type"] for p in payloads]
    assert types == [
        "text",
        "tool_call",
        "tool_result",
        "text",
        "done",
    ]
    assert payloads[0]["value"] == "thinking… "
    assert payloads[1] == {
        "type": "tool_call",
        "id": "tu_1",
        "name": "echo",
        "args": {"q": "world"},
    }
    assert payloads[2]["result"] == "echo:world"
    assert payloads[2]["summary"] == "echoed"
    assert payloads[2]["isError"] is False
    assert payloads[3]["value"] == "Hello, world."


@pytest.mark.asyncio
async def test_with_tools_custom_no_tool_calls_settles_first_iteration() -> None:
    """If the model produces a text-only response on the first try,
    we emit text + done immediately (no extra step)."""
    client = _FakeClient([_Step(deltas=["just text"])])
    frames = [
        f
        async for f in chat_stream_with_tools(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    types = [json.loads(f.removeprefix("data: ").rstrip())["type"] for f in frames]
    assert types == ["text", "done"]


@pytest.mark.asyncio
async def test_with_tools_unknown_tool_returns_is_error() -> None:
    """Model calls a tool the registry doesn't have. We return an
    is_error tool_result and let the model recover."""
    steps = [
        _Step(
            deltas=[],
            tool_uses=[{"id": "tu_1", "name": "ghost", "input": {}}],
        ),
        _Step(deltas=["sorry"]),
    ]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    payloads = _parse_custom_frames(frames)
    tr = next(p for p in payloads if p["type"] == "tool_result")
    assert tr["isError"] is True
    assert "unknown tool" in tr["result"]


@pytest.mark.asyncio
async def test_with_tools_tool_error_propagates_as_is_error() -> None:
    """A tool's execute raising ToolError → is_error tool_result with
    the error message in `result`."""
    failing = ToolDescriptor(
        name="bad",
        description="d",
        input_schema={"type": "object"},
        execute=AsyncMock(side_effect=ToolError("boom")),
    )
    steps = [
        _Step(tool_uses=[{"id": "tu_1", "name": "bad", "input": {}}]),
        _Step(deltas=["ok"]),
    ]
    client = _FakeClient(steps)
    frames = [
        f async for f in chat_stream_with_tools(client=client, config=_config(tools=[failing]))
    ]
    payloads = _parse_custom_frames(frames)
    tr = next(p for p in payloads if p["type"] == "tool_result")
    assert tr["isError"] is True
    assert "boom" in tr["result"]


@pytest.mark.asyncio
async def test_with_tools_max_steps_emits_error_frame() -> None:
    """If the model keeps calling tools past max_steps, emit an
    error frame with `code: max_steps` so the client can surface a
    "budget exhausted" message."""
    # Three steps but max_steps=2 — the loop should bail with an error.
    steps = [_Step(tool_uses=[{"id": f"tu_{i}", "name": "echo", "input": {}}]) for i in range(5)]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools(
            client=client, config=_config(tools=[_make_echo_tool()], max_steps=2)
        )
    ]
    payloads = _parse_custom_frames(frames)
    last = payloads[-1]
    assert last["type"] == "error"
    assert last["code"] == "max_steps"


@pytest.mark.asyncio
async def test_with_tools_messages_grow_across_iterations() -> None:
    """Each iteration's `messages.stream` call gets a longer message
    list (assistant + tool_result blocks appended) — confirms the
    loop carries history forward."""
    steps = [
        _Step(tool_uses=[{"id": "tu_1", "name": "echo", "input": {"q": "x"}}]),
        _Step(deltas=["done"]),
    ]
    client = _FakeClient(steps)
    _ = [
        f
        async for f in chat_stream_with_tools(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    # First call: 1 user message. Second call: 3 (user + assistant + user-tool-result).
    call_lens = [len(c["messages"]) for c in client.messages.calls]
    assert call_lens == [1, 3]


@pytest.mark.asyncio
async def test_with_tools_upstream_exception_emits_error_frame() -> None:
    """Anthropic SDK raises mid-stream → emit error + stop (no done)."""
    steps = [_Step(raises=RuntimeError("rate limited"))]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    payloads = _parse_custom_frames(frames)
    assert len(payloads) == 1
    assert payloads[0]["type"] == "error"
    assert "rate limited" in payloads[0]["message"]


# --- ai-sdk format tool stream ----------------------------------------


@pytest.mark.asyncio
async def test_with_tools_ai_sdk_runs_one_tool_lifecycle() -> None:
    """Two-step run: text-start/-delta/-end + tool-input + tool-output
    + finish-step in step 1; text-start/-delta/-end + finish-step +
    finish + [DONE] in step 2."""
    steps = [
        _Step(
            deltas=["thinking "],
            tool_uses=[{"id": "tu_1", "name": "echo", "input": {"q": "world"}}],
        ),
        _Step(deltas=["Hello."]),
    ]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools_ai_sdk(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    assert types == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "tool-input-available",
        "tool-output-available",
        "finish-step",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
        "[DONE]",
    ]
    # `output` carries the tool result text.
    tool_output = next(
        p for p in payloads if isinstance(p, dict) and p["type"] == "tool-output-available"
    )
    assert tool_output["output"] == "echo:world"
    assert "errorText" not in tool_output


@pytest.mark.asyncio
async def test_with_tools_ai_sdk_tool_error_rides_in_error_text() -> None:
    """Failed tool → tool-output-available with both `output` and
    `errorText` set so the SDK consumer can surface a per-call
    error."""
    failing = ToolDescriptor(
        name="bad",
        description="d",
        input_schema={"type": "object"},
        execute=AsyncMock(side_effect=ToolError("boom")),
    )
    steps = [
        _Step(tool_uses=[{"id": "tu_1", "name": "bad", "input": {}}]),
        _Step(deltas=["ok"]),
    ]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools_ai_sdk(client=client, config=_config(tools=[failing]))
    ]
    payloads = _parse_ai_sdk_frames(frames)
    tool_output = next(
        p for p in payloads if isinstance(p, dict) and p["type"] == "tool-output-available"
    )
    assert tool_output["errorText"] == "boom"


@pytest.mark.asyncio
async def test_with_tools_ai_sdk_max_steps_emits_error_no_finish() -> None:
    """Step budget exhausted → error + [DONE], no finish frame.
    Mirrors the AI SDK convention: `finish` is reserved for clean
    completion."""
    steps = [_Step(tool_uses=[{"id": f"tu_{i}", "name": "echo", "input": {}}]) for i in range(5)]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools_ai_sdk(
            client=client, config=_config(tools=[_make_echo_tool()], max_steps=2)
        )
    ]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    assert "finish" not in types
    assert types[-1] == "[DONE]"
    assert types[-2] == "error"
    err = payloads[-2]
    assert "iterations" in err["errorText"]


@pytest.mark.asyncio
async def test_with_tools_ai_sdk_upstream_exception_closes_text_then_error() -> None:
    """Anthropic SDK raises mid-stream → emit text-end (closing the
    open block) + error + [DONE]. No finish-step / finish."""
    steps = [_Step(raises=RuntimeError("rate limited"))]
    client = _FakeClient(steps)
    frames = [
        f
        async for f in chat_stream_with_tools_ai_sdk(
            client=client, config=_config(tools=[_make_echo_tool()])
        )
    ]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    # Pre-delta error: no text-start/text-end emitted (channels open
    # lazily on the first delta). Matches agent-ts's
    # `chatStreamAiSdk` and the text-only `chat_stream_ai_sdk` path.
    assert types == [
        "start",
        "start-step",
        "error",
        "[DONE]",
    ]
