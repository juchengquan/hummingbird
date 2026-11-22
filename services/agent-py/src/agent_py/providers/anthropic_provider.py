"""Anthropic streaming step-fn factory.

Mirror of `makeStreamTextStep` in `lib/server/agent/runner.ts`. Phase
2b-1 shipped text-only streaming; Phase 2b-2 adds tool support:

  - The step lists tool descriptors when calling `messages.stream`.
  - Text deltas stream through a coalescer (~96 chars per flush) into
    the emitter, same as Phase 2b-1.
  - After the stream ends, we walk `final_message().content` for
    `tool_use` blocks. For each one we emit `tool_input`, run the
    tool, emit `tool_output`, and append the result message to the
    closed-over `messages` list so the next step sees it.
  - The step returns `done=True` when `stop_reason == 'end_turn'`
    (the model produced a final answer) and `done=False` on
    `'tool_use'` (we ran tools, model needs another turn). The
    runner's existing loop handles the iteration.

The factory takes an `AsyncClient` protocol so tests can swap a fake
that yields canned events without hitting the network. The default
`AsyncAnthropic` from the SDK satisfies the protocol.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol

import structlog

from .. import lease, tool_ledger, tool_turn
from ..coalescer import make_token_coalescer
from ..emitter import RunEmitter
from ..reasoning_effort import ThinkingParams
from ..runner import (
    PendingInputDescriptor,
    RunStepContext,
    RunStepFn,
    RunStepOutcome,
    SpawnDescriptor,
)
from ..tools import (
    ToolDescriptor,
    ToolError,
    tool_to_anthropic_param,
)
from ..tools.spawn_subagent import parse_spawn_specs

logger = structlog.get_logger(__name__)


class _AnthropicStream(Protocol):
    """The streaming reader. The real SDK exposes more
    (`until_done()`, etc.); we only need the typed text iterator and
    the final-message accessor for tool blocks."""

    @property
    def text_stream(self) -> AsyncIterator[str]: ...

    async def get_final_message(self) -> Any: ...


class _AnthropicStreamCtx(Protocol):
    """Async-context-manager surface a streaming call returns —
    `async with client.messages.stream(...) as stream:`. The SDK's
    actual return type is a private subclass of this shape; the
    Protocol lets fakes implement only the bits we touch."""

    async def __aenter__(self) -> _AnthropicStream: ...
    async def __aexit__(self, *exc: object) -> None: ...


class _AnthropicMessages(Protocol):
    """`client.messages` — only `.stream(...)` is used here. The SDK
    accepts many kwargs; the Protocol types only what we pass."""

    def stream(
        self,
        *,
        model: str,
        max_tokens: int,
        system: str | None,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> _AnthropicStreamCtx: ...


class AsyncAnthropicClient(Protocol):
    """The slice of the Anthropic SDK this module depends on. Real:
    `from anthropic import AsyncAnthropic`. Fake: any object exposing
    `messages.stream`."""

    @property
    def messages(self) -> _AnthropicMessages: ...


# --- Public API ----------------------------------------------------------

DEFAULT_MAX_TOKENS = 4096


@dataclass(frozen=False)
class AnthropicStepConfig:
    """All inputs the step fn closes over.

    `messages` is mutated in place by the step fn — when the model
    calls tools, we append the assistant turn + tool_result turns so
    the next step (runner re-invokes us) has them.

    `tools` is the descriptors the model is allowed to call this run.
    Empty list = text-only, same as Phase 2b-1 behaviour (the step
    settles on first call). The factory's `tools=None` shortcut omits
    the `tools` kwarg entirely so the SDK doesn't pay for an empty
    tools array.
    """

    client: AsyncAnthropicClient
    model: str
    system: str | None
    messages: list[dict[str, Any]]
    tools: list[ToolDescriptor] = field(default_factory=list)
    # Set of tool names that require human approval before they run.
    # When the model emits a `tool_use` block for one of these the
    # step fn captures it as a `pending_input` and returns without
    # executing. The runner returns `kind="suspended"`; the executor
    # saves the checkpoint and emits the approval request. Set
    # source: `checkpoint.config.requireApprovalFor` from the TS
    # route + the always-gated `askUser` tool name when it lands.
    gated_tool_names: set[str] = field(default_factory=set)
    max_tokens: int = DEFAULT_MAX_TOKENS
    # Extended thinking for the run's reasoning tier
    # (`reasoning_effort.thinking_params`), sent on every call that may
    # think (`_turn_can_think`) with `max_tokens` raised to fit it.
    thinking: ThinkingParams | None = None


def make_anthropic_step_fn(config: AnthropicStepConfig) -> RunStepFn:
    """Build a `RunStepFn` bound to one run's config.

    Each invocation runs **one** `messages.stream` call: it streams
    text deltas through a coalescer into the emitter, walks the final
    message for any `tool_use` blocks, invokes each, and appends the
    assistant + tool_result messages so the runner's next iteration
    continues the conversation. Returns `done=True` only when the
    model produced a final answer (no tool calls in the response).
    """

    tools_param = [tool_to_anthropic_param(t) for t in config.tools] if config.tools else None
    tools_by_name = {t.name: t for t in config.tools}

    async def run_step(ctx: RunStepContext) -> RunStepOutcome:
        async def emit_token(text: str, *, channel: str) -> None:
            if channel == "text":
                await ctx.emitter.token(text, channel="text")
            else:
                await ctx.emitter.token(text, channel="reasoning")

        coalescer = make_token_coalescer(emit_token)

        kwargs: dict[str, Any] = {
            "model": config.model,
            "max_tokens": config.max_tokens,
            "system": config.system,
            "messages": config.messages,
        }
        if tools_param is not None:
            kwargs["tools"] = tools_param
        if config.thinking is not None and _turn_can_think(config.messages):
            kwargs["thinking"] = config.thinking.thinking
            kwargs["max_tokens"] = max(config.max_tokens, config.thinking.max_tokens)
        stream_ctx = config.client.messages.stream(**kwargs)

        try:
            async with stream_ctx as stream:
                async for delta in stream.text_stream:
                    await coalescer.push("text", delta)
                final_message = await stream.get_final_message()
        finally:
            # Always flush whatever's buffered, even if the stream
            # raised mid-flight — partial output is better than dropped
            # text in `task_events`. The exception still propagates;
            # the runner wraps it as `result: failed`.
            await coalescer.flush_all()

        # Walk the final message's content blocks. `tool_use` blocks
        # tell us which tools to invoke; `text` blocks are already
        # streamed via `text_stream` above so we don't re-emit them.
        content_blocks = _coerce_content_blocks(final_message)
        tool_use_blocks = [b for b in content_blocks if _block_type(b) == "tool_use"]

        if not tool_use_blocks:
            # No tools requested — the model's done. Append the
            # assistant turn so a downstream continuation (HITL resume)
            # has the full history, then settle.
            config.messages.append({"role": "assistant", "content": content_blocks})
            return RunStepOutcome(done=True)

        # Tools requested. Every call gets exactly one result (`tool_turn`):
        # the ungated ones run now — each once, whatever else the turn
        # holds — and their results wait in the ledger (checkpointed, so a
        # pause or a crash keeps them) for the calls that need the user or
        # sub-agents. The turn is saved before any call runs: a worker
        # death never asks the model for it again, and a run cancelled
        # during the model call runs nothing.
        config.messages.append({"role": "assistant", "content": content_blocks})
        calls = tool_turn.calls_of(tool_use_blocks)
        ask, spawns = tool_turn.classify(calls, config.gated_tool_names)
        for call in calls:
            await ctx.emitter.tool_input(
                tool_call_id=call.id, tool_name=call.name, args=dict(call.args)
            )
        ledger = tool_ledger.current()
        if ledger is not None:
            await ledger.record_turn(ask=ask, spawn=spawns)

        ran: list[dict[str, Any]] = []
        for call in calls:
            if call.id in ask or call.id in spawns:
                continue
            await execute_tool_call(
                ctx.emitter,
                tools_by_name.get(call.name),
                tool_call_id=call.id,
                tool_name=call.name,
                args=call.args,
                results=ran,
            )

        # The questions first, one at a time in call order, then the spawns.
        for call in calls:
            if call.id in ask:
                return RunStepOutcome(
                    done=False,
                    pending_input=PendingInputDescriptor(
                        tool_call_id=call.id, tool=call.name, args=dict(call.args)
                    ),
                )
        for call in calls:
            if call.id in spawns:
                return RunStepOutcome(
                    done=False,
                    spawn=SpawnDescriptor(tool_call_id=call.id, tasks=parse_spawn_specs(call.args)),
                )

        config.messages.append({"role": "user", "content": ran})
        if ledger is not None:
            ledger.reset()

        # Model still needs to respond after seeing the tool results.
        # The runner's loop will call us again.
        return RunStepOutcome(done=False)

    return run_step


# --- tool execution ------------------------------------------------------


async def execute_tool_call(
    emitter: RunEmitter,
    descriptor: ToolDescriptor | None,
    *,
    tool_call_id: str,
    tool_name: str,
    args: dict[str, Any],
    results: list[dict[str, Any]],
    approved: bool = False,
) -> None:
    """Run one tool call: emit its `tool_output` (plus a `step_error`
    on failure) and append its `tool_result` block to `results`.

    With a bound ledger every result is checkpointed (`record_finished`),
    so a finished call never runs again. A side-effecting tool (see
    `tool_ledger`; `approved`: the user approved this very call, which
    makes it one whatever the gates say now) is also marked before it
    runs (`record_started`) — so a worker that dies mid-execution leaves a
    checkpoint saying so, and the reclaimed run does not run it again.
    Shared by the step fn and the executor's turn resolution."""
    ledger = tool_ledger.current()
    if descriptor is None:
        msg = (
            f'Approved, but the tool "{tool_name}" is not available for this run any more; '
            "it did not run."
            if approved
            else f"unknown tool: {tool_name}"
        )
        await emitter.step_error(msg, will_retry=True)
        await emitter.tool_output(tool_call_id=tool_call_id, tool_name=tool_name, summary=msg)
        results.append(_make_tool_result_block(tool_call_id, msg, is_error=True))
        if ledger is not None:
            await ledger.record_finished(results[-1])
        return

    if ledger is not None and (approved or ledger.is_side_effecting(tool_name, descriptor)):
        await ledger.record_started(tool_call_id)

    # Last gate before a side effect: a worker whose job lease was
    # taken over must not run the tool (the new owner will).
    # Raises `LeaseLostError` — a BaseException, so the broad
    # `except Exception` below can't turn it into a tool error.
    lease.check_current()
    try:
        result = await descriptor.execute(dict(args))
    except ToolError as exc:
        await emitter.step_error(str(exc), will_retry=True)
        await emitter.tool_output(tool_call_id=tool_call_id, tool_name=tool_name, summary=str(exc))
        results.append(_make_tool_result_block(tool_call_id, str(exc), is_error=True))
    except Exception as exc:
        # Unexpected exception — log + feed a generic error back to the
        # model so it can choose a different strategy. Don't propagate;
        # the model usually recovers and we don't want one flaky tool to
        # fail the whole run.
        msg = f"tool error: {exc.__class__.__name__}"
        logger.warning("tool.execute.failed", tool=tool_name, error=str(exc))
        await emitter.step_error(msg, will_retry=True)
        await emitter.tool_output(tool_call_id=tool_call_id, tool_name=tool_name, summary=msg)
        results.append(_make_tool_result_block(tool_call_id, msg, is_error=True))
    else:
        await emitter.tool_output(
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            summary=result.summary,
            results=result.source_results,
        )
        results.append(_make_tool_result_block(tool_call_id, result.text, is_error=False))

    if ledger is not None:
        await ledger.record_finished(results[-1])


