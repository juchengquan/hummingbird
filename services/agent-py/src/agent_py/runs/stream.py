"""Run event streams — RUN_EVENTS.md § 6 (Q7, Q17, Q29).

`stream_run_events` is the body of both `startRun` (interactive, cursor
`0`) and `streamRunEvents` (rejoin): framing, the `<seq>` / `<seq>.<k>`
cursor in the SSE `id:` field, replay after a cursor (priming the
encoder first), `hummingbird.gap` + `MESSAGES_SNAPSHOT` past the
compaction point or for a purged log, the live tail through
`RunEventLog.subscribe`, and the closing events once the **run row**
says the run is over.

The router wiring (3b-B):

    gen = stream_run_events(run_id=..., after=cursor, log=log,
                            encoder=encoder_factory(run), load_run=load)
    try:
        first = await anext(gen)          # validates the cursor
    except CursorOutOfRange:
        return error(400, "invalid_request")
    return StreamingResponse(prepend(first, gen), media_type="text/event-stream")

Nothing is sent before the cursor is validated, so pulling the first
frame before committing to a `200` is how the router answers `400` for a
cursor beyond the log.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import replace

from ..events import (
    ApprovalEvent,
    MessagesSnapshotEvent,
    ResultEvent,
    StatusEvent,
    TaskEvent,
    drop_superseded_events,
    resume_discard_range,
)
from .agui_encoder import gap_event
from .encoder import AgUiEncoder, AgUiEvent
from .event_log import RunEventLog
from .model import PendingInterrupt, RunCursor, RunRecord

__all__ = [
    "KEEPALIVE_SECONDS",
    "CursorOutOfRange",
    "OpenApprovals",
    "effective_run",
    "sse_frame",
    "stream_run_events",
]

KEEPALIVE_SECONDS = 15.0
"""A `: keep-alive` comment goes out after this long without a frame."""

_KEEPALIVE_FRAME = ": keep-alive\n\n"

_SETTLE_POLL = 0.25
"""After an in-process seal, how often the stream re-reads a row that has
not settled yet (the driver writes the log, settles, then seals)."""


class CursorOutOfRange(ValueError):
    """The cursor's seq is beyond the log (RUN_EVENTS.md § 6.2): the
    router answers `400 invalid_request`."""


def sse_frame(event: AgUiEvent, cursor: RunCursor | None = None) -> str:
    """One SSE message: `id: <cursor>` (when given) and `data: <compact
    JSON>`, ending with the blank line. No `event:` field."""
    data = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    if cursor is None:
        return f"data: {data}\n\n"
    return f"id: {cursor}\ndata: {data}\n\n"


class OpenApprovals:
    """The pre-0041 fallback for a run's open interrupts (RUN_EVENTS.md
    § 1): `approval` requests with no later response, from the entries a
    stream has passed. Resume markers drop what they supersede."""

    def __init__(self) -> None:
        self._open: dict[str, ApprovalEvent] = {}

    def observe(self, event: TaskEvent) -> None:
        marker = resume_discard_range(event)
        if marker is not None:
            after = marker[0]
            self._open = {k: v for k, v in self._open.items() if v.seq <= after}
            return
        if isinstance(event, ApprovalEvent):
            if event.phase == "request":
                self._open[event.approval_id] = event
            else:
                self._open.pop(event.approval_id, None)

    def interrupts(self) -> tuple[dict[str, object], ...]:
        return tuple(PendingInterrupt.from_approval(e).to_agui() for e in self._open.values())


def effective_run(run: RunRecord, approvals: OpenApprovals) -> RunRecord:
    """`run` with the log's open interrupts filled in for a `paused` row
    written before 0041 (no `outcome`). A paused row with neither is a
    background parent waiting on its sub-agents: still running."""
    if run.internal_status == "paused" and not run.open_interrupts:
        interrupts = approvals.interrupts()
        if interrupts:
            return replace(run, open_interrupts=interrupts)
    return run


def _is_over(run: RunRecord) -> bool:
    return not run.is_live


def _may_close(batch: Iterable[TaskEvent]) -> bool:
    """A batch holding an entry a driver writes when a run ends: worth
    re-reading the row right away instead of at the next idle tick."""
    return any(
        isinstance(e, ResultEvent)
        or (isinstance(e, StatusEvent) and e.status in ("paused", "cancelled", "done", "failed"))
        for e in batch
    )


async def stream_run_events(
    *,
    run_id: str,
    after: RunCursor | None,
    log: RunEventLog,
    encoder: AgUiEncoder,
    load_run: Callable[[], Awaitable[RunRecord | None]],
) -> AsyncIterator[str]:
    """Every SSE frame of one stream of `run_id`, each a complete message
    ending in a blank line (RUN_EVENTS.md § 6). `after` None means `0`.

    `load_run` re-reads the run row; the stream ends with the closing
    events once it is terminal or interrupted and every entry in the log
    has been sent. Raises `LookupError` (nothing sent) when the run does
    not exist, `CursorOutOfRange` (nothing sent) for a cursor beyond the
    log; a row that disappears mid-stream (the run was deleted) ends the
    stream without closing events."""
    cursor = after if after is not None else RunCursor(0)
    run = await load_run()
    if run is None:
        raise LookupError(f"run {run_id} not found")

    raw = await log.read(run_id)
    last_seq = raw[-1].seq if raw else 0
    entries = drop_superseded_events(raw)
    approvals = OpenApprovals()
    for entry in entries:
        approvals.observe(entry)
    run = effective_run(run, approvals)

    purged = not raw and _is_over(run)
    snapshot_at = (
        entries[0].seq if entries and isinstance(entries[0], MessagesSnapshotEvent) else None
    )
    if not purged and cursor.seq > last_seq:
        raise CursorOutOfRange(f"cursor {cursor} is beyond the log (last seq {last_seq})")

    for event in encoder.start(run):
        yield sse_frame(event)

    if purged:
        yield sse_frame(gap_event(after=str(cursor), resume_at=None, reason="purged"))
        for event in encoder.encode(_empty_snapshot(run_id)):
            yield sse_frame(event)
        for event in encoder.finish(run):
            yield sse_frame(event)
        return

    def send(entry: TaskEvent, *, skip_through: int | None = None) -> list[str]:
        events = encoder.encode(entry)
        return [
            sse_frame(ev, RunCursor.for_event(entry.seq, i, len(events)))
            for i, ev in enumerate(events)
            if skip_through is None or i > skip_through
        ]

    if snapshot_at is not None and cursor < RunCursor(snapshot_at):
        # The cursor is inside the folded range: the snapshot replaces
        # everything up to it, then replay continues after it.
        yield sse_frame(gap_event(after=str(cursor), resume_at=snapshot_at, reason="compacted"))
        for entry in entries:
            for frame in send(entry):
                yield frame
    else:
        for entry in entries:
            if entry.seq < cursor.seq or (entry.seq == cursor.seq and cursor.k is None):
                encoder.encode(entry)  # priming: output discarded
            elif entry.seq == cursor.seq:
                for frame in send(entry, skip_through=cursor.k):
                    yield frame
            else:
                for frame in send(entry):
                    yield frame

    # The row was read before the log, so if it was already over then,
    # the log read above holds everything: close now.
    if _is_over(run):
        for event in encoder.finish(run):
            yield sse_frame(event)
        return

    last_sent = time.monotonic()

    async def drain_and_finish(over: RunRecord) -> AsyncIterator[str]:
        nonlocal last_seq
        for entry in await log.read(run_id, after_seq=last_seq):
            last_seq = entry.seq
            approvals.observe(entry)
            for frame in send(entry):
                yield frame
        final = effective_run(over, approvals)
        for event in encoder.finish(final):
            yield sse_frame(event)

    subscription = log.subscribe(run_id, after_seq=last_seq)
    try:
        async for batch in subscription:
            for entry in batch:
                last_seq = entry.seq
                approvals.observe(entry)
                for frame in send(entry):
                    last_sent = time.monotonic()
                    yield frame
            if batch and not _may_close(batch):
                continue
            current = await load_run()
            if current is None:
                return
            current = effective_run(current, approvals)
            if _is_over(current):
                async for frame in drain_and_finish(current):
                    yield frame
                return
            if not batch and time.monotonic() - last_sent >= KEEPALIVE_SECONDS:
                last_sent = time.monotonic()
                yield _KEEPALIVE_FRAME
    finally:
        # Release the subscription (listeners, connections) promptly,
        # also when the client hangs up mid-stream.
        aclose = getattr(subscription, "aclose", None)
        if aclose is not None:
            await aclose()

    # The subscription ended: sealed in this process. The driver seals
    # after settling the row, so this normally finds it over at once.
    while True:
        current = await load_run()
        if current is None:
            return
        current = effective_run(current, approvals)
        if _is_over(current):
            async for frame in drain_and_finish(current):
                yield frame
            return
        await asyncio.sleep(_SETTLE_POLL)
        if time.monotonic() - last_sent >= KEEPALIVE_SECONDS:
            last_sent = time.monotonic()
            yield _KEEPALIVE_FRAME


def _empty_snapshot(run_id: str) -> MessagesSnapshotEvent:
    return MessagesSnapshotEvent(run_id=run_id, seq=0, step=0, created_at="", messages=())
