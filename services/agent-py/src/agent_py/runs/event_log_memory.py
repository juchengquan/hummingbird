"""`RunEventLog` for anonymous runs — process memory, short-lived (Q16, Q20).

Anonymous runs are interactive and execute in the process that started
them (Q28), so their log lives there too and is never written to
Postgres. RUN_EVENTS.md § 8: same events, same encoder, same stream
rules; the log is never compacted and is dropped about 15 minutes after
the run ends; a process restart loses it.

**Lifetime.** A run "ends" for this log when it is `seal`ed (the run
driver seals after writing the terminal entries). Its entries are
dropped `ttl` (default 15 min) after that. A run that is never sealed
(a driver bug, a crashed task) is dropped once nothing was appended to
it for `idle_ttl` (default 2 h — longer than any interactive lease).
Expiry is checked lazily on every call, so no background task is
needed; `sweep()` runs the same check on demand.

**Memory bounds.** Each entry is charged the length of its JSON payload
plus `ENTRY_OVERHEAD` bytes.

  * per run: at most `max_entries_per_run` entries (default 5 000) and
    `max_bytes_per_run` bytes (default 8 MiB);
  * in total: `max_total_bytes` (default 256 MiB). When an append would
    pass it, sealed runs are evicted oldest-sealed first; if live runs
    alone fill it, the append is refused.

A refused append raises `RunLogFull`, except for the entries that end a
run (`result`, `status`, `approval`), which are always accepted so a run
that hit a cap can still be failed and read to its end. The run driver
treats `RunLogFull` like any harness failure (fail the run).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from ..events import MessagesSnapshotEvent, TaskEvent, event_to_row_payload
from .event_log import SeqConflict

__all__ = [
    "DEFAULT_IDLE_TTL",
    "DEFAULT_MAX_BYTES_PER_RUN",
    "DEFAULT_MAX_ENTRIES_PER_RUN",
    "DEFAULT_MAX_TOTAL_BYTES",
    "DEFAULT_TTL",
    "ENTRY_OVERHEAD",
    "MemoryRunEventLog",
    "RunLogFull",
]

DEFAULT_TTL = 15 * 60.0
DEFAULT_IDLE_TTL = 2 * 60 * 60.0
DEFAULT_MAX_ENTRIES_PER_RUN = 5_000
DEFAULT_MAX_BYTES_PER_RUN = 8 * 1024 * 1024
DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
ENTRY_OVERHEAD = 256
"""Bytes charged per entry on top of its payload (object + dict slot)."""

_ALWAYS_ACCEPTED = frozenset({"result", "status", "approval"})


class RunLogFull(RuntimeError):
    """An append would pass a memory cap (see the module docstring)."""


@dataclass
class _Run:
    entries: dict[int, TaskEvent] = field(default_factory=dict)
    sizes: dict[int, int] = field(default_factory=dict)
    bytes: int = 0
    touched_at: float = 0.0
    sealed_at: float | None = None
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)


def _entry_size(event: TaskEvent) -> int:
    payload = json.dumps(event_to_row_payload(event), separators=(",", ":"), ensure_ascii=False)
    return len(payload.encode()) + ENTRY_OVERHEAD


class MemoryRunEventLog:
    """`RunEventLog` in this process's memory, with a TTL and caps."""

    def __init__(
        self,
        *,
        ttl: float = DEFAULT_TTL,
        idle_ttl: float = DEFAULT_IDLE_TTL,
        tick: float = 0.25,
        max_entries_per_run: int = DEFAULT_MAX_ENTRIES_PER_RUN,
        max_bytes_per_run: int = DEFAULT_MAX_BYTES_PER_RUN,
        max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl = ttl
        self._idle_ttl = idle_ttl
        self._tick = tick
        self._max_entries = max_entries_per_run
        self._max_run_bytes = max_bytes_per_run
        self._max_total = max_total_bytes
        self._clock = clock
        self._runs: dict[str, _Run] = {}
        self._total = 0
        self._swept_at = clock()

    @property
    def total_bytes(self) -> int:
        """Bytes currently charged across every run."""
        return self._total

    # --- lifetime --------------------------------------------------------------------

    def _expired(self, run: _Run, now: float) -> bool:
        if run.sealed_at is not None:
            return now - run.sealed_at >= self._ttl
        return now - run.touched_at >= self._idle_ttl

    def _drop(self, run_id: str) -> None:
        run = self._runs.pop(run_id, None)
        if run is None:
            return
        self._total -= run.bytes
        # Subscribers notice within a tick (each loop re-checks the run).

    def sweep(self) -> int:
        """Drop every expired run now; returns how many were dropped.
        `append` runs it at most once a second; reads expire their own
        run on access."""
        now = self._clock()
        self._swept_at = now
        expired = [rid for rid, run in self._runs.items() if self._expired(run, now)]
        for rid in expired:
            self._drop(rid)
        return len(expired)

    def _live(self, run_id: str) -> _Run | None:
        run = self._runs.get(run_id)
        if run is not None and self._expired(run, self._clock()):
            self._drop(run_id)
            return None
        return run

    # --- RunEventLog -----------------------------------------------------------------

    async def append(self, event: TaskEvent) -> int:
        if event.seq < 1:
            raise ValueError("seq must be >= 1")
        if self._clock() - self._swept_at >= 1.0:
            self.sweep()
        run = self._runs.get(event.run_id)
        if run is None:
            run = self._runs[event.run_id] = _Run(touched_at=self._clock())
        if run.sealed_at is not None:
            raise RuntimeError(f"run {event.run_id} is sealed")
        if event.seq in run.entries:
            return event.seq
        size = _entry_size(event)
        if event.kind not in _ALWAYS_ACCEPTED:
            if len(run.entries) >= self._max_entries:
                raise RunLogFull(f"run {event.run_id}: more than {self._max_entries} entries")
            if run.bytes + size > self._max_run_bytes:
                raise RunLogFull(f"run {event.run_id}: more than {self._max_run_bytes} bytes")
            if self._total + size > self._max_total:
                self._evict_sealed(self._total + size - self._max_total)
                if self._total + size > self._max_total:
                    raise RunLogFull("anonymous run logs are at their memory cap")
        run.entries[event.seq] = event
        run.sizes[event.seq] = size
        run.bytes += size
        self._total += size
        run.touched_at = self._clock()
        async with run.cond:
            run.cond.notify_all()
        return event.seq

    def _evict_sealed(self, need: int) -> None:
        sealed = sorted(
            (r.sealed_at, rid) for rid, r in self._runs.items() if r.sealed_at is not None
        )
        freed = 0
        for _, rid in sealed:
            if freed >= need:
                break
            freed += self._runs[rid].bytes
            self._drop(rid)

    async def read(
        self, run_id: str, *, after_seq: int = 0, limit: int | None = None
    ) -> list[TaskEvent]:
        run = self._live(run_id)
        if run is None:
            return []
        out = [run.entries[s] for s in sorted(run.entries) if s > after_seq]
        return out if limit is None else out[:limit]

    async def subscribe(self, run_id: str, *, after_seq: int = 0) -> AsyncIterator[list[TaskEvent]]:
        cursor = after_seq
        while True:
            run = self._live(run_id)
            if run is None:
                return
            timed_out = False
            async with run.cond:
                batch = await self.read(run_id, after_seq=cursor)
                if not batch and run.sealed_at is None:
                    try:
                        await asyncio.wait_for(run.cond.wait(), timeout=self._tick)
                    except TimeoutError:
                        timed_out = True
            if batch:
                cursor = batch[-1].seq
                yield batch
            elif run.sealed_at is not None or self._runs.get(run_id) is not run:
                tail = await self.read(run_id, after_seq=cursor)
                if tail:
                    yield tail
                return
            elif timed_out:
                yield []

    async def seal(self, run_id: str) -> None:
        run = self._live(run_id)
        if run is None:
            # Nothing was ever appended: remember the seal so a late append
            # still raises, and let it expire like any sealed run.
            run = self._runs[run_id] = _Run(touched_at=self._clock())
        if run.sealed_at is None:
            run.sealed_at = self._clock()
        async with run.cond:
            run.cond.notify_all()

    async def last_seq(self, run_id: str) -> int:
        run = self._live(run_id)
        return max(run.entries, default=0) if run is not None else 0

    async def compact(self, run_id: str, snapshot: MessagesSnapshotEvent) -> bool:
        """Implemented for the Protocol's sake; anonymous logs are never
        compacted (RUN_EVENTS.md § 8) — they expire first."""
        run = self._live(run_id)
        entries = run.entries if run is not None else {}
        existing = entries.get(snapshot.seq)
        if isinstance(existing, MessagesSnapshotEvent) or any(
            isinstance(e, MessagesSnapshotEvent) and s > snapshot.seq for s, e in entries.items()
        ):
            return False
        if run is None or existing is None:
            raise SeqConflict(f"no entry at seq {snapshot.seq} to replace")
        for s in [s for s in entries if s <= snapshot.seq]:
            del entries[s]
            size = run.sizes.pop(s)
            run.bytes -= size
            self._total -= size
        size = _entry_size(snapshot)
        entries[snapshot.seq] = snapshot
        run.sizes[snapshot.seq] = size
        run.bytes += size
        self._total += size
        return True

    async def purge(self, run_id: str) -> None:
        run = self._runs.get(run_id)
        if run is None:
            return
        self._total -= run.bytes
        run.entries.clear()
        run.sizes.clear()
        run.bytes = 0
