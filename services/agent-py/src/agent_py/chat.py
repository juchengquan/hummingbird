"""Chat-turn endpoint plumbing — Python mirror of `app/api/chat/route.ts`.

Ships a `/v1/chat` endpoint that streams Anthropic deltas back to
the caller as SSE frames in the AI SDK v5 UI message stream
protocol — what `@ai-sdk/react`'s `useChat()` consumes natively.
Frame envelopes match `ai`'s `JsonToSseTransformStream`:

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

**Internal events first (wave 3b-C).** The agent loop itself lives in
`chat_loop.run_turn_loop` and emits the run model's internal events
(`events.py`) — the same events a run's log stores. This module runs it
with a queue sink and turns the events into frames with
`AiSdkFrameTranslator`, so `/v1/chat`'s wire is unchanged while chat and
the runs API (`runs/native_harness.py`) share one loop.

The legacy custom wire format (`{type:"text",value}` etc.) was
retired in B.3 of PLAN-useChat-adoption.md once the frontend
consumer switched to reading the AI SDK shape.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

import structlog

from .chat_loop import (
    DEFAULT_MAX_STEPS,
    DEFAULT_MAX_TOKENS,
    TRUSTED_TOOLS,
    ChatConfig,
    ChatMessage,
    LoopFailed,
    LoopResult,
    LoopSucceeded,
    ProviderErrorCode,
    UsageMeter,
    _delta_pair_from_event,
    categorize_provider_error,
    run_turn_loop,
)
from .emitter import RunEmitter
from .events import (
    CodeResultEvent,
    McpAppEvent,
    RoutedModelEvent,
    StepEndEvent,
    StepStartEvent,
    SuggestionsEvent,
    TaskEvent,
    TokenEvent,
    ToolFileEvent,
    ToolImageEvent,
    ToolInputEvent,
    ToolOutputEvent,
    UiPartEvent,
    VerificationEvent,
)
from .model_allowlist import client_for_target, default_api_model_id
from .model_routes import ModelTarget
from .providers.anthropic_provider import AsyncAnthropicClient

logger = structlog.get_logger(__name__)

#: Post-stream interceptor — awaited once on a successful chat turn
#: just before the terminal `finish` frame, with the accumulated
#: assistant text. Any frames it yields are emitted ahead of the
#: terminator. PLAN-useChat-adoption.md Phase B.1d. Kept for callers that
#: build their own frames; the route uses `SuggestFn`, which goes through
#: the internal `suggestions` event instead.
OnCompleteFn = Callable[[str], AsyncIterator[str]]

#: Follow-up chips for a finished answer: awaited with the turn's text;
#: a non-empty result becomes a `suggestions` event (`data-suggestions`).
SuggestFn = Callable[[str], Awaitable[Sequence[str]]]

#: The HTTP response header the AI SDK uses to advertise its
#: stream protocol version (`x-vercel-ai-ui-message-stream: v1`).
#: Mirroring it on Python output lets `useChat()` consumers
#: identify the stream as native AI SDK without sniffing the body.
AI_SDK_STREAM_HEADER_NAME = "x-vercel-ai-ui-message-stream"
AI_SDK_STREAM_HEADER_VALUE = "v1"

_DONE_FRAME = "data: [DONE]\n\n"


def finish_frame(*, memory_tainted: bool) -> str:
    """The AI SDK `finish` frame; a memory-tainted turn carries
    `messageMetadata.memoryTainted` (the slot the Next.js route uses,
    read by `lib/client/chat/sse-frame-translator.ts`)."""
    if memory_tainted:
        return sse_frame({"type": "finish", "messageMetadata": {"memoryTainted": True}})
    return sse_frame({"type": "finish"})


def sse_frame(payload: dict[str, Any]) -> str:
    """Format one payload as an SSE `data:` frame. The wire shape is
    `data: <json>\\n\\n` — two newlines terminate the event, the
    client parses each as one message. JSON is compact (no
    indentation) to keep the per-token overhead minimal."""
    import json

    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


# --- Internal events → AI SDK frames ----------------------------------------------


class AiSdkFrameTranslator:
    """Internal run events → AI SDK v5 UI-message-stream SSE frames, for
    one stream. The `/v1/chat` counterpart of the runs API's AG-UI
    encoder (`packages/contract/RUN_EVENTS.md`), with the same block
    rule: at most one open text or reasoning block; a token of the other
    channel closes it, and so does **any** non-token event (even one
    that has no frame here). Block ids are fresh `uuid4().hex`s, as the
    pre-3b code minted them.

    | Internal event | Frames |
    |---|---|
    | `step_start` / `step_end` | `start-step` / `finish-step` |
    | `token` (text / reasoning) | `text-start`?, `text-delta` / `reasoning-start`?, `reasoning-delta` |
    | `tool_input` | `tool-input-available { toolCallId, toolName, input }` |
    | `tool_output` | `tool-output-available { toolCallId, output, errorText? }` (`output` = the full result text when the event carries it, else `summary`) |
    | `tool_image` / `tool_file` / `code_result` / `ui_part` / `mcp_app` | `data-tool-image` / `data-tool-file` / `data-code-result` / `data-ui` / `data-mcp-app`, `id` = the tool call id |
    | `suggestions` / `verification` / `routed_model` | `data-suggestions` / `data-verification` / `data-routed-model` |
    | anything else | — |

    The run's end is not an event: `succeeded` / `failed` add the
    closing frames (`finish` or `error`, then `[DONE]`).
    """

    def __init__(self, new_id: Callable[[], str] | None = None) -> None:
        self._new_id = new_id or (lambda: uuid.uuid4().hex)
        self._text_id: str | None = None
        self._reasoning_id: str | None = None

    def start(self) -> list[str]:
        return [sse_frame({"type": "start"})]

    def close_blocks(self) -> list[str]:
        out: list[str] = []
        if self._text_id is not None:
            out.append(sse_frame({"type": "text-end", "id": self._text_id}))
            self._text_id = None
        if self._reasoning_id is not None:
            out.append(sse_frame({"type": "reasoning-end", "id": self._reasoning_id}))
            self._reasoning_id = None
        return out

    def event(self, ev: TaskEvent) -> list[str]:
        if isinstance(ev, TokenEvent):
            return self._token(ev)
        out = self.close_blocks()
        frame = self._frame(ev)
        if frame is not None:
            out.append(sse_frame(frame))
        return out

    def succeeded(self, *, memory_tainted: bool) -> list[str]:
        return [*self.close_blocks(), finish_frame(memory_tainted=memory_tainted), _DONE_FRAME]

    def failed(self, *, message: str, code: str) -> list[str]:
        return [
            *self.close_blocks(),
            sse_frame({"type": "error", "errorText": message, "code": code}),
            _DONE_FRAME,
        ]

    def _token(self, ev: TokenEvent) -> list[str]:
        if not ev.text:
            return []
        out: list[str] = []
        if ev.channel == "reasoning":
            if self._text_id is not None:
                out.append(sse_frame({"type": "text-end", "id": self._text_id}))
                self._text_id = None
            if self._reasoning_id is None:
                self._reasoning_id = self._new_id()
                out.append(sse_frame({"type": "reasoning-start", "id": self._reasoning_id}))
            out.append(
                sse_frame({"type": "reasoning-delta", "id": self._reasoning_id, "delta": ev.text})
            )
            return out
        if self._reasoning_id is not None:
            out.append(sse_frame({"type": "reasoning-end", "id": self._reasoning_id}))
            self._reasoning_id = None
        if self._text_id is None:
            self._text_id = self._new_id()
            out.append(sse_frame({"type": "text-start", "id": self._text_id}))
        out.append(sse_frame({"type": "text-delta", "id": self._text_id, "delta": ev.text}))
        return out

    @staticmethod
    def _frame(ev: TaskEvent) -> dict[str, Any] | None:
        if isinstance(ev, StepStartEvent):
            return {"type": "start-step"}
        if isinstance(ev, StepEndEvent):
            return {"type": "finish-step"}
        if isinstance(ev, ToolInputEvent):
            return {
                "type": "tool-input-available",
                "toolCallId": ev.tool_call_id,
                "toolName": ev.tool_name,
                "input": ev.args,
            }
        if isinstance(ev, ToolOutputEvent):
            # Errors ride in `errorText` (AI SDK convention) next to
            # `output`; successful results only in `output`.
            payload: dict[str, Any] = {
                "type": "tool-output-available",
                "toolCallId": ev.tool_call_id,
                "output": ev.output if ev.output is not None else ev.summary,
            }
            if ev.is_error:
                payload["errorText"] = ev.summary
            return payload
        if isinstance(ev, ToolImageEvent):
            return {
                "type": "data-tool-image",
                "id": ev.tool_call_id,
                "data": {"id": ev.tool_call_id, "mode": ev.mode, "images": list(ev.images)},
            }
        if isinstance(ev, ToolFileEvent):
            return {
                "type": "data-tool-file",
                "id": ev.tool_call_id,
                "data": {"id": ev.tool_call_id, "files": list(ev.files)},
            }
        if isinstance(ev, CodeResultEvent):
            return {
                "type": "data-code-result",
                "id": ev.tool_call_id,
                "data": {
                    "id": ev.tool_call_id,
                    "stdout": ev.stdout,
                    "stderr": ev.stderr,
                    "results": list(ev.results),
                },
            }
        if isinstance(ev, UiPartEvent):
            return {
                "type": "data-ui",
                "id": ev.tool_call_id,
                "data": {"id": ev.tool_call_id, "kind": ev.ui_kind, "props": ev.props},
            }
        if isinstance(ev, McpAppEvent):
            app: dict[str, Any] = {
                "id": ev.tool_call_id,
                "serverId": ev.server_id,
                "html": ev.html,
            }
            if ev.resource_uri:
                app["resourceUri"] = ev.resource_uri
            if ev.truncated:
                app["truncated"] = True
            return {"type": "data-mcp-app", "id": ev.tool_call_id, "data": app}
        if isinstance(ev, SuggestionsEvent):
            return {"type": "data-suggestions", "data": {"values": list(ev.values)}}
        if isinstance(ev, VerificationEvent):
            return {"type": "data-verification", "data": ev.verification}
        if isinstance(ev, RoutedModelEvent):
            return {"type": "data-routed-model", "data": {"model": ev.model}}
        return None


# --- Driving the loop -------------------------------------------------------------


@dataclass(frozen=True)
class _RawFrames:
    """Frames a legacy `on_complete` produced, spliced in as they are."""

    frame: str


@dataclass(frozen=True)
class _LoopDone:
    result: LoopResult


@dataclass(frozen=True)
class _LoopCrashed:
    exc: BaseException


_QueueItem = TaskEvent | _RawFrames | _LoopDone | _LoopCrashed


async def _stream_turn(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
    with_tools: bool,
    on_complete: OnCompleteFn | None,
    suggest: SuggestFn | None,
) -> AsyncIterator[str]:
    """Run the loop as a task whose emitter sink is a queue, and yield
    the translated frames as the events arrive. Closing this generator
    (client gone, idle watchdog) cancels the task, which closes the
    provider stream."""
    queue: asyncio.Queue[_QueueItem] = asyncio.Queue()

    async def sink(event: TaskEvent) -> None:
        queue.put_nowait(event)

    emitter = RunEmitter(run_id="chat", sink=sink)

    async def on_answer(text: str) -> None:
        if on_complete is not None:
            async for frame in on_complete(text):
                queue.put_nowait(_RawFrames(frame))
        if suggest is not None:
            values = tuple(await suggest(text))
            if values:
                await emitter.emit(SuggestionsEvent, values=values)

    async def run() -> None:
        try:
            result = await run_turn_loop(
                client=client,
                emitter=emitter,
                model=config.model,
                messages=[{"role": m.role, "content": m.content} for m in config.messages],
                system=config.system,
                max_tokens=config.max_tokens,
                tools=config.tools if with_tools else (),
                max_steps=config.max_steps if with_tools else 1,
                on_answer=on_answer if (on_complete or suggest) else None,
            )
        except Exception as exc:
            queue.put_nowait(_LoopCrashed(exc))
            return
        queue.put_nowait(_LoopDone(result))

    translator = AiSdkFrameTranslator()
    for frame in translator.start():
        yield frame
    task = asyncio.create_task(run())
    try:
        while True:
            item = await queue.get()
            if isinstance(item, _RawFrames):
                for frame in translator.close_blocks():
                    yield frame
                yield item.frame
            elif isinstance(item, _LoopDone):
                for frame in _closing_frames(translator, item.result):
                    yield frame
                return
            elif isinstance(item, _LoopCrashed):
                raise item.exc
            else:
                for frame in translator.event(item):
                    yield frame
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def _closing_frames(translator: AiSdkFrameTranslator, result: LoopResult) -> list[str]:
    outcome = result.outcome
    if isinstance(outcome, LoopFailed):
        return translator.failed(message=outcome.message, code=outcome.wire_code)
    if isinstance(outcome, LoopSucceeded):
        return translator.succeeded(memory_tainted=result.tainted_by is not None)
    # Unreachable on `/v1/chat` — it gates no tool and has no cancel
    # signal — but a stream must still end with its terminator.
    return [*translator.close_blocks(), _DONE_FRAME]


async def chat_stream_ai_sdk(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
    on_complete: OnCompleteFn | None = None,
    suggest: SuggestFn | None = None,
) -> AsyncIterator[str]:
    """Run one Anthropic `messages.stream(...)` (no tools) and yield
    AI-SDK-v5 UI-message-stream SSE frames. Frame envelopes match the
    AI SDK's own writer (`JsonToSseTransformStream` in `ai/dist/index.js`)
    so `useChat()` consumes the stream natively.

    Frame sequence on a normal completion (text-only):
        start → start-step → text-start → text-delta… → text-end →
        finish-step → finish → `[DONE]` terminator.

    With reasoning interleaved (PLAN-useChat-adoption.md Phase B.1b):
        start → start-step → reasoning-start → reasoning-delta… →
        reasoning-end → text-start → text-delta… → text-end →
        finish-step → finish → `[DONE]`.

    The model can switch channels mid-step; the previous channel's block
    is closed before the next opens so `useChat()` sees matched
    start/end pairs per id.

    On an exception mid-stream: close any open block, then
    `error` + `[DONE]`. `finish` is intentionally skipped on the
    error path — mirrors the AI SDK's behaviour and lets `useChat()`
    distinguish completion from failure. `on_complete` / `suggest` run
    only on success, before `finish-step`.
    """
    async for frame in _stream_turn(
        client=client, config=config, with_tools=False, on_complete=on_complete, suggest=suggest
    ):
        yield frame


async def chat_stream_with_tools_ai_sdk(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
    on_complete: OnCompleteFn | None = None,
    suggest: SuggestFn | None = None,
) -> AsyncIterator[str]:
    """Tool-enabled chat stream in the AI SDK v5 UI message stream
    format: `start` / `start-step` / `text-delta` / `tool-input-available` /
    `tool-output-available` / `finish-step` / `finish` / `[DONE]` frames.

    Each loop iteration is one "step" in AI-SDK terms — `start-step` at
    the top, `finish-step` at the bottom. Text content is wrapped in a
    per-step `text-start` / `text-end` pair so `useChat()`'s message
    assembler closes the text block cleanly before tool-input frames
    land. Per-tool failures are fed back to the model as `is_error`
    tool results (and ride in `errorText`); the turn keeps going.

    Error path: close any open text block, emit
    `{type:"error","errorText":<msg>}`, then `[DONE]`. `finish` is
    intentionally skipped — same as the text-only path's convention.
    Running out of steps is the same error with code `upstream`.
    """
    async for frame in _stream_turn(
        client=client, config=config, with_tools=True, on_complete=on_complete, suggest=suggest
    ):
        yield frame


# --- Client resolution ----------------------------------------------------
#
# Every model call takes its client from the model's target: one Anthropic
# SDK client per configured provider (`model_routes.py`, cached there).


def resolve_anthropic_client(target: ModelTarget | None = None) -> AsyncAnthropicClient | None:
    """The Anthropic SDK client serving `target` (None → the default model):
    its provider's (`model_routes.py`, wave 10), or `None` when no configured
    provider serves it (callers surface a 503)."""
    return client_for_target(target)  # type: ignore[no-any-return]


# --- Follow-up suggestions (PLAN-useChat-adoption.md Phase B.1d) -------
#
# After a successful chat turn, optionally generate 3 follow-up
# suggestion chips with a cheap second model call. The chat route
# emits these via `{type: "suggestions"}` on the custom format or
# `data-suggestions` on AI SDK.

# The suggestion call uses `AGENT_DEFAULT_MODEL` (default Haiku — fast
# + cheap; the task is ~200 tokens of JSON), the same allowlisted
# default `/v1/summarize` falls back to. See `model_allowlist`.

_FENCE_HEAD_RE = re.compile(r"^```(?:json)?\s*\n?", re.IGNORECASE)
_FENCE_TAIL_RE = re.compile(r"\n?```\s*$")


def parse_suggestions_json(raw: str) -> list[str]:
    """Strip optional markdown fences, then parse + validate as a
    flat string array. Returns at most 3 short non-empty entries.
    Permissive — any decode failure yields an empty list.
    Mirrors `parseSuggestionsJson` in the Next.js inline route."""
    import json

    cleaned = raw.strip()
    cleaned = _FENCE_HEAD_RE.sub("", cleaned)
    cleaned = _FENCE_TAIL_RE.sub("", cleaned)
    cleaned = cleaned.strip()
    try:
        parsed = json.loads(cleaned)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    out: list[str] = []
    for s in parsed:
        if not isinstance(s, str):
            continue
        trimmed = s.strip()
        if trimmed and len(trimmed) <= 120:
            out.append(trimmed)
        if len(out) >= 3:
            break
    return out


def _last_user_text(history: list[ChatMessage]) -> str:
    for m in reversed(history):
        if m.role == "user":
            return m.content
    return ""


async def generate_chat_suggestions(
    *,
    client: AsyncAnthropicClient,
    history: list[ChatMessage],
    assistant_reply: str,
) -> list[str]:
    """Generate up to 3 follow-up suggestion chips for the current
    turn. Returns an empty list on any failure — chips are
    decoration, never block the turn.

    Mirrors `generateSuggestions` in `app/api/chat/route.ts` and
    `generateChatSuggestions` in `services/agent-ts/src/chat.ts`.
    """
    return await generate_suggestions(
        client=client, user_text=_last_user_text(history), assistant_reply=assistant_reply
    )


async def generate_suggestions(
    *,
    client: AsyncAnthropicClient,
    user_text: str,
    assistant_reply: str,
    usage: UsageMeter | None = None,
) -> list[str]:
    """`generate_chat_suggestions` given the user's question directly;
    the call's tokens go to `usage` when given."""
    if not assistant_reply.strip():
        return []

    prompt = (
        "Based on this exchange, propose 3 concise follow-up questions "
        "the user might want to ask next. Each must be under 14 words, "
        'in the user\'s voice (not "ask the user…"). '
        "Reply with strict JSON only — a flat array of 3 strings, no "
        "prose:\n"
        '["...", "...", "..."]\n\n'
        f'User asked:\n"""\n{user_text[:4000]}\n"""\n\n'
        f'Assistant answered:\n"""\n{assistant_reply[:4000]}\n"""'
    )

    model = default_api_model_id()
    try:
        # `messages.stream` + drain + `get_final_message` — same
        # pattern `summarise.py` uses for one-shot generation.
        stream_kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": 200,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": prompt}],
        }
        async with client.messages.stream(**stream_kwargs) as stream:
            async for _ in stream.text_stream:
                pass
            final = await stream.get_final_message()
    except Exception as exc:
        logger.info("chat.suggestions_failed", error=str(exc))
        return []

    if usage is not None:
        usage.add_anthropic(
            model, final.get("usage") if isinstance(final, dict) else getattr(final, "usage", None)
        )
    content = getattr(final, "content", None)
    if content is None and isinstance(final, dict):
        content = final.get("content")
    parts: list[str] = []
    for block in content or []:
        if isinstance(block, dict):
            if block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        else:
            btype = getattr(block, "type", None)
            if btype == "text":
                t = getattr(block, "text", None)
                if isinstance(t, str):
                    parts.append(t)
    return parse_suggestions_json("".join(parts))


__all__ = [
    "AI_SDK_STREAM_HEADER_NAME",
    "AI_SDK_STREAM_HEADER_VALUE",
    "DEFAULT_MAX_STEPS",
    "DEFAULT_MAX_TOKENS",
    "TRUSTED_TOOLS",
    "AiSdkFrameTranslator",
    "ChatConfig",
    "ChatMessage",
    "OnCompleteFn",
    "ProviderErrorCode",
    "SuggestFn",
    "_delta_pair_from_event",
    "categorize_provider_error",
    "chat_stream_ai_sdk",
    "chat_stream_with_tools_ai_sdk",
    "finish_frame",
    "generate_chat_suggestions",
    "generate_suggestions",
    "parse_suggestions_json",
    "resolve_anthropic_client",
    "sse_frame",
]