# --- helpers -------------------------------------------------------------


_THINKING_BLOCKS = frozenset({"thinking", "redacted_thinking"})


def _turn_can_think(messages: list[dict[str, Any]]) -> bool:
    """Whether a call on `messages` may enable extended thinking — the
    native harness's rule (`runs/native_harness._turn_can_think`): with
    thinking on, Anthropic requires every assistant turn continuing the
    current tool-use turn to open with a thinking block. A fresh turn
    always can; a continued one only if its assistant turns thought."""
    for m in reversed(messages):
        content = m.get("content")
        blocks = content if isinstance(content, list) else []
        if m.get("role") == "user":
            if isinstance(content, str) or any(
                isinstance(b, dict) and b.get("type") != "tool_result" for b in blocks
            ):
                return True
            continue
        first = blocks[0] if blocks else None
        if not isinstance(first, dict) or first.get("type") not in _THINKING_BLOCKS:
            return False
    return True


def _coerce_content_blocks(final_message: Any) -> list[dict[str, Any]]:
    """Normalise the SDK's `final_message.content` into a list of
    dicts. The SDK returns typed Pydantic models; tests pass plain
    dicts. We accept both by routing through `model_dump` when
    available."""
    raw_content = getattr(final_message, "content", None)
    if raw_content is None and isinstance(final_message, dict):
        raw_content = final_message.get("content")
    blocks: list[dict[str, Any]] = []
    for item in raw_content or []:
        if isinstance(item, dict):
            blocks.append(item)
            continue
        # Try Pydantic .model_dump() first; fall back to __dict__.
        dump = getattr(item, "model_dump", None)
        if callable(dump):
            blocks.append(dump())
            continue
        blocks.append(dict(item.__dict__))
    return blocks


def _block_type(block: dict[str, Any]) -> str | None:
    val = block.get("type")
    return val if isinstance(val, str) else None


def _make_tool_result_block(
    tool_use_id: str,
    content: str,
    *,
    is_error: bool,
) -> dict[str, Any]:
    """Build an Anthropic `tool_result` content block. The SDK accepts
    either a string `content` or a list of text/image blocks; we use
    the simpler string form. `is_error: true` is the documented way
    to signal that the tool failed without breaking the conversation."""
    block: dict[str, Any] = {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
    }
    if is_error:
        block["is_error"] = True
    return block


__all__ = [
    "DEFAULT_MAX_TOKENS",
    "AnthropicStepConfig",
    "AsyncAnthropicClient",
    "execute_tool_call",
    "make_anthropic_step_fn",
]
