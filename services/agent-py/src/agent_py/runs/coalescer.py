"""Delta coalescing on the emit path (Q30).

The run event log is a replay buffer: storing every model delta as its
own entry would mean one insert per few characters. `CoalescingEmitter`
is a `RunEmitter` that buffers consecutive `token` deltas of one channel
and appends them as **one** entry — before they get a seq, so the log is
never renumbered and nothing is reordered:

  * a buffered delta run is given its seq the moment anything else is
    emitted (any non-token event, a token on the other channel or of a
    later step) — it takes the seq *before* that event's;
  * otherwise it is flushed `flush_interval` after its first delta
    (~100 to 250 ms; default 150 ms), when it reaches `max_chars`, or on
    `flush()` / `aclose()`.

Appends reach the sink strictly in seq order, one at a time (a timer
flush and an emit never interleave), so a reader polling the log by
`seq > cursor` cannot skip an entry that commits late.

It is a drop-in for `RunEmitter` (the harness contract takes one):

    emitter = CoalescingEmitter(run_id=run.id, sink=log.append, start_seq=seq)
    try:
        result = await harness.run(run_input, emitter, cancel)
        ...                         # terminal entries via the emitter
    finally:
        await emitter.aclose()      # flush what is buffered, stop the timer

`token()` returns once the delta is buffered; every other emit returns
once its event (and any delta buffered before it) is in the sink. A sink
failure propagates to the call that drained the failed event, which
stays queued: the next emit retries it (`RunEventLog.append` is
idempotent), so a transient error never punches a hole in the numbering.

This sits *beside* `agent_py.coalescer.TokenCoalescer`, the size-based
buffer the Anthropic provider applies to the raw model stream; both may
be stacked (that one bounds chunk size, this one bounds entry rate).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from typing import Literal

import structlog

from ..emitter import EventSink, RunEmitter, _now_iso
from ..events import TaskEvent, TokenEvent

__all__ = ["DEFAULT_FLUSH_INTERVAL", "DEFAULT_MAX_CHARS", "CoalescingEmitter"]

DEFAULT_FLUSH_INTERVAL = 0.15
"""Seconds from a run of deltas' first delta to its flush (Q30: 100 to 250 ms)."""

DEFAULT_MAX_CHARS = 4096
"""A buffered run of deltas is flushed once it holds this many characters."""

_log = structlog.get_logger(__name__)


class CoalescingEmitter(RunEmitter):
    """`RunEmitter` whose `token` deltas are merged before they get a seq."""

    def __init__(
        self,
        *,
        run_id: str,
        sink: EventSink,
        start_seq: int = 0,
        start_step: int = 0,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        max_chars: int = DEFAULT_MAX_CHARS,
    ) -> None:
        super().__init__(run_id=run_id, sink=sink, start_seq=start_seq, start_step=start_step)
        self._flush_interval = flush_interval
        self._max_chars = max(1, max_chars)
        self._pending: list[str] = []
        self._pending_chars = 0
        self._pending_channel: Literal["text", "reasoning"] = "text"
        self._pending_step = 0
        self._pending_at = ""
        # Events that have a seq but are not in the sink yet, in seq order.
        self._outbox: deque[TaskEvent] = deque()
        self._drain_lock = asyncio.Lock()
        self._timer: asyncio.Task[None] | None = None

    @property
    def buffered(self) -> str:
        """The deltas waiting for a seq (for tests and diagnostics)."""
        return "".join(self._pending)

    async def token(self, text: str, *, channel: Literal["text", "reasoning"] = "text") -> None:
        if self.settled or not text:
            return
        if self._pending and (channel != self._pending_channel or self._pending_step != self.step):
            self._materialize()
        if not self._pending:
            self._pending_channel = channel
            self._pending_step = self.step
            self._pending_at = _now_iso()
        self._pending.append(text)
        self._pending_chars += len(text)
        if self._pending_chars >= self._max_chars:
            self._materialize()
        if self._outbox:
            await self._drain()
        if self._pending:
            self._arm_timer()

    async def flush(self) -> None:
        """Give the buffered deltas their seq and wait until everything
        emitted so far is in the sink."""
        self._materialize()
        await self._drain()

    async def aclose(self) -> None:
        """`flush()`, then stop the timer. Call once the harness returned
        (a `Yielded` run writes no terminal entry that would flush)."""
        try:
            await self.flush()
        finally:
            timer, self._timer = self._timer, None
            if timer is not None and timer is not asyncio.current_task():
                timer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await timer

    # --- RunEmitter hooks ----------------------------------------------------------
    #
    # Every RunEmitter method stamps its event with `self._next_seq()` and
    # hands it to `self._emit` with no await in between. Taking the
    # buffered deltas' seq inside `_next_seq` therefore orders them before
    # the event that asked, whichever method (present or future) it is.

    def _next_seq(self) -> int:
        self._materialize()
        return super()._next_seq()

    async def _emit(self, event: TaskEvent) -> None:
        self._outbox.append(event)
        await self._drain()

    # --- internals -------------------------------------------------------------------

    def _materialize(self) -> None:
        if not self._pending:
            return
        text = "".join(self._pending)
        self._pending.clear()
        self._pending_chars = 0
        self._outbox.append(
            TokenEvent(
                run_id=self._run_id,
                seq=super()._next_seq(),
                step=self._pending_step,
                created_at=self._pending_at,
                text=text,
                channel=self._pending_channel,
            )
        )

    async def _drain(self) -> None:
        async with self._drain_lock:
            while self._outbox:
                await self._sink(self._outbox[0])
                self._outbox.popleft()

    def _arm_timer(self) -> None:
        if self._timer is None or self._timer.done():
            self._timer = asyncio.create_task(self._flush_later())

    async def _flush_later(self) -> None:
        await asyncio.sleep(self._flush_interval)
        if self._timer is asyncio.current_task():
            self._timer = None
        try:
            await self.flush()
        except Exception:
            # The event stays queued; the next emit retries it and raises.
            _log.warning("runs.coalescer.timer_flush_failed", run_id=self._run_id, exc_info=True)
