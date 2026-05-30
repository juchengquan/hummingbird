"""Anthropic streaming step-fn factory.

Mirror of `makeStreamTextStep` in `lib/server/agent/runner.ts`, narrowed
to text-only streaming for Phase 2b-1. One `messages.stream` call per
step; tokens are coalesced through `TokenCoalescer` and pushed at the
runner's emitter; on stream end the step returns `done=True`.

Tools (`tool_input` / `tool_output` events, gated-tool suspend points,
the registry) land in Phase 2b-2. Until then a step always settles
the run on its first call — same as a TS `streamText` with no `tools`
arg, where `finishReason` is always `"stop"`.

The factory takes an `AsyncClient` protocol so tests can swap a fake
that yields canned stream events without hitting the network. The
default `AsyncAnthropic` from the SDK satisfies the protocol.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

import structlog

from ..coalescer import make_token_coalescer
from ..runner import RunStepContext, RunStepFn, RunStepOutcome

logger = structlog.get_logger(__name__)


class _AnthropicStreamCtx(Protocol):
    """The async-context-manager surface a streaming call returns —
    `async with client.messages.stream(...) as stream:`. The SDK's
    actual return type is a private subclass of this shape; defining
    it as a Protocol lets fakes implement only the bits we touch."""

    async def __aenter__(self) -> _AnthropicStream: ...
    async def __aexit__(self, *exc: object) -> None: ...


class _AnthropicStream(Protocol):
    """The streaming reader. The real SDK exposes more (`final_message()`,
    `until_done()`); we only need the typed event iterator."""

    @property
    def text_stream(self) -> AsyncIterator[str]: ...


class _AnthropicMessages(Protocol):
    """`client.messages` — only `.stream(...)` is used here. The full
    SDK accepts many kwargs; we type only what's passed."""

    def stream(
        self,
        *,
        model: str,
        max_tokens: int,
        system: str | None,
        messages: list[dict[str, Any]],
    ) -> _AnthropicStreamCtx: ...


class AsyncAnthropicClient(Protocol):
    """The slice of the Anthropic SDK this module depends on. Real:
    `from anthropic import AsyncAnthropic`. Fake: any object exposing
    `messages.stream`."""

    @property
    def messages(self) -> _AnthropicMessages: ...


# --- Public API ----------------------------------------------------------

DEFAULT_MAX_TOKENS = 4096


@dataclass(frozen=True)
class AnthropicStepConfig:
    """All inputs the step fn closes over.

    `messages` is a list of `{role, content}` dicts in Anthropic's wire
    shape (`role: 'user' | 'assistant'`, `content: str` for now —
    multimodal lands when the agent service ports tool/vision support).
    `system` is the assembled system prompt the TS side builds via
    `buildTaskSystemPrompt` — the Python service receives it already
    composed and just forwards.
    """

    client: AsyncAnthropicClient
    model: str
    system: str | None
    messages: list[dict[str, Any]]
    max_tokens: int = DEFAULT_MAX_TOKENS


def make_anthropic_step_fn(config: AnthropicStepConfig) -> RunStepFn:
    """Build a `RunStepFn` bound to one run's config.

    Each invocation runs **one** `messages.stream` call: it streams
    text deltas through a coalescer (~96 chars per flush) into the
    emitter, then settles the step. With no tools wired, the first
    step always returns `done=True` — matching the TS behaviour where
    `streamText` without `tools` returns `finishReason: 'stop'` on
    completion.
    """

    async def run_step(ctx: RunStepContext) -> RunStepOutcome:
        async def emit_token(text: str, *, channel: str) -> None:
            # The emitter signature accepts only the literal channels;
            # the coalescer keyword arg is the literal too.
            if channel == "text":
                await ctx.emitter.token(text, channel="text")
            else:
                await ctx.emitter.token(text, channel="reasoning")

        coalescer = make_token_coalescer(emit_token)

        try:
            async with config.client.messages.stream(
                model=config.model,
                max_tokens=config.max_tokens,
                system=config.system,
                messages=config.messages,
            ) as stream:
                async for delta in stream.text_stream:
                    await coalescer.push("text", delta)
        finally:
            # Always flush whatever's buffered, even if the stream
            # raised mid-flight — partial output is better than dropped
            # text in `task_events`. The exception still propagates
            # to the runner; it'll wrap it as `result: failed`.
            await coalescer.flush_all()

        # Phase 2b-1: text-only, no tools → one step settles the run.
        return RunStepOutcome(done=True)

    return run_step


__all__ = [
    "DEFAULT_MAX_TOKENS",
    "AnthropicStepConfig",
    "AsyncAnthropicClient",
    "make_anthropic_step_fn",
]
