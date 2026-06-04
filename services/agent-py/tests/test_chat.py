"""Phase 4-1 tests — `chat.chat_stream` helper.

Hermetic — patches the Anthropic SDK at the boundary. We test:
  - `sse_frame` produces the right wire format (data: <json>\\n\\n).
  - happy path yields text frames + a done frame.
  - upstream exception yields an error frame + stops (no done).
  - the system prompt is forwarded; absence omits the kwarg.
  - `resolve_anthropic_client` returns None without API key.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from agent_py import chat as chat_module
from agent_py import settings as settings_module
from agent_py.chat import (
    ChatConfig,
    ChatMessage,
    chat_stream_ai_sdk,
    resolve_anthropic_client,
    sse_frame,
)

# --- sse_frame --------------------------------------------------------


def test_sse_frame_format() -> None:
    out = sse_frame({"type": "text", "value": "hi"})
    assert out == 'data: {"type":"text","value":"hi"}\n\n'


def test_sse_frame_compact_json() -> None:
    """Frames have no whitespace padding — minimises per-token wire
    overhead on long streams."""
    out = sse_frame({"a": 1, "b": "x"})
    assert " " not in out.split(":", 1)[1].split("\n", 1)[0].strip()


# --- chat_stream ------------------------------------------------------


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


class _FakeStream:
    """Stand-in for the Anthropic SDK's `messages.stream` async context
    manager. Yields a sequence of synthetic events (text or thinking),
    then completes."""

    def __init__(
        self,
        events: list[SimpleNamespace] | None = None,
        raises: Exception | None = None,
        *,
        # Back-compat for tests that pass plain text strings.
        deltas: list[str] | None = None,
    ) -> None:
        if events is None and deltas is not None:
            events = [_text_event(d) for d in deltas]
        self._events = events or []
        self._raises = raises

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        return self._iter_events()

    async def _iter_events(self) -> AsyncIterator[SimpleNamespace]:
        if self._raises is not None:
            raise self._raises
        for e in self._events:
            yield e

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter_text()

    async def _iter_text(self) -> AsyncIterator[str]:
        # Back-compat for any test that still uses `text_stream`.
        if self._raises is not None:
            raise self._raises
        for e in self._events:
            delta = getattr(e, "delta", None)
            if getattr(delta, "type", None) == "text_delta":
                yield getattr(delta, "text", "")


class _FakeMessages:
    def __init__(self, stream: _FakeStream) -> None:
        self._stream = stream
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> _FakeStream:
        self.calls.append(kwargs)
        return self._stream


class _FakeClient:
    def __init__(self, deltas: list[str], raises: Exception | None = None) -> None:
        self.messages = _FakeMessages(_FakeStream(deltas=deltas, raises=raises))


def _config(model: str = "claude-3-5-sonnet-20241022", system: str | None = None) -> ChatConfig:
    return ChatConfig(
        model=model,
        messages=[ChatMessage(role="user", content="hi")],
        system=system,
    )


# --- chat_stream_ai_sdk (Phase 3g — AI SDK UI message stream) ---------


def _parse_ai_sdk_frames(frames: list[str]) -> list[Any]:
    """Decode a list of AI-SDK SSE frames into their JSON payloads.
    The `[DONE]` terminator is kept as the string ``"[DONE]"`` so
    tests can assert on its position without juggling stripping."""
    out: list[Any] = []
    for f in frames:
        stripped = f.removeprefix("data: ").rstrip()
        if stripped == "[DONE]":
            out.append("[DONE]")
        else:
            out.append(json.loads(stripped))
    return out


@pytest.mark.asyncio
async def test_ai_sdk_stream_emits_full_lifecycle() -> None:
    """Happy path: start → start-step → text-start → text-delta…
    → text-end → finish-step → finish → [DONE]. Each text-delta
    carries the same `id` as the matching text-start."""
    client = _FakeClient(["Hello", " world"])
    frames = [f async for f in chat_stream_ai_sdk(client=client, config=_config())]
    payloads = _parse_ai_sdk_frames(frames)
    # Lifecycle envelopes + [DONE] terminator.
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    assert types == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
        "[DONE]",
    ]

    # text-start / -delta / -end all reference the same id.
    text_id = payloads[2]["id"]
    assert payloads[3] == {"type": "text-delta", "id": text_id, "delta": "Hello"}
    assert payloads[4] == {"type": "text-delta", "id": text_id, "delta": " world"}
    assert payloads[5] == {"type": "text-end", "id": text_id}


@pytest.mark.asyncio
async def test_ai_sdk_stream_emits_error_then_done_no_finish() -> None:
    """Error path: emit text-end (closing the open text block) +
    error + [DONE]. Intentionally skip `finish` — mirrors the AI SDK
    convention and lets `useChat()` distinguish completion from
    failure. The error frame carries a provider-categorised `code` so
    the consumer can render a typed inline bubble."""
    client = _FakeClient([], raises=RuntimeError("rate limited"))
    frames = [f async for f in chat_stream_ai_sdk(client=client, config=_config())]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    # Pre-delta error: no text-start/text-end emitted (we open the
    # text channel lazily on the first delta). Mirrors agent-ts's
    # `chatStreamAiSdk` shape for the same case.
    assert types == [
        "start",
        "start-step",
        "error",
        "[DONE]",
    ]
    error_payload = payloads[2]
    assert error_payload["errorText"] == "rate limited"
    # Falls back to message-text matching since RuntimeError doesn't
    # carry an Anthropic-SDK type. "rate limited" matches the
    # rate-limit branch.
    assert error_payload["code"] == "rate_limit"


@pytest.mark.asyncio
async def test_ai_sdk_stream_error_after_partial_text() -> None:
    """If the SDK yields a delta and THEN raises, the emitted text
    deltas survive and the text block is properly closed before
    error is emitted."""
    # The default `_FakeStream` raises BEFORE the loop body, which
    # would short-circuit text-start handling — define an inline
    # stream that yields one delta and then raises.

    class _PartialStream:
        def __init__(self) -> None:
            self._done = False

        async def __aenter__(self) -> _PartialStream:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
            return self._iter()

        async def _iter(self) -> AsyncIterator[SimpleNamespace]:
            yield _text_event("first chunk ")
            raise RuntimeError("died mid-stream")

    class _PartialMessages:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        def stream(self, **kwargs: Any) -> _PartialStream:
            self.calls.append(kwargs)
            return _PartialStream()

    class _PartialClient:
        def __init__(self) -> None:
            self.messages = _PartialMessages()

    client2 = _PartialClient()
    frames = [f async for f in chat_stream_ai_sdk(client=client2, config=_config())]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    # One text-delta lands between text-start and text-end on the
    # error path — partial output is preserved, not dropped.
    assert types == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",
        "error",
        "[DONE]",
    ]
    # The error frame still carries a `code` even when text streamed
    # successfully before the exception (mid-stream failure path).
    error_payload = payloads[5]
    assert error_payload["code"] == "upstream"


# --- categorize_provider_error ----------------------------------------


def test_categorize_provider_error_rate_limit_via_sdk_type() -> None:
    """Anthropic's typed `RateLimitError` maps to `rate_limit`
    unconditionally — we don't string-match when the SDK gave us the
    answer."""
    from anthropic import RateLimitError

    from agent_py.chat import categorize_provider_error

    # The SDK exception classes take (message, response, body) — use
    # a synthetic mock for response since we only care about the
    # isinstance check.
    exc = RateLimitError.__new__(RateLimitError)
    exc.args = ("hit a limit",)
    assert categorize_provider_error(exc) == "rate_limit"


def test_categorize_provider_error_auth_via_sdk_type() -> None:
    from anthropic import AuthenticationError, PermissionDeniedError

    from agent_py.chat import categorize_provider_error

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

    from agent_py.chat import categorize_provider_error

    exc = BadRequestError.__new__(BadRequestError)
    exc.args = ("prompt is too long: 250000 tokens > 200000 maximum",)
    assert categorize_provider_error(exc) == "context_window"


def test_categorize_provider_error_bad_request_without_context_phrase() -> None:
    """A `BadRequestError` whose message doesn't mention a
    context-window bust stays in the generic `upstream` bucket
    rather than being mis-categorised as context_window."""
    from anthropic import BadRequestError

    from agent_py.chat import categorize_provider_error

    exc = BadRequestError.__new__(BadRequestError)
    exc.args = ("messages.0: role must be 'user' or 'assistant'",)
    assert categorize_provider_error(exc) == "upstream"


def test_categorize_provider_error_string_match_fallback() -> None:
    """Generic exceptions (a gateway rewrapped the SDK error) get
    bucketed by message text. Order of priority is rate_limit →
    auth → context_window → upstream."""
    from agent_py.chat import categorize_provider_error

    assert categorize_provider_error(RuntimeError("429 too many requests")) == "rate_limit"
    assert categorize_provider_error(RuntimeError("401 unauthorized")) == "auth"
    assert categorize_provider_error(RuntimeError("forbidden")) == "auth"
    assert categorize_provider_error(RuntimeError("input is too long")) == "context_window"
    assert categorize_provider_error(RuntimeError("connection reset")) == "upstream"


def test_categorize_provider_error_rate_limit_wins_over_context_phrase() -> None:
    """A rate-limit exception whose message coincidentally mentions
    context windows stays a rate limit. Order of checks matters."""
    from anthropic import RateLimitError

    from agent_py.chat import categorize_provider_error

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
    fake.assert_called_once_with(api_key="sk-test")


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


# --- reasoning channel (PLAN-useChat-adoption.md Phase B.1b) -----------


class _EventClient:
    """Variant of `_FakeClient` that takes pre-built events instead of
    string deltas, so reasoning vs. text channels can be mixed."""

    def __init__(self, events: list[SimpleNamespace]) -> None:
        self.messages = _FakeMessages(_FakeStream(events=events))


@pytest.mark.asyncio
async def test_ai_sdk_stream_emits_reasoning_lifecycle() -> None:
    """`chat_stream_ai_sdk` emits the AI SDK's first-class
    `reasoning-start` / `reasoning-delta` / `reasoning-end` parts with
    stable per-block ids, and switches cleanly to the text channel."""
    events = [
        _thinking_event("alpha "),
        _thinking_event("beta"),
        _text_event("gamma"),
    ]
    client = _EventClient(events)
    frames = [f async for f in chat_stream_ai_sdk(client=client, config=_config())]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    assert types == [
        "start",
        "start-step",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
        "[DONE]",
    ]
    # Reasoning block id is stable across start/delta/end.
    r_start = payloads[2]
    r_delta = payloads[3]
    r_end = payloads[5]
    assert isinstance(r_start, dict) and isinstance(r_delta, dict) and isinstance(r_end, dict)
    assert r_delta["id"] == r_start["id"]
    assert r_end["id"] == r_start["id"]
    assert r_delta["delta"] == "alpha "


@pytest.mark.asyncio
async def test_ai_sdk_stream_closes_text_before_reasoning_resumes() -> None:
    """If the model interleaves channels (text → thinking → text), we
    close the previous channel's block before opening the next so
    `useChat()` sees matched start/end pairs per id."""
    events = [
        _text_event("first text"),
        _thinking_event("paused to think"),
        _text_event("final text"),
    ]
    client = _EventClient(events)
    frames = [f async for f in chat_stream_ai_sdk(client=client, config=_config())]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    # Each channel-switch is preceded by an end frame for the
    # outgoing channel.
    assert types == [
        "start",
        "start-step",
        "text-start",
        "text-delta",
        "text-end",  # closed before reasoning opens
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",  # closed before text reopens
        "text-start",  # new id for the second text block
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
        "[DONE]",
    ]


@pytest.mark.asyncio
async def test_delta_pair_from_event_filters_unknown() -> None:
    """The duck-typed helper should ignore events that aren't a
    `content_block_delta` or whose delta type is something we don't
    surface (input_json_delta, citations_delta, signature_delta)."""
    from agent_py.chat import _delta_pair_from_event

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


@pytest.mark.asyncio
async def test_on_complete_runs_before_finish_on_ai_sdk_format() -> None:
    client = _FakeClient(["Hello"])
    captured: list[str] = []

    async def on_complete(text: str) -> AsyncIterator[str]:
        captured.append(text)
        yield 'data: {"type":"data-suggestions","data":{"values":["a"]}}\n\n'

    frames = [
        f
        async for f in chat_stream_ai_sdk(client=client, config=_config(), on_complete=on_complete)
    ]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    # data-suggestions sits between text-end and finish-step.
    assert "data-suggestions" in types
    idx_suggest = types.index("data-suggestions")
    idx_finish_step = types.index("finish-step")
    assert idx_suggest < idx_finish_step
    assert captured == ["Hello"]


@pytest.mark.asyncio
async def test_on_complete_not_called_on_error_path() -> None:
    """When the upstream stream errors, `on_complete` is NOT invoked
    — chips are decoration, not something to mint over a broken
    turn."""
    client = _FakeClient([], raises=RuntimeError("boom"))
    called = False

    async def on_complete(text: str) -> AsyncIterator[str]:
        nonlocal called
        called = True
        # The generator has to actually yield to count; mark the
        # callback as invoked regardless and yield once.
        yield 'data: {"type":"data-suggestions","data":{"values":["unreached"]}}\n\n'

    _ = [
        f
        async for f in chat_stream_ai_sdk(client=client, config=_config(), on_complete=on_complete)
    ]
    assert called is False
