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
