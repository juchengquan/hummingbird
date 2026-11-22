"""The citation verifier's model client — cross-family by default.

Moved out of `executor.py` in wave 5a so the interactive harness can
verify citations too (wave 5b-C, `forwardedProps.verifyCitations`), not
just background research runs. Same behaviour: `resolve_verifier_client`
picks the `VERIFY_PROVIDER` family (a model is a weak judge of its own
output — Google when the answerer is Anthropic), falling back to the
answerer's Anthropic client with a one-shot warning; `verify_citations`
runs `verify.verify_answer` over it with `VERIFY_MODEL`. The log event
keys keep their `executor.` prefix (dashboards key on them).

Callers pass where the Anthropic fallback client comes from
(`anthropic_client`, e.g. `executor._resolve_anthropic_client`), so this
module depends on neither the executor nor the harness.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any, Protocol

import structlog

from . import verify
from .settings import get_settings

logger = structlog.get_logger(__name__)

__all__ = [
    "VERIFY_MAX_TOKENS",
    "AnthropicClientSource",
    "AnthropicVerifierClient",
    "GoogleVerifierClient",
    "VerifierClient",
    "make_anthropic_verifier_client",
    "make_google_verifier_client",
    "resolve_verifier_client",
    "verify_citations",
    "warn_once",
    "warned_keys",
]

AnthropicClientSource = Callable[[], Any]
"""Returns the `AsyncAnthropic` client to fall back to, or None."""

# Citation-verification cap — the verifier returns a small JSON object, so
# a tight budget is plenty.
VERIFY_MAX_TOKENS = 800

# Process-local set of warning keys already fired by `warn_once`.
# Reset in the test fixture (`test_cross_family_verifier._resetwarn_once`).
warned_keys: set[str] = set()


def warn_once(key: str, **fields: object) -> None:
    """Log a structlog warning the first time `key` is seen in this
    process. Keeps a startup-time misconfig (e.g. the cross-family
    provider being unavailable) from spamming the log on every research
    run."""
    if key in warned_keys:
        return
    warned_keys.add(key)
    logger.warning(key, **fields)


class VerifierClient(Protocol):
    """The narrow surface `_maybe_verify` needs from a verifier: one
    non-streaming completion call returning concatenated text. Both the
    Anthropic and Google wrappers satisfy this structurally."""

    async def messages_create(
        self, *, model: str, max_tokens: int, messages: list[dict[str, object]]
    ) -> str: ...


class AnthropicVerifierClient:
    """The legacy same-family path. Wraps the same `AsyncAnthropic` the
    run used, exposing the small `VerifierClient` surface."""

    def __init__(self, client: Any) -> None:
        self._client = client

    async def messages_create(
        self, *, model: str, max_tokens: int, messages: list[dict[str, object]]
    ) -> str:
        resp = await self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=messages,
        )
        parts: list[str] = []
        for block in getattr(resp, "content", None) or []:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)


class GoogleVerifierClient:
    """Cross-family path via the google-generativeai SDK. Returns the
    joined text parts of a `generate_content_async` call. The caller-side
    prompt already requests strict JSON."""

    def __init__(self, model: Any) -> None:
        self._model = model

    async def messages_create(
        self, *, model: str, max_tokens: int, messages: list[dict[str, object]]
    ) -> str:
        target = self._model
        if getattr(target, "model_name", model) != model:
            # The factory built with VERIFY_MODEL; rebuild if the call
            # site asks for a different model. Uncommon.
            target = build_google_model(model)
        user_text = "\n\n".join(
            str(m.get("content", "")) if isinstance(m, dict) else str(m) for m in messages
        )
        resp = await target.generate_content_async(user_text)
        parts: list[str] = []
        for cand in getattr(resp, "candidates", None) or []:
            content = getattr(cand, "content", None)
            for part in getattr(content, "parts", None) or []:
                text = getattr(part, "text", None)
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)


def build_google_model(model: str) -> Any:
    """Build a `google.generativeai.GenerativeModel`. Caller is expected
    to have called `genai.configure(api_key=...)` first."""
    import google.generativeai as genai  # local import; optional dep

    # The SDK ships types but doesn't re-export these at the top level.
    return genai.GenerativeModel(model)  # type: ignore[attr-defined]


def make_google_verifier_client() -> GoogleVerifierClient | None:
    """Build the Google cross-family verifier client. Returns None if
    `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) is unset OR the
    `google-generativeai` SDK isn't installed — caller logs a one-shot
    warning and falls back to the Anthropic path."""
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        import google.generativeai as genai
    except ImportError:
        return None
    genai.configure(api_key=api_key)  # type: ignore[attr-defined]
    settings = get_settings()
    model = build_google_model(settings.VERIFY_MODEL.strip() or "gemini-2.0-flash")
    return GoogleVerifierClient(model)


def make_anthropic_verifier_client(
    anthropic_client: AnthropicClientSource,
) -> AnthropicVerifierClient | None:
    """The legacy same-family Anthropic path. Returns None when no
    Anthropic client is configured (`anthropic_client()` is None — the
    same condition that gates the caller's live model call)."""
    client = anthropic_client()
    if client is None:
        return None
    return AnthropicVerifierClient(client)


def resolve_verifier_client(
    *, answerer_provider: str, anthropic_client: AnthropicClientSource
) -> VerifierClient | None:
    """Cross-family by default. Returns the configured provider's client,
    or the Anthropic fallback when the cross-family provider is missing.
    `warn_once` keeps the same-family / unavailable warnings from
    spamming the log on every research run."""
    settings = get_settings()
    verifier_provider = settings.VERIFY_PROVIDER.strip().lower()
    if not verifier_provider:
        return None
    same_family = verifier_provider == answerer_provider
    client: VerifierClient | None
    if verifier_provider == "google":
        client = make_google_verifier_client()
        if client is None:
            warn_once(
                "executor.verifier_google_unavailable",
                recommendation=(
                    "set GOOGLE_API_KEY to enable cross-family "
                    "verification; falling back to Anthropic"
                ),
            )
    elif verifier_provider == "anthropic":
        client = make_anthropic_verifier_client(anthropic_client)
    else:
        return None
    if same_family and client is not None:
        warn_once(
            "executor.verifier_same_family",
            answerer_provider=answerer_provider,
            recommendation=(
                "set VERIFY_PROVIDER to a different family for stronger cross-checking"
            ),
        )
    return client or make_anthropic_verifier_client(anthropic_client)  # safe fallback


async def verify_citations(
    *,
    text: str,
    sources: list[tuple[str, str, str]],
    answerer_provider: str = "anthropic",
    anthropic_client: AnthropicClientSource,
) -> dict[str, object] | None:
    """Run the citation verifier over `text` and its `(title, url,
    snippet)` sources, returning the wire payload (`{checks, summary}`)
    or None. Gated on a configured `VERIFY_MODEL` + a resolvable verifier
    client; `verify_answer` handles the no-claims / no-sources / failure
    → None cases."""
    settings = get_settings()
    model = settings.VERIFY_MODEL.strip()
    if not model:
        return None
    client = resolve_verifier_client(
        answerer_provider=answerer_provider, anthropic_client=anthropic_client
    )
    if client is None:
        return None

    async def run(prompt: str) -> str:
        return await client.messages_create(
            model=model,
            max_tokens=VERIFY_MAX_TOKENS,
            messages=[{"role": "user", "content": prompt}],
        )

    result = await verify.verify_answer(
        text,
        verify.gather_sources(sources),
        run_verifier=run,
    )
    return result.to_payload() if result is not None else None
