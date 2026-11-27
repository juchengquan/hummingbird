"""Shared model-call helpers for the routers and the runs harness.

`/v1/chat` (the AI SDK UI-message-stream route) was removed in wave 13
of `docs/PLAN-frontend-backend-split.md` (Q121): chat runs on the runs
API (`routers/runs.py`, `runs/native_harness.py`), which drives the agent
loop in `chat_loop.py`. What stays here is what other modules import:
the per-model client resolver, the follow-up suggestions call, and the
`ChatMessage` history type.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from .chat_loop import ChatMessage, UsageMeter
from .model_allowlist import client_for_target, default_api_model_id
from .model_routes import ModelTarget
from .providers.anthropic_provider import AsyncAnthropicClient

logger = structlog.get_logger(__name__)


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
# After a successful chat run, optionally generate 3 follow-up
# suggestion chips with a cheap second model call. The native harness
# emits them as a `suggestions` event (`runs/native_harness.py`).

# The suggestion call uses `AGENT_DEFAULT_MODEL` (default Haiku — fast
# + cheap; the task is ~200 tokens of JSON), the same allowlisted
# default `/v1/summarize` falls back to. See `model_allowlist`.

_FENCE_HEAD_RE = re.compile(r"^```(?:json)?\s*\n?", re.IGNORECASE)
_FENCE_TAIL_RE = re.compile(r"\n?```\s*$")


def parse_suggestions_json(raw: str) -> list[str]:
    """Strip optional markdown fences, then parse + validate as a
    flat string array. Returns at most 3 short non-empty entries.
    Permissive — any decode failure yields an empty list."""
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


async def generate_suggestions(
    *,
    client: AsyncAnthropicClient,
    user_text: str,
    assistant_reply: str,
    usage: UsageMeter | None = None,
) -> list[str]:
    """Up to 3 follow-up suggestion chips for a finished answer to
    `user_text`; an empty list on any failure (chips are decoration and
    never block the turn). The call's tokens go to `usage` when given."""
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
    "ChatMessage",
    "generate_suggestions",
    "parse_suggestions_json",
    "resolve_anthropic_client",
]
