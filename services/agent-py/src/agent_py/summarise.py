"""Summarisation endpoint — Python port of `app/api/summarize/route.ts`.

One JSON-in/JSON-out endpoint, four modes selected via a
discriminated union on `mode`:

  - **file**: `{mode: 'file', text, name?}` → `{summary, keyTopics}`
  - **conversation**: `{mode: 'conversation', messages}` →
    `{summary, keyPoints, decisions}`
  - **compress**: `{mode: 'compress', messages}` → `{recap}` (plain
    markdown bullets, intended to REPLACE the input messages in the
    next turn's history)
  - **project-breakdown**: `{mode: 'project-breakdown', goal,
    existingTitles?}` → `{titles}`

Three of the four return JSON parsed from the model's text response;
`compress` returns plain markdown. All run one `messages.create`
call against Anthropic — non-streaming — and cap output at 600 / 800
tokens depending on mode.

Notable difference from the TS path: the TS route uses `generateText`
+ Vercel AI Gateway routing so the request's `model` field can be
any provider's id (`google/gemini-2.5-flash`, `openai/gpt-4o-mini`,
etc.). The Python service only talks to Anthropic, so we default to
a cheap Anthropic model and ignore the request's `model` if it
doesn't look like an Anthropic id. Caller behaviour is unaffected
because the schema still accepts the field; the TS-shape body sent
by today's apiClient comes through unchanged.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

import structlog

from .chat import ChatMessage as ChatMessageDC
from .providers.anthropic_provider import AsyncAnthropicClient

logger = structlog.get_logger(__name__)

#: Default summarisation model. Haiku is the cheapest / fastest
#: Anthropic option — summaries don't need a reasoning-class model.
#: The TS path defaults to `google/gemini-2.5-flash` via the Vercel
#: gateway; the Python service only talks to Anthropic, so we pick
#: the analogous tier.
DEFAULT_SUMMARY_MODEL = "claude-3-5-haiku-20241022"

SummariseMode = Literal["file", "conversation", "compress", "project-breakdown"]


@dataclass(frozen=True)
class SummariseError:
    code: Literal["provider", "invalid_json"]
    message: str


@dataclass(frozen=True)
class SummariseOk:
    payload: dict[str, Any]


SummariseResult = SummariseOk | SummariseError


def is_anthropic_model_id(model: str) -> bool:
    """Quick heuristic for whether a model id targets Anthropic.
    `claude-*` and `claude_*` both pass; gateway-style ids like
    `google/gemini-2.5-flash` or `openai/gpt-4o-mini` don't."""
    return model.lower().startswith("claude")


def resolve_model(requested: str | None) -> str:
    """Choose the Anthropic model to actually call. If the caller
    sent an Anthropic id, honour it. Otherwise (including the TS-side
    Gemini default), fall back to our Haiku default."""
    if requested and is_anthropic_model_id(requested):
        return requested
    return DEFAULT_SUMMARY_MODEL


def _build_file_prompt(name: str | None, text: str) -> str:
    title = f' titled "{name}"' if name else ""
    return (
        f"Summarize the following document{title} in 2-3 plain-text "
        "sentences. Then list 3-5 short topic phrases (noun phrases, "
        "lowercase, no punctuation).\n\n"
        "Reply with strict JSON only, no prose:\n"
        '{"summary": "...", "keyTopics": ["topic one", "topic two"]}\n\n'
        f'Document:\n"""\n{text}\n"""'
    )


def _format_transcript(messages: list[ChatMessageDC]) -> str:
    return "\n\n".join(f"{m.role.upper()}: {m.content}" for m in messages)


def _build_conversation_prompt(messages: list[ChatMessageDC]) -> str:
    transcript = _format_transcript(messages)
    return (
        "Summarize this conversation. Include:\n"
        "- A one-paragraph overview\n"
        "- 3-6 key points\n"
        "- Decisions or action items (or [] if none)\n\n"
        "Reply with strict JSON only, no prose:\n"
        '{"summary": "...", "keyPoints": ["..."], "decisions": ["..."]}\n\n'
        f'Conversation:\n"""\n{transcript}\n"""'
    )


def _build_compress_prompt(messages: list[ChatMessageDC]) -> str:
    transcript = _format_transcript(messages)
    return (
        "Compress the following conversation between USER and ASSISTANT "
        "into a tight markdown recap (4-10 bullets, ~300 tokens) that "
        "PRESERVES enough information for the assistant to continue the "
        "conversation seamlessly from this point.\n\n"
        "Required:\n"
        "- Keep specific names, facts, numbers, file references, URLs.\n"
        "- Keep any explicit decisions the user made.\n"
        "- Keep any open questions or pending follow-ups.\n"
        "- Drop pleasantries and rhetorical filler.\n\n"
        "Output plain markdown bullets only. No headings, no preamble, "
        'no JSON. Start the response with "- ".\n\n'
        f'Conversation:\n"""\n{transcript}\n"""'
    )


