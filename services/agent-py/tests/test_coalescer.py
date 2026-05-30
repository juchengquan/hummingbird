"""Tests for the token coalescer.

The coalescer's correctness story is the same as the TS version:
  - per-channel buffering with `flush_chars` threshold
  - channel switch flushes the other channel first
  - explicit `flush_all` at boundaries
  - empty deltas are no-ops
"""

from __future__ import annotations

import pytest

from agent_py.coalescer import (
    DEFAULT_FLUSH_CHARS,
    TokenChannel,
    make_token_coalescer,
)


class _ListSink:
    """Collects (text, channel) tuples for assertion."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    async def __call__(self, text: str, *, channel: TokenChannel) -> None:
        self.events.append((text, channel))


@pytest.mark.asyncio
async def test_flushes_at_threshold() -> None:
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=5)
    await co.push("text", "ab")
    await co.push("text", "cd")  # buffer = "abcd"
    assert sink.events == []
    await co.push("text", "ef")  # crosses 5 → flush
    assert sink.events == [("abcdef", "text")]


@pytest.mark.asyncio
async def test_channel_switch_flushes_other_first() -> None:
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=100)
    await co.push("text", "hello")
    await co.push("reasoning", "world")  # text flushed first
    await co.flush_all()
    assert sink.events == [("hello", "text"), ("world", "reasoning")]


@pytest.mark.asyncio
async def test_flush_all_flushes_both_channels() -> None:
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=100)
    # Push reasoning, then text — the second push triggers an inline
    # flush of the reasoning buffer (channel switch). Then flush_all
    # drains the text buffer. End order is therefore reasoning → text.
    await co.push("reasoning", "thinking")
    await co.push("text", "answer")
    await co.flush_all()
    assert sink.events == [("thinking", "reasoning"), ("answer", "text")]


@pytest.mark.asyncio
async def test_flush_all_with_only_text_buffered() -> None:
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=100)
    await co.push("text", "answer")
    await co.flush_all()
    assert sink.events == [("answer", "text")]


@pytest.mark.asyncio
async def test_empty_delta_is_noop() -> None:
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=5)
    await co.push("text", "")
    await co.flush_all()
    assert sink.events == []


@pytest.mark.asyncio
async def test_flush_all_on_empty_buffer_is_noop() -> None:
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=5)
    await co.flush_all()
    await co.flush_all()
    assert sink.events == []


@pytest.mark.asyncio
async def test_default_flush_chars_matches_ts() -> None:
    # Locked in: this is the same default as the TS coalescer.
    assert DEFAULT_FLUSH_CHARS == 96


@pytest.mark.asyncio
async def test_flush_chars_floor_at_one() -> None:
    """A nonsense `flush_chars=0` shouldn't lock the coalescer; cap
    to 1 so every push flushes."""
    sink = _ListSink()
    co = make_token_coalescer(sink, flush_chars=0)
    await co.push("text", "a")
    assert sink.events == [("a", "text")]
