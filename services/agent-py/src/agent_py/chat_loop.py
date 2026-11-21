"""The interactive agent loop — one chat turn, emitted as internal events.

Wave 3b-C of `docs/PLAN-frontend-backend-split.md`: the loop `/v1/chat`
used to run inline while writing AI SDK frames now emits the run model's
internal events (`events.py`) through a `RunEmitter`, and returns how
the turn ended. Two consumers:

  * `/v1/chat` (`chat.py`) drives it with a queue sink and translates
    the events back into the AI SDK v5 UI-message-stream frames it has
    always sent (`chat.AiSdkFrameTranslator`) — byte for byte, modulo
    the random block ids;
  * the native harness adapter (`runs/native_harness.py`) drives it with
    the run driver's emitter, so a run's log gets exactly these events.

What it emits, per model call ("step"): `step_start`, `token`s (text /
reasoning), then for each `tool_use` block `tool_input` and — unless the
tool is gated — `step_error` (on failure) + `tool_output`, then
`step_end`. On a provider error or a cancel it returns with the step
still open (no `step_end`), because `/v1/chat`'s wire has no
`finish-step` there; a caller that wants a balanced log closes it
(`LoopResult.step_open`). It never emits lifecycle events (`status`,
`result`, `approval`) — the caller turns the returned outcome into those.

Memory taint (`TRUSTED_TOOLS`): the first tool that is not on the
allowlist and actually *ran* taints the turn; gated calls that only
asked for input do not.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import structlog

from .emitter import RunEmitter
from .events import TokenUsage, ToolCallResult
from .providers.anthropic_provider import (
    AsyncAnthropicClient,
    _coerce_content_blocks,
    _make_tool_result_block,
)
from .tools import ToolDescriptor, ToolError, tool_to_anthropic_param

logger = structlog.get_logger(__name__)

__all__ = [
    "DEFAULT_MAX_STEPS",
    "DEFAULT_MAX_TOKENS",
    "TRUSTED_TOOLS",
    "AnswerHook",
    "CancelRequested",
    "CancelWatch",
    "ChatConfig",
    "ChatMessage",
    "LoopCancelled",
    "LoopFailed",
    "LoopInterrupted",
    "LoopOutcome",
    "LoopResult",
    "LoopSucceeded",
    "PendingCall",
    "ProviderErrorCode",
    "ToolRun",
    "UsageMeter",
    "categorize_provider_error",
    "emit_tool_run",
    "execute_tool",
    "race_cancel",
    "run_turn_loop",
]

#: Stable provider-error categories surfaced on the wire in the
#: AI SDK error frame's `code` field. The consumer renders a typed
#: inline error bubble per code (rate-limited → cooldown, auth →
#: hide Retry, context_window → suggest a larger-context fallback).
#: `"upstream"` is the catch-all for anything else. Each is also an
#: `ApiError` code, so a run's `Failed.code` uses them as they are.
ProviderErrorCode = Literal["rate_limit", "auth", "context_window", "upstream"]

DEFAULT_MAX_TOKENS = 4096

#: Cap on tool-execution iterations per request. Each iteration is
#: one `messages.stream` call → optional text deltas → optional
#: tool_use blocks → execute → loop. Six matches the TS chat path's
#: `stepBudget` when no MCP tools are registered. Increase only if
#: production traces show the model legitimately needing more steps
#: — most over-cap hits are runaway / confused chains.
DEFAULT_MAX_STEPS = 6

#: Tools whose results carry no third-party content — the same allowlist
#: as `TRUSTED_TOOLS` in `lib/server/memory/untrusted-content-policy.ts`.
#: Any other tool that runs in a turn (web fetch / search, file search,
#: every MCP tool) may have put attacker-controllable text in context, so
#: the turn is "memory tainted": the result says so and the client
#: skips post-turn memory extraction for it, exactly as on the Next.js
#: route. Safe by default — a newly added tool taints without anyone
#: having to list it.
TRUSTED_TOOLS: frozenset[str] = frozenset(
    {"rememberFact", "forgetFact", "renderUI", "generateImage"}
)


@dataclass(frozen=True)
class ChatMessage:
    """One message in the chat history. Mirrors Anthropic's `role +
    content` shape; the route accepts a tighter wire schema (string
    content only) that we coerce into this dataclass."""

    role: str
    content: str


@dataclass(frozen=True)
class ChatConfig:
    """Per-request agent config.

    Phase 4-3 adds `tools` + `max_steps` — when `tools` is non-empty,
    the route uses `chat_stream_with_tools_ai_sdk` which loops
    `messages.stream` + tool execution until the model produces a
    text-only answer or `max_steps` is hit. Empty tools list falls
    through to the Phase 4-1 text-only path."""

    model: str
    messages: list[ChatMessage]
    system: str | None = None
    max_tokens: int = DEFAULT_MAX_TOKENS
    tools: tuple[ToolDescriptor, ...] = ()
    max_steps: int = DEFAULT_MAX_STEPS


# --- Provider errors ---------------------------------------------------------

#: Regex matching Anthropic's "prompt is too long" / OpenAI-flavoured
#: "context length exceeded" 400 surfaces. Used by
#: `categorize_provider_error` to bucket BadRequest 400s into
#: `context_window` instead of the generic `upstream` bucket. Kept
#: permissive — every provider phrases the same failure differently.
_CONTEXT_WINDOW_RE = re.compile(
    r"prompt is too long"
    r"|context[_ ]?(?:window|length)"
    r"|maximum (?:context|tokens)"
    r"|too many tokens"
    r"|input is too long"
    r"|exceeds.*token"
    r"|reduce.*input",
    re.IGNORECASE,
)


def categorize_provider_error(exc: BaseException) -> ProviderErrorCode:
    """Bucket an Anthropic SDK exception into one of the four wire
    codes. Mirrors `categorizeProviderError` in
    `services/agent-ts/src/chat.ts` and the shared `categorizeError`
    in `lib/shared/api-errors.ts`.

    Order matters — rate-limit-with-a-context-window-message would
    still be a rate limit, not a context bust. We check the Anthropic
    SDK's typed exceptions first (those are unambiguous) and fall
    back to string matching the message only for the BadRequest 400
    surface where the SDK reuses one class for several causes.
    """
    # The SDK exception module is imported lazily — the lib pulls in
    # anyio/httpx and we don't want to require it at import time for
    # tests that never touch the network path.
    try:
        from anthropic import (
            AuthenticationError,
            BadRequestError,
            PermissionDeniedError,
            RateLimitError,
        )
    except ImportError:  # pragma: no cover — anthropic is a hard dep
        AuthenticationError = PermissionDeniedError = RateLimitError = ()  # type: ignore[assignment,misc]
        BadRequestError = ()  # type: ignore[assignment,misc]

    if isinstance(exc, RateLimitError):
        return "rate_limit"
    if isinstance(exc, (AuthenticationError, PermissionDeniedError)):
        return "auth"
    if isinstance(exc, BadRequestError):
        if _CONTEXT_WINDOW_RE.search(str(exc)):
            return "context_window"
        return "upstream"

    # Some upstream gateways (Vercel AI Gateway, self-hosted proxies)
    # repackage typed errors as generic exceptions with the SDK message
    # preserved verbatim. Fall back to string-matching the rendered
    # text so we still bucket those correctly.
    message = str(exc)
    lower = message.lower()
    if ("rate" in lower and "limit" in lower) or "429" in lower or "too many requests" in lower:
        return "rate_limit"
    if "401" in lower or "403" in lower or "unauthor" in lower or "forbidden" in lower:
        return "auth"
    if _CONTEXT_WINDOW_RE.search(message):
        return "context_window"
    return "upstream"


# --- Stream events -------------------------------------------------------------


def _delta_pair_from_event(event: Any) -> tuple[Literal["text", "reasoning"], str] | None:
    """Extract a `(channel, delta)` pair from a raw Anthropic stream
    event, or None when the event isn't a content-delta we care about.

    Walks duck-typed because the SDK uses pydantic models and tests
    pass synthetic objects; both shapes carry `type` and `delta` /
    `delta.thinking` / `delta.text` attributes. A raw event walk rather
    than the high-level `stream.text_stream` is what lets us see the
    reasoning channel — the helper filters it out."""
    if getattr(event, "type", None) != "content_block_delta":
        return None
    delta = getattr(event, "delta", None)
    if delta is None:
        return None
    delta_type = getattr(delta, "type", None)
    if delta_type == "text_delta":
        text = getattr(delta, "text", None)
        if isinstance(text, str) and text:
            return ("text", text)
        return None
    if delta_type == "thinking_delta":
        thinking = getattr(delta, "thinking", None)
        if isinstance(thinking, str) and thinking:
            return ("reasoning", thinking)
        return None
    return None


def _int_attr(obj: Any, name: str) -> int | None:
    value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


class UsageMeter:
    """Token usage of every model call of a run, one `TokenUsage` per
    provider + model, in AG-UI's accounting: `input_tokens` is the whole
    prompt — Anthropic's `input_tokens` plus its cache reads and writes,
    which are reported separately and are *parts* of the total
    (`cached_input_tokens` / `cache_write_input_tokens`)."""

    def __init__(self, provider: str = "anthropic") -> None:
        self._provider = provider
        self._totals: dict[str, list[int]] = {}

    def add_anthropic(self, model: str, usage: Any) -> bool:
        """Add one Anthropic `usage` object (SDK model or dict). False
        when it carries no counts."""
        if usage is None:
            return False
        plain = _int_attr(usage, "input_tokens")
        output = _int_attr(usage, "output_tokens")
        cached = _int_attr(usage, "cache_read_input_tokens") or 0
        written = _int_attr(usage, "cache_creation_input_tokens") or 0
        if plain is None and output is None:
            return False
        row = self._totals.setdefault(model, [0, 0, 0, 0])
        row[0] += (plain or 0) + cached + written
        row[1] += output or 0
        row[2] += cached
        row[3] += written
        return True

    def totals(self) -> tuple[TokenUsage, ...]:
        return tuple(
            TokenUsage(
                provider=self._provider,
                model=model,
                input_tokens=row[0],
                output_tokens=row[1],
                cached_input_tokens=row[2] or None,
                cache_write_input_tokens=row[3] or None,
            )
            for model, row in self._totals.items()
        )


class _StepUsage:
    """Usage of one streamed call, from its `message_start` (prompt side)
    and `message_delta` (cumulative output) events."""

    def __init__(self) -> None:
        self.start: Any = None
        self.output: int | None = None

    def observe(self, event: Any) -> None:
        kind = getattr(event, "type", None)
        if kind == "message_start":
            self.start = getattr(getattr(event, "message", None), "usage", None)
        elif kind == "message_delta":
            out = _int_attr(getattr(event, "usage", None), "output_tokens")
            if out is not None:
                self.output = out

    def flush(self, meter: UsageMeter, model: str, final_message: Any) -> None:
        if self.start is not None or self.output is not None:
            merged: dict[str, int] = {}
            for key in (
                "input_tokens",
                "output_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
            ):
                if self.start is not None and (v := _int_attr(self.start, key)) is not None:
                    merged[key] = v
            if self.output is not None:
                merged["output_tokens"] = self.output
            if meter.add_anthropic(model, merged):
                return
        if final_message is not None:
            usage = (
                final_message.get("usage")
                if isinstance(final_message, dict)
                else getattr(final_message, "usage", None)
            )
            meter.add_anthropic(model, usage)


# --- Cancellation --------------------------------------------------------------


class CancelWatch(Protocol):
    """Structurally `runs.harness.CancelSignal` (kept local so this module
    does not import the `runs` package)."""

    def is_set(self) -> bool: ...

    async def wait(self) -> Literal[True]: ...


class CancelRequested(Exception):
    """Raised by `race_cancel` when the cancel signal won."""


async def race_cancel[T](aw: Awaitable[T], waiter: asyncio.Future[Any] | None) -> T:
    """Await `aw`, unless `waiter` (a task on `CancelSignal.wait()`)
    finishes first: then `aw` is cancelled and `CancelRequested` raised.
    Only the awaited operation is cancelled — never an emitter sink — so
    a log append is never cut in half."""
    if waiter is None:
        return await aw
    if waiter.done():
        if asyncio.iscoroutine(aw):
            aw.close()
        raise CancelRequested
    task = asyncio.ensure_future(aw)
    try:
        await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        task.cancel()
        raise
    if task.done():
        return task.result()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    raise CancelRequested


# --- Outcomes ------------------------------------------------------------------


@dataclass(frozen=True)
class PendingCall:
    """A gated tool call the loop did not run — it waits for an answer."""

    tool_call_id: str
    tool_name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class LoopSucceeded:
    """The model answered without calling (more) tools."""


@dataclass(frozen=True)
class LoopInterrupted:
    """The last step called gated tools. `pending` are those calls, in
    call order; `results` the `tool_result` blocks of the same step's
    other calls, which did run. The assistant turn holding every call is
    the last entry of `messages`."""

    pending: tuple[PendingCall, ...]
    results: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class LoopFailed:
    code: str
    """The run's `ApiError` code: a `ProviderErrorCode` or `max_steps`."""
    message: str
    wire_code: ProviderErrorCode
    """What `/v1/chat`'s `error` frame carries (`max_steps` is `upstream`
    there, as it always was)."""


@dataclass(frozen=True)
class LoopCancelled:
    """The cancel signal fired (between steps, mid-stream or mid-tool)."""


LoopOutcome = LoopSucceeded | LoopInterrupted | LoopFailed | LoopCancelled


@dataclass(frozen=True)
class LoopResult:
    outcome: LoopOutcome
    text: str
    """Every text token of the turn, concatenated."""
    tainted_by: str | None
    """The first untrusted tool that ran (or the seed), else None."""
    usage: tuple[TokenUsage, ...] = ()
    step_open: bool = False
    """A `step_start` was emitted without its `step_end` (failure or
    cancel mid-step)."""
    executed: tuple[str, ...] = field(default_factory=tuple)
    """Names of the tools that ran, in order."""


AnswerHook = Callable[[str], Awaitable[None]]
"""Awaited on the answering step, after its tokens and before its
`step_end`, with the turn's whole text — where `/v1/chat` and the
harness put the follow-up suggestions."""


# --- Tools -----------------------------------------------------------------------


@dataclass(frozen=True)
class ToolRun:
    text: str
    """What the model gets back (`tool_result.content`)."""
    summary: str
    """The one-line UI summary; the error text on failure."""
    is_error: bool
    sources: list[ToolCallResult] | None = None


async def execute_tool(
    descriptor: ToolDescriptor | None, name: str, args: dict[str, Any]
) -> ToolRun:
    """Run one tool. Per-tool failure modes (unknown tool, `ToolError`,
    unexpected exception) become an `is_error` result so the turn keeps
    moving — the model gets to retry, switch tools or give up."""
    if descriptor is None:
        msg = f"unknown tool: {name}"
        return ToolRun(msg, msg, True)
    try:
        result = await descriptor.execute(dict(args))
    except ToolError as exc:
        return ToolRun(str(exc), str(exc), True)
    except Exception as exc:
        msg = f"tool error: {exc.__class__.__name__}"
        logger.warning("chat.tool_execute_failed", tool=name, error=str(exc))
        return ToolRun(msg, msg, True)
    return ToolRun(result.text, result.summary, False, result.source_results)


async def emit_tool_run(
    emitter: RunEmitter, *, tool_call_id: str, tool_name: str, run: ToolRun
) -> None:
    """`step_error` (on failure) + `tool_output` for a finished call."""
    if run.is_error:
        await emitter.step_error(run.summary, will_retry=True)
    await emitter.tool_output(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        summary=run.summary,
        results=run.sources,
        is_error=run.is_error,
        output=run.text,
    )


def tool_use_fields(block: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    tool_call_id = block.get("id") or ""
    tool_name = block.get("name") or ""
    raw_args = block.get("input") or {}
    args: dict[str, Any] = dict(raw_args) if isinstance(raw_args, dict) else {}
    return str(tool_call_id), str(tool_name), args


# --- The loop ----------------------------------------------------------------------


async def run_turn_loop(
    *,
    client: AsyncAnthropicClient,
    emitter: RunEmitter,
    model: str,
    messages: list[dict[str, Any]],
    system: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    tools: Sequence[ToolDescriptor] = (),
    max_steps: int = DEFAULT_MAX_STEPS,
    gated: frozenset[str] = frozenset(),
    cancel: CancelWatch | None = None,
    on_answer: AnswerHook | None = None,
    tainted_by: str | None = None,
    usage: UsageMeter | None = None,
) -> LoopResult:
    """Run model calls + tool executions until the model answers, calls a
    gated tool, fails, is cancelled or runs out of steps. `messages`
    (Anthropic message dicts) is extended in place with each assistant
    turn and its `tool_result` turn.

    Without tools no `tools` kwarg is sent and the final message is not
    fetched (the text-only `/v1/chat` path); with tools each step reads
    `stream.get_final_message()` for its `tool_use` blocks.
    """
    tools_param = [tool_to_anthropic_param(t) for t in tools] if tools else None
    tools_by_name = {t.name: t for t in tools}
    meter = usage if usage is not None else UsageMeter()
    text_parts: list[str] = []
    executed: list[str] = []
    waiter = asyncio.ensure_future(cancel.wait()) if cancel is not None else None

    def done(outcome: LoopOutcome, *, step_open: bool = False) -> LoopResult:
        return LoopResult(
            outcome=outcome,
            text="".join(text_parts),
            tainted_by=tainted_by,
            usage=meter.totals(),
            step_open=step_open,
            executed=tuple(executed),
        )

    try:
        for _ in range(max_steps):
            if cancel is not None and cancel.is_set():
                return done(LoopCancelled())
            await emitter.start_step()

            kwargs: dict[str, Any] = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": messages,
            }
            if system:
                kwargs["system"] = system
            if tools_param:
                kwargs["tools"] = tools_param

            step_usage = _StepUsage()
            final_message: Any = None
            try:
                stream_ctx: Any = client.messages.stream(**kwargs)
                async with stream_ctx as stream:
                    events = stream.__aiter__()
                    while True:
                        try:
                            event = await race_cancel(events.__anext__(), waiter)
                        except StopAsyncIteration:
                            break
                        step_usage.observe(event)
                        pair = _delta_pair_from_event(event)
                        if pair is None:
                            continue
                        channel, delta = pair
                        if channel == "text":
                            text_parts.append(delta)
                        await emitter.token(delta, channel=channel)
                    if tools_param is not None:
                        final_message = await race_cancel(stream.get_final_message(), waiter)
            except CancelRequested:
                step_usage.flush(meter, model, None)
                return done(LoopCancelled(), step_open=True)
            except Exception as exc:  # broad — any provider failure ends the turn
                logger.warning("chat.stream_failed", error=str(exc), model=model)
                step_usage.flush(meter, model, None)
                code = categorize_provider_error(exc)
                return done(
                    LoopFailed(
                        code=code, message=str(exc) or "Chat stream failed.", wire_code=code
                    ),
                    step_open=True,
                )
            step_usage.flush(meter, model, final_message)

            blocks = _coerce_content_blocks(final_message) if final_message is not None else []
            tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
            if not tool_uses:
                if on_answer is not None:
                    await on_answer("".join(text_parts))
                await emitter.end_step()
                return done(LoopSucceeded())

            messages.append({"role": "assistant", "content": blocks})
            results: list[dict[str, Any]] = []
            pending: list[PendingCall] = []
            for block in tool_uses:
                tool_call_id, tool_name, args = tool_use_fields(block)
                await emitter.tool_input(tool_call_id=tool_call_id, tool_name=tool_name, args=args)
                if tool_name in gated:
                    pending.append(PendingCall(tool_call_id, tool_name, args))
                    continue
                try:
                    run = await race_cancel(
                        execute_tool(tools_by_name.get(tool_name), tool_name, args), waiter
                    )
                except CancelRequested:
                    return done(LoopCancelled(), step_open=True)
                executed.append(tool_name)
                if tainted_by is None and tool_name not in TRUSTED_TOOLS:
                    tainted_by = tool_name
                await emit_tool_run(
                    emitter, tool_call_id=tool_call_id, tool_name=tool_name, run=run
                )
                results.append(
                    _make_tool_result_block(tool_call_id, run.text, is_error=run.is_error)
                )

            await emitter.end_step()
            if pending:
                return done(LoopInterrupted(tuple(pending), tuple(results)))
            messages.append({"role": "user", "content": results})

        return done(
            LoopFailed(
                code="max_steps",
                message=(
                    f"Chat exceeded {max_steps} tool-use iterations "
                    "without producing a final answer."
                ),
                wire_code="upstream",
            )
        )
    finally:
        if waiter is not None:
            waiter.cancel()
