"""`agent_py.chat` helpers + the loop's provider-error and delta helpers.

Hermetic — patches the Anthropic SDK at the boundary. We test:
  - `categorize_provider_error` buckets SDK exceptions into wire codes.
  - `resolve_anthropic_client` returns None without an API key.
  - `_delta_pair_from_event` keeps only text / thinking deltas.
  - `parse_suggestions_json` validates the follow-up chips.

(`/v1/chat` and its AI SDK stream went in wave 13, Q121; the loop's
events are pinned in `test_chat_events.py`.)
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agent_py import chat as chat_module
from agent_py import settings as settings_module
from agent_py.chat import resolve_anthropic_client


def _text_event(text: str) -> SimpleNamespace:
    """Synthetic Anthropic `content_block_delta` event with a
    `text_delta` payload. Matches the shape `_delta_pair_from_event`
    walks duck-typed."""
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="text_delta", text=text),
    )


def _thinking_event(text: str) -> SimpleNamespace:
    """Synthetic Anthropic `content_block_delta` event with a
    `thinking_delta` payload (extended thinking)."""
    return SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="thinking_delta", thinking=text),
    )


# --- categorize_provider_error ----------------------------------------


def test_categorize_provider_error_rate_limit_via_sdk_type() -> None:
    """Anthropic's typed `RateLimitError` maps to `rate_limit`
    unconditionally — we don't string-match when the SDK gave us the
    answer."""
    from anthropic import RateLimitError

    from agent_py.chat_loop import categorize_provider_error

    # The SDK exception classes take (message, response, body) — use
    # a synthetic mock for response since we only care about the
    # isinstance check.
    exc = RateLimitError.__new__(RateLimitError)
    exc.args = ("hit a limit",)
    assert categorize_provider_error(exc) == "rate_limit"


def test_categorize_provider_error_auth_via_sdk_type() -> None:
    from anthropic import AuthenticationError, PermissionDeniedError

    from agent_py.chat_loop import categorize_provider_error

    auth = AuthenticationError.__new__(AuthenticationError)
    auth.args = ("missing api key",)
    perm = PermissionDeniedError.__new__(PermissionDeniedError)
    perm.args = ("forbidden",)
    assert categorize_provider_error(auth) == "auth"
    assert categorize_provider_error(perm) == "auth"


def test_categorize_provider_error_context_window_via_400_message() -> None:
    """Anthropic packs context-window busts into a generic
    `BadRequestError` — we inspect the message to disambiguate from
    other 400s."""
    from anthropic import BadRequestError

    from agent_py.chat_loop import categorize_provider_error

    exc = BadRequestError.__new__(BadRequestError)
    exc.args = ("prompt is too long: 250000 tokens > 200000 maximum",)
    assert categorize_provider_error(exc) == "context_window"


def test_categorize_provider_error_bad_request_without_context_phrase() -> None:
    """A `BadRequestError` whose message doesn't mention a
    context-window bust stays in the generic `upstream` bucket
    rather than being mis-categorised as context_window."""
    from anthropic import BadRequestError

    from agent_py.chat_loop import categorize_provider_error

    exc = BadRequestError.__new__(BadRequestError)
    exc.args = ("messages.0: role must be 'user' or 'assistant'",)
    assert categorize_provider_error(exc) == "upstream"


def test_categorize_provider_error_string_match_fallback() -> None:
    """Generic exceptions (a gateway rewrapped the SDK error) get
    bucketed by message text. Order of priority is rate_limit →
    auth → context_window → upstream."""
    from agent_py.chat_loop import categorize_provider_error

    assert categorize_provider_error(RuntimeError("429 too many requests")) == "rate_limit"
    assert categorize_provider_error(RuntimeError("401 unauthorized")) == "auth"
    assert categorize_provider_error(RuntimeError("forbidden")) == "auth"
    assert categorize_provider_error(RuntimeError("input is too long")) == "context_window"
    assert categorize_provider_error(RuntimeError("connection reset")) == "upstream"


def test_categorize_provider_error_rate_limit_wins_over_context_phrase() -> None:
    """A rate-limit exception whose message coincidentally mentions
    context windows stays a rate limit. Order of checks matters."""
    from anthropic import RateLimitError

    from agent_py.chat_loop import categorize_provider_error

    exc = RateLimitError.__new__(RateLimitError)
    exc.args = ("rate limited: context_length was 100 tokens",)
    assert categorize_provider_error(exc) == "rate_limit"


# --- resolve_anthropic_client -----------------------------------------


def test_resolve_client_none_without_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings_module.get_settings.cache_clear()
    assert resolve_anthropic_client() is None


def test_resolve_client_builds_with_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    settings_module.get_settings.cache_clear()
    fake = MagicMock()
    with pytest.MonkeyPatch.context() as m:
        m.setattr(chat_module, "AsyncAnthropic", fake, raising=False)
        # Force the lazy SDK import to hit our stub.
        import sys

        m.setitem(sys.modules, "anthropic", MagicMock(AsyncAnthropic=fake))
        client = resolve_anthropic_client()
    assert client is fake.return_value
    # Blank → Anthropic's own API, passed explicitly (test_anthropic_client.py).
    fake.assert_called_once_with(api_key="sk-test", base_url="https://api.anthropic.com")


def test_resolve_client_passes_base_url_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example.com")
    settings_module.get_settings.cache_clear()
    fake = MagicMock()
    with pytest.MonkeyPatch.context() as m:
        import sys

        m.setitem(sys.modules, "anthropic", MagicMock(AsyncAnthropic=fake))
        resolve_anthropic_client()
    fake.assert_called_once_with(api_key="sk-test", base_url="https://proxy.example.com")


def test_delta_pair_from_event_filters_unknown() -> None:
    """The duck-typed helper should ignore events that aren't a
    `content_block_delta` or whose delta type is something we don't
    surface (input_json_delta, citations_delta, signature_delta)."""
    from agent_py.chat_loop import _delta_pair_from_event

    # Non-delta event types.
    assert _delta_pair_from_event(SimpleNamespace(type="message_start")) is None
    assert _delta_pair_from_event(SimpleNamespace(type="content_block_stop")) is None
    # Delta event but unrecognised inner type.
    other = SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="input_json_delta", partial_json="{}"),
    )
    assert _delta_pair_from_event(other) is None
    # Empty text is dropped (no SSE noise for blank deltas).
    empty = SimpleNamespace(
        type="content_block_delta",
        delta=SimpleNamespace(type="text_delta", text=""),
    )
    assert _delta_pair_from_event(empty) is None
    # Happy paths.
    assert _delta_pair_from_event(_text_event("hi")) == ("text", "hi")
    assert _delta_pair_from_event(_thinking_event("hmm")) == ("reasoning", "hmm")


# --- Follow-up suggestions (PLAN-useChat-adoption.md Phase B.1d) ------


def test_parse_suggestions_json_happy_path() -> None:
    from agent_py.chat import parse_suggestions_json

    out = parse_suggestions_json('["one", "two", "three"]')
    assert out == ["one", "two", "three"]


def test_parse_suggestions_json_strips_markdown_fences() -> None:
    from agent_py.chat import parse_suggestions_json

    out = parse_suggestions_json('```json\n["a", "b"]\n```')
    assert out == ["a", "b"]


def test_parse_suggestions_json_caps_at_three() -> None:
    from agent_py.chat import parse_suggestions_json

    out = parse_suggestions_json('["a", "b", "c", "d", "e"]')
    assert out == ["a", "b", "c"]


def test_parse_suggestions_json_drops_empty_and_overlong() -> None:
    from agent_py.chat import parse_suggestions_json

    raw = json.dumps(["ok", "  ", "x" * 200, "fine"])
    out = parse_suggestions_json(raw)
    # Trimmed empty + overlong (>120 chars) entries get dropped.
    assert out == ["ok", "fine"]


def test_parse_suggestions_json_invalid_yields_empty() -> None:
    from agent_py.chat import parse_suggestions_json

    assert parse_suggestions_json("not json") == []
    assert parse_suggestions_json('{"not": "a list"}') == []
    assert parse_suggestions_json("") == []
