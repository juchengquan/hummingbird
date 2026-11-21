"""RunEventLog — the numbered, replayable event log of a run (Q17, Q29, Q30).

The log stores internal events (`agent_py.events.TaskEvent`), one entry
per event, keyed by `(run_id, seq)`. It is a **replay buffer, not the
transcript**: a stream reads it to replay and follow a run; compaction
folds it once the run has ended; retention purges it. See
`packages/contract/RUN_EVENTS.md` §§ 6 to 8 for the rules the readers apply.

Implementations (wave 3b-A):
  * Postgres over `task_events` (signed-in runs), with the in-process
    fast path for `subscribe` and a ~250 ms poll fallback (Q29);
  * memory for anonymous runs, dropped ~15 min after the run ends (Q16).
`InMemoryRunEventLog` below is the reference fake: single process, no
TTL — what the Protocol promises, nothing more.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Protocol

from ..events import MessagesSnapshotEvent, TaskEvent

__all__ = ["InMemoryRunEventLog", "RunEventLog", "SeqConflict"]


class SeqConflict(Exception):
    """`compact` was asked to place a snapshot over entries it does not
    cover (see `RunEventLog.compact`)."""


class RunEventLog(Protocol):
    """Contract every run event log implements.

    **Numbering.** `seq` is assigned by the producer (`RunEmitter`), not
    by the log: 1, 2, … per run, no gaps, monotonic across a run's
    lifetime (a resumed background run continues its own numbering).
    Text deltas are coalesced *before* they get a seq (`coalescer.py`),
    so the log never renumbers.

    **Visibility.** An entry `append` returned for is visible to every
    later `read` / `last_seq` and is delivered to every `subscribe`r whose
    cursor is below it.
    """

    async def append(self, event: TaskEvent) -> int:
        """Store `event` at `(event.run_id, event.seq)` and return its seq.

        Idempotent: if that `(run_id, seq)` already holds an entry, the
        existing entry is kept unchanged and its seq returned (a retried
        emit, or two writers racing, never duplicates or overwrites).
        `seq` must be ≥ 1. Appending to a sealed run raises
        `RuntimeError` (the run is over; a late callback must not extend
        it)."""
        ...

    async def read(
        self, run_id: str, *, after_seq: int = 0, limit: int | None = None
    ) -> list[TaskEvent]:
        """Entries with `seq > after_seq`, ascending, at most `limit`.
        Superseded entries (RUN_EVENTS.md § 6.5) are returned like any
        other — dropping them is the reader's rule, not the log's. An
        unknown run reads as empty."""
        ...

    def subscribe(self, run_id: str, *, after_seq: int = 0) -> AsyncIterator[list[TaskEvent]]:
        """Follow the log: yields batches of entries with `seq > after_seq`,
        ascending and without repeats — first everything already stored,
        then new entries as they are appended.

        While nothing arrives it yields an **empty batch** at least every
        `tick` seconds (implementation-defined; the Postgres poll interval,
        ~0.25 s), so the consumer can re-check the run row and decide to
        stop — the log does not know when a run is over (the row does,
        RUN_EVENTS.md § 6.4).

        Iteration ends by itself only after `seal(run_id)` in the same
        process, once every entry has been yielded. Otherwise the
        consumer stops it (`break` / `aclose()`); that must release any
        resources (listeners, connections) promptly."""
        ...

    async def seal(self, run_id: str) -> None:
        """No entry will be appended to `run_id` again (the run ended and
        its terminal entry is written). In-process subscribers drain and
        stop; later `append`s raise. Idempotent. A reader in another
        process does not see the seal — it stops on the run row."""
        ...

    async def last_seq(self, run_id: str) -> int:
        """Highest stored seq, 0 when the log is empty or purged
        (`Run.lastSeq`)."""
        ...

    async def compact(self, run_id: str, snapshot: MessagesSnapshotEvent) -> bool:
        """Atomically replace every entry with `seq <= snapshot.seq` by
        `snapshot` (stored at `snapshot.seq`). The caller computes the
        snapshot (RUN_EVENTS.md § 7: `snapshot.seq` = the highest folded
        seq `C`, its messages = the fold of the entries below the run's
        first closing entry, superseded ones excluded).

        Returns False and changes nothing when the log is already
        compacted at or past `snapshot.seq` (idempotent re-run). Raises
        `SeqConflict` when `snapshot.seq` is not the seq of a stored entry
        (it must replace one, so the numbering stays gap-free from the
        reader's point of view)."""
        ...

    async def purge(self, run_id: str) -> None:
        """Delete every entry of the run (retention, Q30). The run row
        stays; a rejoin then answers `gap { reason: "purged" }`.
        Idempotent."""
        ...


class InMemoryRunEventLog:
    """`RunEventLog` in one process's memory. Reference fake for tests;
    also a reasonable base for the anonymous-run log (add the TTL)."""

    def __init__(self, *, tick: float = 0.25) -> None:
        self._tick = tick
        self._entries: dict[str, dict[int, TaskEvent]] = {}
        self._sealed: set[str] = set()
        self._changed: dict[str, asyncio.Condition] = {}

    def _cond(self, run_id: str) -> asyncio.Condition:
        cond = self._changed.get(run_id)
        if cond is None:
            cond = self._changed[run_id] = asyncio.Condition()
        return cond

    async def append(self, event: TaskEvent) -> int:
        if event.seq < 1:
            raise ValueError("seq must be >= 1")
        if event.run_id in self._sealed:
            raise RuntimeError(f"run {event.run_id} is sealed")
        entries = self._entries.setdefault(event.run_id, {})
        if event.seq not in entries:
            entries[event.seq] = event
            cond = self._cond(event.run_id)
            async with cond:
                cond.notify_all()
        return event.seq

    async def read(
        self, run_id: str, *, after_seq: int = 0, limit: int | None = None
    ) -> list[TaskEvent]:
        entries = self._entries.get(run_id, {})
        out = [entries[s] for s in sorted(entries) if s > after_seq]
        return out if limit is None else out[:limit]

    async def subscribe(self, run_id: str, *, after_seq: int = 0) -> AsyncIterator[list[TaskEvent]]:
        cursor = after_seq
        cond = self._cond(run_id)
        while True:
            timed_out = False
            # Read and wait under the lock `append` notifies under, so an
            # entry appended between the two cannot be missed.
            async with cond:
                batch = await self.read(run_id, after_seq=cursor)
                if not batch and run_id not in self._sealed:
                    try:
                        await asyncio.wait_for(cond.wait(), timeout=self._tick)
                    except TimeoutError:
                        timed_out = True
            if batch:
                cursor = batch[-1].seq
                yield batch
            elif run_id in self._sealed:
                # Drain anything appended just before the seal, then stop.
                tail = await self.read(run_id, after_seq=cursor)
                if tail:
                    cursor = tail[-1].seq
                    yield tail
                return
            elif timed_out:
                yield []

    async def seal(self, run_id: str) -> None:
        self._sealed.add(run_id)
        cond = self._cond(run_id)
        async with cond:
            cond.notify_all()

    async def last_seq(self, run_id: str) -> int:
        entries = self._entries.get(run_id, {})
        return max(entries, default=0)

    async def compact(self, run_id: str, snapshot: MessagesSnapshotEvent) -> bool:
        entries = self._entries.get(run_id, {})
        existing = entries.get(snapshot.seq)
        if isinstance(existing, MessagesSnapshotEvent) or any(
            isinstance(e, MessagesSnapshotEvent) and s > snapshot.seq for s, e in entries.items()
        ):
            return False
        if existing is None:
            raise SeqConflict(f"no entry at seq {snapshot.seq} to replace")
        for s in [s for s in entries if s <= snapshot.seq]:
            del entries[s]
        entries[snapshot.seq] = snapshot
        return True

    async def purge(self, run_id: str) -> None:
        self._entries.pop(run_id, None)
