"""Per-channel token buffer with byte-size flushing.

Mirror of `makeTokenCoalescer` in `lib/server/agent/runner.ts`. A model
stream produces a token every few characters; emitting each as its own
`task_events` row would mean one DB insert per token, with the Realtime
publication fanning out hundreds of rows per second. The coalescer
buffers tokens by channel (text / reasoning) and flushes when:

  - the buffer crosses `flush_chars` (default 96, matches TS),
  - the producer switches channel (e.g. reasoning → text), or
  - the consumer explicitly calls `flush_all()` (at step end, before
    a non-token event, or at stream end).

Pure module — no I/O. The emitter is passed in as a thin protocol so
tests can use a fake.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

TokenChannel = Literal["text", "reasoning"]

DEFAULT_FLUSH_CHARS = 96
"""Same default as the TS coalescer — small enough that streaming reads
as smooth, large enough to drop per-token DB writes by ~30x."""


class TokenSink(Protocol):
    """The minimum the coalescer needs from an emitter. Lets tests swap
    a list-collecting fake without instantiating the full RunEmitter.
    """

    async def __call__(self, text: str, *, channel: TokenChannel) -> None: ...


def make_token_coalescer(
    emit_token: TokenSink,
    *,
    flush_chars: int = DEFAULT_FLUSH_CHARS,
) -> TokenCoalescer:
    """Build a fresh coalescer bound to one emitter. Callers typically
    wrap `emitter.token` (passed as a closure that fixes the channel
    kwarg) so the coalescer doesn't reach into RunEmitter internals.
    """
    return TokenCoalescer(emit_token, flush_chars)


class TokenCoalescer:
    """State for one run's token stream. Not thread-safe; the runner
    consumes the stream sequentially anyway."""

    def __init__(self, emit_token: TokenSink, flush_chars: int) -> None:
        self._emit = emit_token
        self._flush_chars = max(1, flush_chars)
        self._text = ""
        self._reasoning = ""

    async def push(self, channel: TokenChannel, delta: str) -> None:
        """Append a delta on the named channel. Flushes the other
        channel first if it has buffered text — keeps text + reasoning
        correctly interleaved, mirroring the TS behaviour."""
        if not delta:
            return
        if channel == "text":
            await self._flush("reasoning")
            self._text += delta
            if len(self._text) >= self._flush_chars:
                await self._flush("text")
        else:
            await self._flush("text")
            self._reasoning += delta
            if len(self._reasoning) >= self._flush_chars:
                await self._flush("reasoning")

    async def flush_all(self) -> None:
        """Flush both channels in canonical order (text first). Called
        at step boundaries, on stream end, and before any non-token
        event (the runner enforces this; the coalescer doesn't try to
        figure out the right moment on its own)."""
        await self._flush("text")
        await self._flush("reasoning")

    async def _flush(self, channel: TokenChannel) -> None:
        if channel == "text" and self._text:
            buf, self._text = self._text, ""
            await self._emit(buf, channel="text")
        elif channel == "reasoning" and self._reasoning:
            buf, self._reasoning = self._reasoning, ""
            await self._emit(buf, channel="reasoning")


__all__ = [
    "DEFAULT_FLUSH_CHARS",
    "TokenChannel",
    "TokenCoalescer",
    "TokenSink",
    "make_token_coalescer",
]


# Re-export typing aid for emitter-bound callers.
TokenEmit = Callable[[str], Awaitable[None]]
