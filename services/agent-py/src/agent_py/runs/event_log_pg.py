"""`RunEventLog` over Postgres `task_events` — signed-in runs (Q17, Q27, Q29).

One row per entry, `(task_id, seq)` unique (migration 0012), written and
read as the DSN role like the workers do today (`store.append_event`):
users cannot write `task_events` rows for runs, and every caller of this
class has already authorised the run. `user_id` is taken from the run's
`tasks` row, so an append for a run that does not exist fails.

**Subscribe (Q29).** Readers in the writing process are woken the moment
an `append` here commits — no poll wait; readers in other processes
(another API replica rejoining, the tasks panel's backend), and readers
of a background run (the worker writes through `store`, not here), poll:
every `poll_interval` (~250 ms) while entries arrive, backing off to
`max_poll_interval` (1 s) while the log is idle — each idle poll is a log
read and the stream's row read, so an idle stream costs about two pool
acquisitions a second, not eight (wave 6, survey bug 18). Either way a
woken reader reads the new rows from Postgres, so every stream decodes
the same stored bytes (jsonb reorders object keys; an in-memory hand-off
would make a live stream differ from a replay of the same log).

**Seal** is process-local (the `RunEventLog` contract): it stops this
process's subscribers and refuses later appends from it. A reader
elsewhere stops on the run row. Seals are forgotten after `seal_memory`
seconds (default 1 h) so a long-lived process does not accumulate them.

Writes go through `fence.fenced_connection`, so an append made while a
background job lease is bound is fenced on that lease exactly like the
executor's own writes.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator, Callable

import asyncpg
import structlog

from ..events import MessagesSnapshotEvent, TaskEvent, event_to_row_payload
from ..fence import fenced_connection
from ..store import event_from_row_payload
from .event_log import SeqConflict

__all__ = ["DEFAULT_MAX_POLL_INTERVAL", "DEFAULT_POLL_INTERVAL", "PgRunEventLog", "RunNotFound"]

DEFAULT_POLL_INTERVAL = 0.25
DEFAULT_MAX_POLL_INTERVAL = 1.0
"""An idle subscription's poll interval doubles up to this."""
DEFAULT_SEAL_MEMORY = 60 * 60.0

_log = structlog.get_logger(__name__)


class RunNotFound(LookupError):
    """`append` / `compact` for a run with no `tasks` row."""


_APPEND_SQL = """
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload)
SELECT t.id, t.user_id, $2, $3, $4, $5::jsonb
  FROM public.tasks t
 WHERE t.id = $1
ON CONFLICT (task_id, seq) DO NOTHING
RETURNING seq;
"""

_ENTRY_EXISTS_SQL = """
SELECT EXISTS (SELECT 1 FROM public.task_events WHERE task_id = $1 AND seq = $2);
"""

_READ_SQL = """
SELECT seq, step, kind, payload::text AS payload, created_at
  FROM public.task_events
 WHERE task_id = $1 AND seq > $2
 ORDER BY seq
 LIMIT $3;
"""

_LAST_SEQ_SQL = """
SELECT COALESCE(MAX(seq), 0) FROM public.task_events WHERE task_id = $1;
"""

_COMPACT_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7041));"

_COMPACT_STATE_SQL = """
SELECT
  (SELECT kind FROM public.task_events WHERE task_id = $1 AND seq = $2) AS kind_at,
  EXISTS (SELECT 1 FROM public.task_events
           WHERE task_id = $1 AND seq > $2 AND kind = 'messages_snapshot') AS snapshot_above;
"""

_COMPACT_DELETE_SQL = "DELETE FROM public.task_events WHERE task_id = $1 AND seq <= $2;"

_PURGE_SQL = "DELETE FROM public.task_events WHERE task_id = $1;"

# Rows per `read` round trip when the caller asks for everything.
_READ_PAGE = 1000


def _uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)


def _row_to_event(run_id: str, row: asyncpg.Record) -> TaskEvent | None:
    try:
        payload = json.loads(row["payload"])
    except (TypeError, ValueError):
        _log.warning("runs.event_log.bad_payload", run_id=run_id, seq=row["seq"])
        return None
    if not isinstance(payload, dict):
        _log.warning("runs.event_log.bad_payload", run_id=run_id, seq=row["seq"])
        return None
    created = row["created_at"]
    event = event_from_row_payload(
        seq=row["seq"],
        step=row["step"],
        kind=row["kind"],
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created),
        payload=payload,
    )
    if event is None:
        return None
    object.__setattr__(event, "run_id", run_id)
    return event


