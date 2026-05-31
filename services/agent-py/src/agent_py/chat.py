"""Chat-turn endpoint plumbing — Python mirror of `app/api/chat/route.ts`.

Phase 4-1 of PLAN-agent-api. Ships a text-only `/v1/chat` endpoint
that streams Anthropic deltas back to the caller as SSE frames whose
shape matches what the Next.js chat client (`use-chat-send.ts`)
already parses — so a frontend selector can swap between TS and
Python without changing the wire consumer.

Wire formats:

  - **custom** (default, matches the existing TS chat consumer):
        data: {"type": "text", "value": "<delta>"}\\n\\n
        data: {"type": "error", "code": "...", "message": "..."}\\n\\n
        data: {"type": "done"}\\n\\n

  - **ai-sdk** (Phase 3g — opt-in via `?format=ai-sdk` on the route):
    the AI SDK v5 UI message stream protocol, so a frontend that
    uses `@ai-sdk/react`'s `useChat()` can consume Python output
    natively. Frame envelopes match `ai`'s `JsonToSseTransformStream`:
        data: {"type":"start"}\\n\\n
        data: {"type":"start-step"}\\n\\n
        data: {"type":"text-start","id":"<msg-id>"}\\n\\n
        data: {"type":"text-delta","id":"<msg-id>","delta":"<chunk>"}\\n\\n
        data: {"type":"text-end","id":"<msg-id>"}\\n\\n
        data: {"type":"finish-step"}\\n\\n
        data: {"type":"finish"}\\n\\n
        data: [DONE]\\n\\n
    Errors emit `{"type":"error","errorText":"..."}` instead of
    `finish` and still write the `[DONE]` terminator so consumers'
    finally-blocks fire.

Scope is deliberately narrow for the first slice:
  - text-only (no tools yet — `tools` arg ignored if passed). The
    Python service already has the agent-loop machinery for tool
    use (Phase 2b-2 + 3c+); wiring it into the streaming chat
    endpoint adds wire-format complexity that belongs in a follow-up.
  - no skill cascade, no attachments, no MCP, no rate-limit
    bucketing. All deferred.
  - no abort plumbing yet — the FastAPI `Request.is_disconnected()`
    check covers client-side cancellation; idle watchdogs come later.

The selector (which backend the frontend hits) is a Next.js-side
concern — the Python endpoint just exists and waits to be called.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

import structlog

from .providers.anthropic_provider import (
    AsyncAnthropicClient,
    _coerce_content_blocks,
    _make_tool_result_block,
)
from .settings import get_settings
from .tools import ToolDescriptor, ToolError, tool_to_anthropic_param

logger = structlog.get_logger(__name__)

DEFAULT_MAX_TOKENS = 4096

#: Frame protocols. ``custom`` matches the existing TS chat
#: consumer (text / error / done). ``ai-sdk`` matches the AI SDK
#: v5 UI message stream protocol (text-start / text-delta /
#: text-end / finish / `[DONE]` terminator) for consumers using
#: ``@ai-sdk/react``'s ``useChat()``.
ChatFormat = Literal["custom", "ai-sdk"]

#: The HTTP response header the AI SDK uses to advertise its
#: stream protocol version (`x-vercel-ai-ui-message-stream: v1`).
#: Mirroring it on Python output lets `useChat()` consumers
#: identify the stream as native AI SDK without sniffing the body.
AI_SDK_STREAM_HEADER_NAME = "x-vercel-ai-ui-message-stream"
AI_SDK_STREAM_HEADER_VALUE = "v1"


@dataclass(frozen=True)
class ChatMessage:
    """One message in the chat history. Mirrors Anthropic's `role +
    content` shape; the route accepts a tighter wire schema (string
    content only) that we coerce into this dataclass."""

    role: str
    content: str


#: Cap on tool-execution iterations per request. Each iteration is
#: one `messages.stream` call → optional text deltas → optional
#: tool_use blocks → execute → loop. Six matches the TS chat path's
#: `stepBudget` when no MCP tools are registered. Increase only if
#: production traces show the model legitimately needing more steps
#: — most over-cap hits are runaway / confused chains.
DEFAULT_MAX_STEPS = 6


@dataclass(frozen=True)
class ChatConfig:
    """Per-request agent config.

    Phase 4-3 adds `tools` + `max_steps` — when `tools` is non-empty,
    the route uses `chat_stream_with_tools(_ai_sdk)` which loops
    `messages.stream` + tool execution until the model produces a
    text-only answer or `max_steps` is hit. Empty tools list falls
    through to the Phase 4-1 text-only path."""

    model: str
    messages: list[ChatMessage]
    system: str | None = None
    max_tokens: int = DEFAULT_MAX_TOKENS
    tools: tuple[ToolDescriptor, ...] = ()
    max_steps: int = DEFAULT_MAX_STEPS


def sse_frame(payload: dict[str, Any]) -> str:
    """Format one payload as an SSE `data:` frame. The wire shape is
    `data: <json>\\n\\n` — two newlines terminate the event, the
    client parses each as one message. JSON is compact (no
    indentation) to keep the per-token overhead minimal."""
    import json

    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


async def _stream_text_deltas(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
) -> AsyncIterator[str | BaseException]:
    """Open one Anthropic `messages.stream(...)` and yield text deltas
    until completion. Catches and yields the exception (instead of
    raising) so the caller can decide how to translate it into the
    chosen wire format without losing the partial output it already
    emitted. The yielded item is either a delta string or an
    exception — caller pattern-matches with `isinstance`."""
    anthropic_messages = [{"role": m.role, "content": m.content} for m in config.messages]
    stream_kwargs: dict[str, Any] = {
        "model": config.model,
        "max_tokens": config.max_tokens,
        "messages": anthropic_messages,
    }
    if config.system:
        stream_kwargs["system"] = config.system

    try:
        async with client.messages.stream(**stream_kwargs) as stream:
            async for delta in stream.text_stream:
                yield delta
    except Exception as exc:  # broad — see chat_stream's catch
        logger.warning("chat.stream_failed", error=str(exc), model=config.model)
        yield exc


async def chat_stream(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
) -> AsyncIterator[str]:
    """Run one Anthropic `messages.stream(...)` and yield SSE frames in
    the custom wire format (matches the existing TS chat consumer).

    The generator emits:
      - `{"type": "text", "value": <delta>}` for each text delta.
      - `{"type": "error", "code": <stable>, "message": <str>}` on
        any exception; the generator returns after.
      - `{"type": "done"}` as the final frame on a normal completion.

    Idempotent: each call streams its own `messages.stream` context.
    No DB writes — chat turns are ephemeral by design.
    """
    async for item in _stream_text_deltas(client=client, config=config):
        if isinstance(item, BaseException):
            # Single broad surface — the Anthropic SDK raises a handful
            # of distinct exception types we don't want to wire into
            # stable codes per-type yet. The TS path categorises into
            # `rate_limit`, `auth`, `context_window`, `upstream`. For
            # now we pass through the message + a generic "upstream"
            # code so the client renders something useful; finer
            # categorisation ports alongside the skill cascade.
            yield sse_frame(
                {
                    "type": "error",
                    "code": "upstream",
                    "message": str(item) or "Chat stream failed.",
                }
            )
            return
        yield sse_frame({"type": "text", "value": item})

    yield sse_frame({"type": "done"})


async def chat_stream_ai_sdk(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
) -> AsyncIterator[str]:
    """Run one Anthropic `messages.stream(...)` and yield AI-SDK-v5
    UI-message-stream SSE frames. Frame envelopes match the AI SDK's
    own writer (`JsonToSseTransformStream` in `ai/dist/index.js`) so
    `useChat()` consumes the stream natively.

    Frame sequence on a normal completion:
        start → start-step → text-start → text-delta… → text-end →
        finish-step → finish → `[DONE]` terminator.

    On an exception mid-stream: emit whatever text-delta we already
    produced, then `text-end` + `error` + `[DONE]`. `finish` is
    intentionally skipped on the error path — mirrors the AI SDK's
    behaviour and lets `useChat()` distinguish completion from
    failure.

    `text_id` is a per-message UUID — the SDK requires text-delta /
    text-end to reference the matching text-start `id`. We use one id
    for the whole assistant message; multi-block streaming (e.g.
    reasoning + text channels) would need separate ids per channel.
    """
    text_id = uuid.uuid4().hex

    yield sse_frame({"type": "start"})
    yield sse_frame({"type": "start-step"})
    yield sse_frame({"type": "text-start", "id": text_id})

    text_started = True
    async for item in _stream_text_deltas(client=client, config=config):
        if isinstance(item, BaseException):
            if text_started:
                yield sse_frame({"type": "text-end", "id": text_id})
                text_started = False
            yield sse_frame({"type": "error", "errorText": str(item) or "Chat stream failed."})
            yield "data: [DONE]\n\n"
            return
        yield sse_frame({"type": "text-delta", "id": text_id, "delta": item})

    yield sse_frame({"type": "text-end", "id": text_id})
    yield sse_frame({"type": "finish-step"})
    yield sse_frame({"type": "finish"})
    yield "data: [DONE]\n\n"


# --- Tool-enabled streaming (Phase 4-3) -----------------------------------
#
# When the route gets `enable_tools: true` AND there are tools in the
# context, it dispatches to one of these two functions instead of the
# text-only path. The contract:
#
#  - Each iteration of the loop opens a fresh `messages.stream(...)`,
#    streams text deltas, and inspects the final message for `tool_use`
#    blocks.
#  - If the model emitted tool calls, we emit `tool_call` events, run
#    each tool, emit `tool_result`, append the result to the running
#    messages list, and start the next iteration.
#  - If the model emitted no tool calls, the assistant turn is done —
#    we emit the format's "done" envelope and return.
#  - On a hard cap, we emit a recoverable error frame so the client
#    can show a "Max steps exhausted" surface.
#
# Per-tool failures (ToolError, unknown tool, unexpected exception) are
# caught and fed back into the conversation as `is_error: true`
# tool_result blocks — the model gets to choose whether to retry,
# switch tools, or give up. This mirrors the agent-loop step fn's
# behaviour so chat and background-task tool surfaces stay aligned.


def _to_anthropic_messages(messages: list[ChatMessage]) -> list[dict[str, Any]]:
    """Coerce the wire-shape ChatMessage list into Anthropic's message
    schema. Single text-content shape today — multimodal lands when
    the chat schema grows."""
    return [{"role": m.role, "content": m.content} for m in messages]


def _build_stream_kwargs(
    config: ChatConfig,
    messages: list[dict[str, Any]],
    tools_param: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": config.model,
        "max_tokens": config.max_tokens,
        "messages": messages,
    }
    if config.system:
        kwargs["system"] = config.system
    if tools_param:
        kwargs["tools"] = tools_param
    return kwargs


async def _execute_tool_block(
    block: dict[str, Any],
    tools_by_name: dict[str, ToolDescriptor],
) -> tuple[str, str, dict[str, Any], str, str, bool]:
    """Run the tool referenced by an Anthropic `tool_use` block and
    return ``(tool_call_id, tool_name, args, result_text, summary,
    is_error)``. Per-tool failure modes (unknown tool, ToolError,
    unexpected exception) are translated into ``is_error=True``
    tool_results so the conversation keeps moving."""
    tool_call_id = block.get("id") or ""
    tool_name = block.get("name") or ""
    raw_args = block.get("input") or {}
    args: dict[str, Any] = raw_args if isinstance(raw_args, dict) else {}

    descriptor = tools_by_name.get(tool_name)
    if descriptor is None:
        msg = f"unknown tool: {tool_name}"
        return tool_call_id, tool_name, args, msg, msg, True

    try:
        result = await descriptor.execute(dict(args))
    except ToolError as exc:
        return tool_call_id, tool_name, args, str(exc), str(exc), True
    except Exception as exc:
        msg = f"tool error: {exc.__class__.__name__}"
        logger.warning(
            "chat.tool_execute_failed",
            tool=tool_name,
            error=str(exc),
        )
        return tool_call_id, tool_name, args, msg, msg, True

    return tool_call_id, tool_name, args, result.text, result.summary, False


async def chat_stream_with_tools(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
) -> AsyncIterator[str]:
    """Tool-enabled chat stream in the custom wire format.

    Loops `messages.stream` + tool execution until the model produces a
    text-only assistant turn (no `tool_use` blocks in `final_message`),
    `config.max_steps` is hit, or an upstream exception fires.

    Emits SSE frames using the existing TS chat consumer's vocabulary:

      - `{"type":"text","value":<delta>}` per text delta.
      - `{"type":"tool_call","id":<id>,"name":<n>,"args":<dict>}` when
        a `tool_use` block is captured (before tool execution).
      - `{"type":"tool_result","id":<id>,"name":<n>,"result":<text>,
        "summary":<short>,"isError":<bool>}` after each tool resolves.
      - `{"type":"error","code":"upstream|max_steps","message":<str>}`
        on upstream failure or step exhaustion.
      - `{"type":"done"}` when the model produces a final text-only
        answer.
    """
    tools_param = [tool_to_anthropic_param(t) for t in config.tools] if config.tools else None
    tools_by_name = {t.name: t for t in config.tools}
    messages = _to_anthropic_messages(config.messages)

    for _step in range(config.max_steps):
        try:
            async with client.messages.stream(
                **_build_stream_kwargs(config, messages, tools_param)
            ) as stream:
                async for delta in stream.text_stream:
                    yield sse_frame({"type": "text", "value": delta})
                final_message = await stream.get_final_message()
        except Exception as exc:
            logger.warning(
                "chat.stream_failed",
                error=str(exc),
                model=config.model,
            )
            yield sse_frame(
                {
                    "type": "error",
                    "code": "upstream",
                    "message": str(exc) or "Chat stream failed.",
                }
            )
            return

        blocks = _coerce_content_blocks(final_message)
        tool_use_blocks = [b for b in blocks if b.get("type") == "tool_use"]

        if not tool_use_blocks:
            yield sse_frame({"type": "done"})
            return

        # Append the assistant turn so the next iteration carries the
        # full conversation history — Anthropic requires the tool_use
        # blocks to precede the matching tool_result blocks.
        messages.append({"role": "assistant", "content": blocks})

        tool_result_blocks: list[dict[str, Any]] = []
        for block in tool_use_blocks:
            (
                tool_call_id,
                tool_name,
                args,
                result_text,
                summary,
                is_error,
            ) = await _execute_tool_block(block, tools_by_name)
            yield sse_frame(
                {
                    "type": "tool_call",
                    "id": tool_call_id,
                    "name": tool_name,
                    "args": args,
                }
            )
            yield sse_frame(
                {
                    "type": "tool_result",
                    "id": tool_call_id,
                    "name": tool_name,
                    "result": result_text,
                    "summary": summary,
                    "isError": is_error,
                }
            )
            tool_result_blocks.append(
                _make_tool_result_block(tool_call_id, result_text, is_error=is_error)
            )

        messages.append({"role": "user", "content": tool_result_blocks})

    # Max steps exhausted without a text-only answer.
    yield sse_frame(
        {
            "type": "error",
            "code": "max_steps",
            "message": (
                f"Chat exceeded {config.max_steps} tool-use iterations "
                "without producing a final answer."
            ),
        }
    )


async def chat_stream_with_tools_ai_sdk(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
) -> AsyncIterator[str]:
    """Tool-enabled chat stream in the AI SDK v5 UI message stream
    format. Same loop as `chat_stream_with_tools` but rendered into
    `start` / `start-step` / `text-delta` / `tool-input-available` /
    `tool-output-available` / `finish-step` / `finish` / `[DONE]`
    frames.

    Each loop iteration is one "step" in AI-SDK terms — emits
    `start-step` at the top, `finish-step` at the bottom. Text content
    is wrapped in a per-step `text-start` / `text-end` pair so
    `useChat()`'s message assembler closes the text block cleanly
    before tool-input frames land.

    Error path: close any open text block, emit
    `{type:"error","errorText":<msg>}`, then `[DONE]`. `finish` is
    intentionally skipped — same as the text-only path's convention.
    """
    tools_param = [tool_to_anthropic_param(t) for t in config.tools] if config.tools else None
    tools_by_name = {t.name: t for t in config.tools}
    messages = _to_anthropic_messages(config.messages)

    yield sse_frame({"type": "start"})

    for _step in range(config.max_steps):
        yield sse_frame({"type": "start-step"})
        text_id = uuid.uuid4().hex
        yield sse_frame({"type": "text-start", "id": text_id})

        try:
            async with client.messages.stream(
                **_build_stream_kwargs(config, messages, tools_param)
            ) as stream:
                async for delta in stream.text_stream:
                    yield sse_frame({"type": "text-delta", "id": text_id, "delta": delta})
                final_message = await stream.get_final_message()
        except Exception as exc:
            logger.warning(
                "chat.stream_failed",
                error=str(exc),
                model=config.model,
            )
            yield sse_frame({"type": "text-end", "id": text_id})
            yield sse_frame({"type": "error", "errorText": str(exc) or "Chat stream failed."})
            yield "data: [DONE]\n\n"
            return

        yield sse_frame({"type": "text-end", "id": text_id})

        blocks = _coerce_content_blocks(final_message)
        tool_use_blocks = [b for b in blocks if b.get("type") == "tool_use"]

        if not tool_use_blocks:
            yield sse_frame({"type": "finish-step"})
            yield sse_frame({"type": "finish"})
            yield "data: [DONE]\n\n"
            return

        messages.append({"role": "assistant", "content": blocks})
        tool_result_blocks: list[dict[str, Any]] = []

        for block in tool_use_blocks:
            (
                tool_call_id,
                tool_name,
                args,
                result_text,
                _summary,  # AI SDK has no `summary` slot — only on the custom format
                is_error,
            ) = await _execute_tool_block(block, tools_by_name)
            yield sse_frame(
                {
                    "type": "tool-input-available",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "input": args,
                }
            )
            # `tool-output-available` carries the result. Errors ride
            # in `errorText` (AI SDK convention); successful results
            # land in `output`.
            output_payload: dict[str, Any] = {
                "type": "tool-output-available",
                "toolCallId": tool_call_id,
                "output": result_text,
            }
            if is_error:
                output_payload["errorText"] = result_text
            yield sse_frame(output_payload)
            tool_result_blocks.append(
                _make_tool_result_block(tool_call_id, result_text, is_error=is_error)
            )

        messages.append({"role": "user", "content": tool_result_blocks})
        yield sse_frame({"type": "finish-step"})

    yield sse_frame(
        {
            "type": "error",
            "errorText": (
                f"Chat exceeded {config.max_steps} tool-use iterations "
                "without producing a final answer."
            ),
        }
    )
    yield "data: [DONE]\n\n"


# --- Client resolution ----------------------------------------------------
#
# The agent-loop executor has its own `_resolve_anthropic_client` for the
# background-task path; the chat endpoint wants the same client config
# (same `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`). Sharing the resolver
# across both paths is tempting but couples the two — the executor's
# resolver is also memoised process-wide which is fine for a worker but
# odd for a request handler. Keep them separate; both read the same env.


def resolve_anthropic_client() -> AsyncAnthropicClient | None:
    """Build an `AsyncAnthropic` for the chat endpoint, or return
    `None` when `ANTHROPIC_API_KEY` is unset (callers surface a 503).

    Reads `ANTHROPIC_BASE_URL` too — same plumbing as the executor's
    resolver, kept separate so request-handler lifecycle stays out of
    the worker-side memo cache.
    """
    settings = get_settings()
    api_key = settings.ANTHROPIC_API_KEY.strip()
    if not api_key:
        return None
    from anthropic import AsyncAnthropic

    base_url = settings.ANTHROPIC_BASE_URL.strip()
    if base_url:
        return AsyncAnthropic(api_key=api_key, base_url=base_url)  # type: ignore[return-value]
    return AsyncAnthropic(api_key=api_key)  # type: ignore[return-value]


__all__ = [
    "AI_SDK_STREAM_HEADER_NAME",
    "AI_SDK_STREAM_HEADER_VALUE",
    "DEFAULT_MAX_STEPS",
    "DEFAULT_MAX_TOKENS",
    "ChatConfig",
    "ChatFormat",
    "ChatMessage",
    "chat_stream",
    "chat_stream_ai_sdk",
    "chat_stream_with_tools",
    "chat_stream_with_tools_ai_sdk",
    "resolve_anthropic_client",
    "sse_frame",
]
