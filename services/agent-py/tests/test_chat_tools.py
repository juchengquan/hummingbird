"""The agent loop's tool path: memory taint and tool-made images.

Drives `chat_loop.run_turn_loop` with tools against a faked Anthropic
SDK, so the multi-step loop runs deterministically. (The AI SDK frame
tests of `/v1/chat` went with that route in wave 13, Q121; the loop's
tool lifecycle, tool errors and step budget are pinned at the event level
in `test_chat_events.py`.)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

from agent_py.chat_loop import LoopResult, LoopSucceeded, run_turn_loop
from agent_py.emitter import RunEmitter
from agent_py.events import TaskEvent, ToolImageEvent, ToolOutputEvent
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

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


async def _run(
    tools: list[ToolDescriptor], steps: list[_Step]
) -> tuple[list[TaskEvent], LoopResult]:
    events: list[TaskEvent] = []

    async def sink(e: TaskEvent) -> None:
        events.append(e)

    result = await run_turn_loop(
        client=_FakeClient(steps),  # type: ignore[arg-type]
        emitter=RunEmitter(run_id="r", sink=sink),
        model="claude-test",
        messages=[{"role": "user", "content": "hi"}],
        tools=tools,
    )
    return events, result


# --- memory taint ------------------------------------------------------------


async def _tainted_by(tools: list[ToolDescriptor], tool_uses: list[dict[str, Any]]) -> str | None:
    steps = (
        [_Step(tool_uses=tool_uses), _Step(deltas=["done"])]
        if tool_uses
        else [_Step(deltas=["hi"])]
    )
    _, result = await _run(tools, steps)
    assert isinstance(result.outcome, LoopSucceeded)
    return result.tainted_by


async def test_untrusted_tool_marks_the_turn_memory_tainted() -> None:
    """A web/file/MCP tool ran → the run's result is memory-tainted (the
    client skips memory extraction for it)."""
    tainted = await _tainted_by(
        [_make_echo_tool("webFetch")], [{"id": "tu_1", "name": "webFetch", "input": {}}]
    )
    assert tainted == "webFetch"


async def test_unknown_or_new_tools_taint_by_default() -> None:
    tainted = await _tainted_by(
        [_make_echo_tool("mcp__notion__search")],
        [{"id": "tu_1", "name": "mcp__notion__search", "input": {}}],
    )
    assert tainted == "mcp__notion__search"


async def test_trusted_tool_and_tool_free_turns_are_not_tainted() -> None:
    assert (
        await _tainted_by(
            [_make_echo_tool("generateImage")],
            [{"id": "tu_1", "name": "generateImage", "input": {}}],
        )
        is None
    )
    assert await _tainted_by([_make_echo_tool("webFetch")], []) is None


# --- tool-made images ---------------------------------------------------------


async def test_generated_images_follow_the_tool_output_as_a_tool_image_event() -> None:
    """A tool that returns images (`generateImage`) is followed by a
    `tool_image` event for the same tool call, ids derived from it."""

    async def execute(_args: dict[str, Any]) -> ToolInvocationResult:
        return ToolInvocationResult(
            text="Generated 1 image",
            summary="1 image (t2i)",
            images=(
                {"url": "https://m/a.png", "width": 0, "height": 0, "format": "png", "prompt": "p"},
            ),
        )

    gen = ToolDescriptor(
        name="generateImage", description="", input_schema={"type": "object"}, execute=execute
    )
    events, _ = await _run(
        [gen],
        [
            _Step(tool_uses=[{"id": "tu_1", "name": "generateImage", "input": {"prompt": "p"}}]),
            _Step(deltas=["Here."]),
        ],
    )
    i = next(n for n, e in enumerate(events) if isinstance(e, ToolOutputEvent))
    image = events[i + 1]
    assert isinstance(image, ToolImageEvent)
    assert (image.tool_call_id, image.mode) == ("tu_1", "t2i")
    assert list(image.images) == [
        {
            "id": "tu_1-0",
            "url": "https://m/a.png",
            "width": 0,
            "height": 0,
            "format": "png",
            "prompt": "p",
            "mode": "t2i",
        }
    ]