def _build_project_breakdown_prompt(goal: str, existing_titles: list[str] | None) -> str:
    existing = ""
    if existing_titles:
        listing = "\n".join(f"- {t}" for t in existing_titles)
        existing = f"\n\nThe board already has these tasks — do NOT repeat them:\n{listing}"
    return (
        "Break the following project goal into 5-8 concrete, actionable "
        "task titles. Each title is a short imperative phrase (e.g. "
        '"Draft the API schema", "Set up CI"), not a sentence. Order them '
        f"roughly by sequence.{existing}\n\n"
        "Reply with strict JSON only, no prose:\n"
        '{"titles": ["task one", "task two", "..."]}\n\n'
        f'Goal:\n"""\n{goal}\n"""'
    )


# Strip ```json fences a model might wrap the JSON in despite the
# explicit instruction. Mirrors the TS `stripJsonFences`.
_FENCE_HEAD_RE = re.compile(r"^```(?:json)?\s*\n?", re.IGNORECASE)
_FENCE_TAIL_RE = re.compile(r"\n?```\s*$")


def strip_json_fences(text: str) -> str:
    out = text.strip()
    out = _FENCE_HEAD_RE.sub("", out)
    out = _FENCE_TAIL_RE.sub("", out)
    return out.strip()


async def _generate_text(
    *,
    client: AsyncAnthropicClient,
    model: str,
    prompt: str,
    max_tokens: int,
) -> str:
    """One-shot Anthropic completion. Uses `messages.stream` and
    drains the stream without yielding deltas to the caller — the
    model still produces the full message, we just don't surface
    incremental output. Returns the joined text content of the
    final message."""
    stream_kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    async with client.messages.stream(**stream_kwargs) as stream:
        # Drain text deltas — the model still produces the full
        # message, we just don't need to surface incremental output.
        async for _ in stream.text_stream:
            pass
        final = await stream.get_final_message()

    # Extract text from the SDK's content blocks. Mirrors
    # `_coerce_content_blocks` in `anthropic_provider.py`.
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
    return "".join(parts)


async def summarise_file(
    *,
    client: AsyncAnthropicClient,
    model: str,
    name: str | None,
    text: str,
) -> SummariseResult:
    return await _summarise_json(
        client=client,
        model=model,
        prompt=_build_file_prompt(name, text),
        max_tokens=600,
    )


async def summarise_conversation(
    *,
    client: AsyncAnthropicClient,
    model: str,
    messages: list[ChatMessageDC],
) -> SummariseResult:
    return await _summarise_json(
        client=client,
        model=model,
        prompt=_build_conversation_prompt(messages),
        max_tokens=600,
    )


async def summarise_compress(
    *,
    client: AsyncAnthropicClient,
    model: str,
    messages: list[ChatMessageDC],
) -> SummariseResult:
    """Compress mode returns plain markdown bullets (not JSON). The
    output replaces the input messages in the next turn's history."""
    try:
        text = await _generate_text(
            client=client,
            model=model,
            prompt=_build_compress_prompt(messages),
            max_tokens=800,
        )
    except Exception as exc:
        logger.warning("summarise.compress_failed", error=str(exc))
        return SummariseError(code="provider", message=str(exc) or "Provider error.")
    recap = text.strip()
    if not recap:
        return SummariseError(code="provider", message="Summariser returned empty output.")
    return SummariseOk(payload={"recap": recap})


async def summarise_project_breakdown(
    *,
    client: AsyncAnthropicClient,
    model: str,
    goal: str,
    existing_titles: list[str] | None,
) -> SummariseResult:
    return await _summarise_json(
        client=client,
        model=model,
        prompt=_build_project_breakdown_prompt(goal, existing_titles),
        max_tokens=600,
    )


async def _summarise_json(
    *,
    client: AsyncAnthropicClient,
    model: str,
    prompt: str,
    max_tokens: int,
) -> SummariseResult:
    """Drive a single Anthropic call + parse the JSON response.
    Errors bucket into `provider` (upstream raised / empty output) and
    `invalid_json` (model returned non-JSON despite the instruction)
    — both are user-visible failure modes the route maps to 502."""
    try:
        text = await _generate_text(
            client=client, model=model, prompt=prompt, max_tokens=max_tokens
        )
    except Exception as exc:
        logger.warning("summarise.generate_failed", error=str(exc))
        return SummariseError(code="provider", message=str(exc) or "Provider error.")
    if not text.strip():
        return SummariseError(code="provider", message="Summariser returned empty output.")
    cleaned = strip_json_fences(text)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return SummariseError(
            code="invalid_json",
            message="Summarisation model did not return valid JSON.",
        )
    if not isinstance(parsed, dict):
        return SummariseError(
            code="invalid_json", message="Summarisation model returned non-object JSON."
        )
    return SummariseOk(payload=parsed)


__all__ = [
    "DEFAULT_SUMMARY_MODEL",
    "SummariseError",
    "SummariseOk",
    "SummariseResult",
    "is_anthropic_model_id",
    "resolve_model",
    "strip_json_fences",
    "summarise_compress",
    "summarise_conversation",
    "summarise_file",
    "summarise_project_breakdown",
]
