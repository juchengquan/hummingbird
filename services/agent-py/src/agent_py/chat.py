"""Chat-turn endpoint plumbing — Python mirror of `app/api/chat/route.ts`.

Phase 4-1 of PLAN-agent-api. Ships a text-only `/v1/chat` endpoint
that streams Anthropic deltas back to the caller as SSE frames whose
shape matches what the Next.js chat client (`use-chat-send.ts`)
already parses — so a frontend selector can swap between TS and
Python without changing the wire consumer.

Wire format (matches TS):
    data: {"type": "text", "value": "<delta>"}\\n\\n
    data: {"type": "error", "code": "...", "message": "..."}\\n\\n
    data: {"type": "done"}\\n\\n

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

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import structlog

from .providers.anthropic_provider import AsyncAnthropicClient
from .settings import get_settings

logger = structlog.get_logger(__name__)

DEFAULT_MAX_TOKENS = 4096


@dataclass(frozen=True)
class ChatMessage:
    """One message in the chat history. Mirrors Anthropic's `role +
    content` shape; the route accepts a tighter wire schema (string
    content only) that we coerce into this dataclass."""

    role: str
    content: str


@dataclass(frozen=True)
class ChatConfig:
    """Per-request agent config. Tools / skills / attachments not
    plumbed yet — Phase 4-2 layers them in."""

    model: str
    messages: list[ChatMessage]
    system: str | None = None
    max_tokens: int = DEFAULT_MAX_TOKENS


def sse_frame(payload: dict[str, Any]) -> str:
    """Format one payload as an SSE `data:` frame. The wire shape is
    `data: <json>\\n\\n` — two newlines terminate the event, the
    client parses each as one message. JSON is compact (no
    indentation) to keep the per-token overhead minimal."""
    import json

    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


async def chat_stream(
    *,
    client: AsyncAnthropicClient,
    config: ChatConfig,
) -> AsyncIterator[str]:
    """Run one Anthropic `messages.stream(...)` and yield SSE frames.

    The generator emits:
      - `{"type": "text", "value": <delta>}` for each text delta.
      - `{"type": "error", "code": <stable>, "message": <str>}` on
        any exception; the generator returns after.
      - `{"type": "done"}` as the final frame on a normal completion.

    Idempotent: each call streams its own `messages.stream` context.
    No DB writes — chat turns are ephemeral by design.
    """
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
                # Tiny deltas don't get coalesced — the TS path streams
                # token-by-token too, and the client renders incrementally
                # so latency wins over compression here.
                yield sse_frame({"type": "text", "value": delta})
    except Exception as exc:
        # Single broad surface — the Anthropic SDK raises a handful of
        # distinct exception types we don't want to wire into stable
        # codes per-type yet. The TS path categorises into
        # `rate_limit`, `auth`, `context_window`, `upstream`. For now
        # we pass through the message + a generic "upstream" code so
        # the client renders something useful; finer categorisation
        # ports alongside the skill cascade.
        logger.warning("chat.stream_failed", error=str(exc), model=config.model)
        yield sse_frame(
            {
                "type": "error",
                "code": "upstream",
                "message": str(exc) or "Chat stream failed.",
            }
        )
        return

    yield sse_frame({"type": "done"})


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
    "DEFAULT_MAX_TOKENS",
    "ChatConfig",
    "ChatMessage",
    "chat_stream",
    "resolve_anthropic_client",
    "sse_frame",
]