class PgRunEventLog:
    """`RunEventLog` over `task_events`. One instance per process (it holds
    the in-process subscriber registry); share it between the run driver
    and the streams."""

    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_poll_interval: float = DEFAULT_MAX_POLL_INTERVAL,
        seal_memory: float = DEFAULT_SEAL_MEMORY,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._pool = pool
        self._poll = poll_interval
        self._max_poll = max(poll_interval, max_poll_interval)
        self._seal_memory = seal_memory
        self._clock = clock
        self._sealed: dict[str, float] = {}
        self._pruned_at = clock()
        self._waiters: dict[str, set[asyncio.Event]] = {}

    # --- in-process fast path ----------------------------------------------------------

    def _wake(self, run_id: str) -> None:
        for waiter in self._waiters.get(run_id, ()):
            waiter.set()

    def _is_sealed(self, run_id: str) -> bool:
        now = self._clock()
        if now - self._pruned_at >= 60.0:
            self._pruned_at = now
            for rid in [r for r, at in self._sealed.items() if now - at >= self._seal_memory]:
                del self._sealed[rid]
        sealed_at = self._sealed.get(run_id)
        return sealed_at is not None and now - sealed_at < self._seal_memory

    # --- RunEventLog -------------------------------------------------------------------

    async def append(self, event: TaskEvent) -> int:
        if event.seq < 1:
            raise ValueError("seq must be >= 1")
        if self._is_sealed(event.run_id):
            raise RuntimeError(f"run {event.run_id} is sealed")
        run = _uuid(event.run_id)
        payload = json.dumps(event_to_row_payload(event))
        async with fenced_connection(self._pool) as conn:
            inserted = await conn.fetchval(
                _APPEND_SQL, run, event.seq, event.step, event.kind, payload
            )
            if inserted is None and not await conn.fetchval(_ENTRY_EXISTS_SQL, run, event.seq):
                raise RunNotFound(f"run {event.run_id} has no tasks row")
        if inserted is not None:
            self._wake(event.run_id)
        return event.seq

    async def read(
        self, run_id: str, *, after_seq: int = 0, limit: int | None = None
    ) -> list[TaskEvent]:
        try:
            run = _uuid(run_id)
        except ValueError:
            return []
        out: list[TaskEvent] = []
        cursor = after_seq
        async with self._pool.acquire() as conn:
            while limit is None or len(out) < limit:
                page = _READ_PAGE if limit is None else min(_READ_PAGE, limit - len(out))
                rows = await conn.fetch(_READ_SQL, run, cursor, page)
                for row in rows:
                    event = _row_to_event(run_id, row)
                    if event is not None:
                        out.append(event)
                if len(rows) < page:
                    break
                cursor = rows[-1]["seq"]
        return out

    async def subscribe(self, run_id: str, *, after_seq: int = 0) -> AsyncIterator[list[TaskEvent]]:
        cursor = after_seq
        waiter = asyncio.Event()
        self._waiters.setdefault(run_id, set()).add(waiter)
        wait = self._poll
        try:
            while True:
                # Clear before reading: an append that commits after the
                # read sets it again, so the wait below cannot miss it.
                waiter.clear()
                sealed = self._is_sealed(run_id)
                batch = await self.read(run_id, after_seq=cursor)
                if batch:
                    cursor = batch[-1].seq
                    wait = self._poll
                    yield batch
                    continue
                if sealed:
                    return
                try:
                    await asyncio.wait_for(waiter.wait(), timeout=wait)
                except TimeoutError:
                    # Idle for a poll interval: let the consumer re-check
                    # the run row, then poll again (the cross-process path),
                    # a little less often each time the log stays idle.
                    wait = min(wait * 2, self._max_poll)
                    yield []
        finally:
            waiters = self._waiters.get(run_id)
            if waiters is not None:
                waiters.discard(waiter)
                if not waiters:
                    del self._waiters[run_id]

    async def seal(self, run_id: str) -> None:
        self._sealed.setdefault(run_id, self._clock())
        self._wake(run_id)

    async def last_seq(self, run_id: str) -> int:
        try:
            run = _uuid(run_id)
        except ValueError:
            return 0
        async with self._pool.acquire() as conn:
            value = await conn.fetchval(_LAST_SEQ_SQL, run)
        return int(value or 0)

    async def compact(self, run_id: str, snapshot: MessagesSnapshotEvent) -> bool:
        run = _uuid(run_id)
        payload = json.dumps(event_to_row_payload(snapshot))
        async with self._pool.acquire() as conn, conn.transaction():
            await conn.execute(_COMPACT_LOCK_SQL, run_id)
            state = await conn.fetchrow(_COMPACT_STATE_SQL, run, snapshot.seq)
            if state["kind_at"] == "messages_snapshot" or state["snapshot_above"]:
                return False
            if state["kind_at"] is None:
                raise SeqConflict(f"no entry at seq {snapshot.seq} to replace")
            await conn.execute(_COMPACT_DELETE_SQL, run, snapshot.seq)
            inserted = await conn.fetchval(
                _APPEND_SQL, run, snapshot.seq, snapshot.step, snapshot.kind, payload
            )
            if inserted is None:
                raise RunNotFound(f"run {run_id} has no tasks row")
        return True

    async def purge(self, run_id: str) -> None:
        try:
            run = _uuid(run_id)
        except ValueError:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(_PURGE_SQL, run)
