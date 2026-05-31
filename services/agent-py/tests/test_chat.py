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
from typing import Any
from unittest.mock import MagicMock

import pytest

from agent_py import chat as chat_module
from agent_py import settings as settings_module
from agent_py.chat import (
    ChatConfig,
    ChatMessage,
    chat_stream,
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


class _FakeStream:
    """Stand-in for the Anthropic SDK's `messages.stream` async context
    manager. Yields a sequence of text deltas, then completes."""

    def __init__(self, deltas: list[str], raises: Exception | None = None) -> None:
        self._deltas = deltas
        self._raises = raises

    async def __aenter__(self) -> _FakeStream:
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[str]:
        if self._raises is not None:
            raise self._raises
        for d in self._deltas:
            yield d


class _FakeMessages:
    def __init__(self, stream: _FakeStream) -> None:
        self._stream = stream
        self.calls: list[dict[str, Any]] = []

    def stream(self, **kwargs: Any) -> _FakeStream:
        self.calls.append(kwargs)
        return self._stream


class _FakeClient:
    def __init__(self, deltas: list[str], raises: Exception | None = None) -> None:
        self.messages = _FakeMessages(_FakeStream(deltas, raises))


def _config(model: str = "claude-3-5-sonnet-20241022", system: str | None = None) -> ChatConfig:
    return ChatConfig(
        model=model,
        messages=[ChatMessage(role="user", content="hi")],
        system=system,
    )


@pytest.mark.asyncio
async def test_chat_stream_emits_text_then_done() -> None:
    client = _FakeClient(["Hello", " world", "!"])
    frames = [f async for f in chat_stream(client=client, config=_config())]
    payloads = [json.loads(f.removeprefix("data: ").rstrip()) for f in frames]
    assert payloads == [
        {"type": "text", "value": "Hello"},
        {"type": "text", "value": " world"},
        {"type": "text", "value": "!"},
        {"type": "done"},
    ]


@pytest.mark.asyncio
async def test_chat_stream_error_frame_stops_emission() -> None:
    client = _FakeClient([], raises=RuntimeError("rate limited"))
    frames = [f async for f in chat_stream(client=client, config=_config())]
    assert len(frames) == 1
    payload = json.loads(frames[0].removeprefix("data: ").rstrip())
    assert payload["type"] == "error"
    assert payload["code"] == "upstream"
    assert "rate limited" in payload["message"]


@pytest.mark.asyncio
async def test_chat_stream_forwards_system_prompt() -> None:
    client = _FakeClient(["ok"])
    cfg = _config(system="You are a helpful test bot.")
    _ = [f async for f in chat_stream(client=client, config=cfg)]
    assert client.messages.calls[0].get("system") == "You are a helpful test bot."


@pytest.mark.asyncio
async def test_chat_stream_omits_system_kwarg_when_unset() -> None:
    """Don't pass `system=None` — Anthropic would treat that
    differently from "no system at all". Omit the kwarg entirely."""
    client = _FakeClient(["ok"])
    _ = [f async for f in chat_stream(client=client, config=_config())]
    assert "system" not in client.messages.calls[0]


@pytest.mark.asyncio
async def test_chat_stream_passes_max_tokens_and_messages() -> None:
    client = _FakeClient(["x"])
    cfg = ChatConfig(
        model="m",
        messages=[
            ChatMessage(role="user", content="a"),
            ChatMessage(role="assistant", content="b"),
            ChatMessage(role="user", content="c"),
        ],
        max_tokens=512,
    )
    _ = [f async for f in chat_stream(client=client, config=cfg)]
    call = client.messages.calls[0]
    assert call["max_tokens"] == 512
    assert call["model"] == "m"
    assert call["messages"] == [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]


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
    failure."""
    client = _FakeClient([], raises=RuntimeError("rate limited"))
    frames = [f async for f in chat_stream_ai_sdk(client=client, config=_config())]
    payloads = _parse_ai_sdk_frames(frames)
    types = [p["type"] if isinstance(p, dict) else p for p in payloads]
    assert types == [
        "start",
        "start-step",
        "text-start",
        "text-end",
        "error",
        "[DONE]",
    ]
    error_payload = payloads[4]
    assert error_payload["errorText"] == "rate limited"


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

        @property
        def text_stream(self) -> AsyncIterator[str]:
            return self._iter()

        async def _iter(self) -> AsyncIterator[str]:
            yield "first chunk "
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
