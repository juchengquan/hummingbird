"""Tool-loop tests for the Anthropic step-fn factory (Phase 2b-2).

These exercise the tool path end-to-end:

  - The step lists tool descriptors in the `stream(tools=...)` kwargs.
  - After the stream returns a `final_message` with a `tool_use` block,
    the step calls the descriptor's `execute`, appends both the
    assistant turn AND the user `tool_result` turn to the closed-over
    messages list, and returns `done=False` (so the runner loops).
  - On `done=True` second pass (no tool_use in the final content),
    settles.
  - Tool execution failures route to `tool_output` + `step_error` and
    feed an `is_error: true` tool_result back to the model.
  - Unknown tools (model hallucinated a name) handled the same way as
    failures — error fed back, run continues.

The Anthropic SDK is replaced wholesale by the `_FakeClient` from
`test_anthropic_provider.py`; tests stay hermetic and fast.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_py.emitter import RunEmitter
from agent_py.events import (
    StepErrorEvent,
    TaskEvent,
    ToolInputEvent,
    ToolOutputEvent,
)
from agent_py.providers.anthropic_provider import (
    AnthropicStepConfig,
    make_anthropic_step_fn,
)
from agent_py.runner import RunStepContext
from agent_py.tools.registry import (
    ToolDescriptor,
    ToolError,
    ToolInvocationResult,
)

from .test_anthropic_provider import _FakeClient


def _list_sink() -> tuple[list[TaskEvent], RunEmitter]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    emitter = RunEmitter(run_id="r1", sink=sink)
    return collected, emitter


def _build_tool(
    name: str,
    *,
    result: ToolInvocationResult | None = None,
    raise_with: BaseException | None = None,
    record_into: list[dict[str, Any]] | None = None,
) -> ToolDescriptor:
    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        if record_into is not None:
            record_into.append(dict(args))
        if raise_with is not None:
            raise raise_with
        assert result is not None
        return result

    return ToolDescriptor(
        name=name,
        description=f"test tool {name}",
        input_schema={"type": "object", "properties": {}, "additionalProperties": True},
        execute=execute,
    )


# --- Happy path: one tool call then a final text answer ----------------


@pytest.mark.asyncio
async def test_step_returns_not_done_on_tool_use_then_done_on_text() -> None:
    """First step: model emits a `tool_use` block → step runs the tool,
    appends both turns, returns `done=False`. Runner calls step again
    → second stream returns only text → step settles."""
    tool_calls: list[dict[str, Any]] = []
    tool = _build_tool(
        "webFetch",
        result=ToolInvocationResult(
            text="page body here",
            summary='Fetched "Example"',
        ),
        record_into=tool_calls,
    )
    client = _FakeClient(
        deltas=[],
        final_content_seq=[
            # First stream: model asks for a tool.
            [
                {
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "webFetch",
                    "input": {"url": "https://example.com"},
                },
            ],
            # Second stream: final text answer, no tool calls.
            [
                {"type": "text", "text": "Per the page, the answer is 42."},
            ],
        ],
    )
    collected, emitter = _list_sink()
    messages: list[dict[str, Any]] = [{"role": "user", "content": "fetch x"}]
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=messages,
            tools=[tool],
        )
    )

    await emitter.start_step()
    outcome1 = await step(RunStepContext(step=emitter.step, emitter=emitter))
    assert outcome1.done is False
    # Tool was called with the input the model emitted.
    assert tool_calls == [{"url": "https://example.com"}]
    # The step appended assistant + tool_result turns to messages.
    assert len(messages) == 3
    assert messages[1]["role"] == "assistant"
    assert messages[2]["role"] == "user"
    tool_result = messages[2]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result["tool_use_id"] == "tu_1"
    assert tool_result["content"] == "page body here"
    assert "is_error" not in tool_result

    # Second iteration: text-only final answer settles.
    await emitter.end_step()
    await emitter.start_step()
    outcome2 = await step(RunStepContext(step=emitter.step, emitter=emitter))
    assert outcome2.done is True

    # Event log: at minimum one tool_input + tool_output for the tool.
    tool_inputs = [e for e in collected if isinstance(e, ToolInputEvent)]
    tool_outputs = [e for e in collected if isinstance(e, ToolOutputEvent)]
    assert len(tool_inputs) == 1
    assert tool_inputs[0].tool_name == "webFetch"
    assert tool_inputs[0].args == {"url": "https://example.com"}
    assert len(tool_outputs) == 1
    assert tool_outputs[0].summary == 'Fetched "Example"'


@pytest.mark.asyncio
async def test_includes_tools_param_in_stream_kwargs() -> None:
    tool = _build_tool(
        "webFetch",
        result=ToolInvocationResult(text="x", summary="y"),
    )
    client = _FakeClient(deltas=["done"], final_content_seq=[[{"type": "text", "text": "done"}]])
    _, emitter = _list_sink()
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=[{"role": "user", "content": "hi"}],
            tools=[tool],
        )
    )
    await emitter.start_step()
    await step(RunStepContext(step=emitter.step, emitter=emitter))

    kw = client.messages.last_kwargs
    assert kw is not None
    tools_param = kw.get("tools")
    assert tools_param is not None
    assert isinstance(tools_param, list)
    assert tools_param[0]["name"] == "webFetch"
    assert tools_param[0]["description"].startswith("test tool")
    assert tools_param[0]["input_schema"]["type"] == "object"


@pytest.mark.asyncio
async def test_omits_tools_kwarg_when_no_tools_configured() -> None:
    """Empty tools list should NOT pass `tools=[]` to the SDK — Phase
    2b-1 parity. The Protocol's signature allows tools=None and the
    SDK costs nothing to skip the kwarg entirely."""
    client = _FakeClient(deltas=["x"])
    _, emitter = _list_sink()
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=[{"role": "user", "content": "hi"}],
        )
    )
    await emitter.start_step()
    await step(RunStepContext(step=emitter.step, emitter=emitter))
    kw = client.messages.last_kwargs
    assert kw is not None
    assert "tools" not in kw


# --- Failure paths -----------------------------------------------------


@pytest.mark.asyncio
async def test_tool_error_emits_step_error_and_feeds_error_to_model() -> None:
    tool = _build_tool(
        "webFetch",
        raise_with=ToolError("upstream 404"),
    )
    client = _FakeClient(
        deltas=[],
        final_content_seq=[
            [
                {
                    "type": "tool_use",
                    "id": "tu_err",
                    "name": "webFetch",
                    "input": {"url": "https://missing.example"},
                },
            ],
            [{"type": "text", "text": "moved on"}],
        ],
    )
    collected, emitter = _list_sink()
    messages: list[dict[str, Any]] = [{"role": "user", "content": "fetch x"}]
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=messages,
            tools=[tool],
        )
    )
    await emitter.start_step()
    outcome = await step(RunStepContext(step=emitter.step, emitter=emitter))
    assert outcome.done is False

    # `step_error` event emitted alongside the `tool_output`.
    step_errors = [e for e in collected if isinstance(e, StepErrorEvent)]
    assert len(step_errors) == 1
    assert "upstream 404" in step_errors[0].message
    assert step_errors[0].will_retry is True

    # The tool_result fed back to the model carries is_error: True.
    tool_result = messages[2]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result.get("is_error") is True
    assert "upstream 404" in tool_result["content"]


@pytest.mark.asyncio
async def test_unknown_tool_handled_like_an_error() -> None:
    """If the model hallucinates a tool name we don't know, we emit
    a step_error + tool_output with the missing-tool message and feed
    the error back as a tool_result so the model can recover next
    step."""
    tool = _build_tool(
        "webFetch",
        result=ToolInvocationResult(text="x", summary="y"),
    )
    client = _FakeClient(
        deltas=[],
        final_content_seq=[
            [
                {
                    "type": "tool_use",
                    "id": "tu_ghost",
                    "name": "ghostTool",
                    "input": {},
                },
            ],
            [{"type": "text", "text": "ok"}],
        ],
    )
    collected, emitter = _list_sink()
    messages: list[dict[str, Any]] = [{"role": "user", "content": "go"}]
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=messages,
            tools=[tool],
        )
    )
    await emitter.start_step()
    outcome = await step(RunStepContext(step=emitter.step, emitter=emitter))
    assert outcome.done is False

    step_errors = [e for e in collected if isinstance(e, StepErrorEvent)]
    assert len(step_errors) == 1
    assert "ghostTool" in step_errors[0].message

    tool_outputs = [e for e in collected if isinstance(e, ToolOutputEvent)]
    assert len(tool_outputs) == 1
    assert tool_outputs[0].tool_name == "ghostTool"

    tool_result = messages[2]["content"][0]
    assert tool_result.get("is_error") is True


@pytest.mark.asyncio
async def test_unexpected_exception_wrapped_not_propagated() -> None:
    """An unexpected exception from a tool (not a ToolError) is caught,
    logged, and fed back as a generic error tool_result — the run
    continues. We don't want one flaky tool to fail an entire long-
    running task."""
    tool = _build_tool(
        "webFetch",
        raise_with=ValueError("internal blow-up"),
    )
    client = _FakeClient(
        deltas=[],
        final_content_seq=[
            [
                {
                    "type": "tool_use",
                    "id": "tu_x",
                    "name": "webFetch",
                    "input": {"url": "https://x"},
                },
            ],
            [{"type": "text", "text": "ok"}],
        ],
    )
    collected, emitter = _list_sink()
    messages: list[dict[str, Any]] = [{"role": "user", "content": "go"}]
    step = make_anthropic_step_fn(
        AnthropicStepConfig(
            client=client,
            model="claude-sonnet-4-6",
            system=None,
            messages=messages,
            tools=[tool],
        )
    )
    await emitter.start_step()
    outcome = await step(RunStepContext(step=emitter.step, emitter=emitter))
    # Exception was caught — step continues (returns not-done).
    assert outcome.done is False
    step_errors = [e for e in collected if isinstance(e, StepErrorEvent)]
    assert len(step_errors) == 1
    # We don't leak the raw exception message — we use the class name
    # for a generic surface.
    assert "ValueError" in step_errors[0].message
    tool_result = messages[2]["content"][0]
    assert tool_result.get("is_error") is True
