"""Stand-ins for the wave-3b seams other workstreams implement.

Each one is wired in `wiring.py` behind a `# WIRE(3b-A)` / `# WIRE(3b-C)`
marker and is replaced there, not here, when the real module lands:

* `placeholder_stream_run_events` — 3b-A's `stream.stream_run_events`
  (same signature): replay from `0` with priming + live tail + the
  closing events from the row. No `gap` / `MESSAGES_SNAPSHOT`, no
  rewind handling, no keep-alives.
* `UnwiredHarness` — 3b-C's adapter over today's agent loop: fails
  every run with `unavailable` (set `RUNS_STUB_HARNESS=true` for the
  model-free stub).
* `noop_post_settle` — 3b-A's compaction scheduling.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable

from ..emitter import RunEmitter
from ..events import TaskEvent
from .encoder import AgUiEncoder, AgUiEvent
from .event_log import RunEventLog
from .harness import CancelSignal, HarnessResult, RunInput
from .model import Failed, RunCursor, RunRecord

__all__ = [
    "UnwiredHarness",
    "noop_post_settle",
    "placeholder_stream_run_events",
    "sse_frame",
]


def sse_frame(event: AgUiEvent, *, event_id: str | None = None) -> str:
    """One SSE message: `id:` (when given) + compact JSON `data:`."""
    data = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    prefix = "" if event_id is None else f"id: {event_id}\n"
    return f"{prefix}data: {data}\n\n"


async def placeholder_stream_run_events(
    *,
    run_id: str,
    after: RunCursor | None,
    log: RunEventLog,
    encoder: AgUiEncoder,
    load_run: Callable[[], Awaitable[RunRecord | None]],
) -> AsyncIterator[str]:
    run = await load_run()
    if run is None:
        return
    for event in encoder.start(run):
        yield sse_frame(event)
    cursor = after or RunCursor(0)
    handled = 0

    def encode(entry: TaskEvent) -> list[str]:
        out = encoder.encode(entry)
        frames: list[str] = []
        for i, event in enumerate(out):
            event_id = RunCursor.for_event(entry.seq, i, len(out))
            if cursor < event_id:  # at or before the cursor: priming only
                frames.append(sse_frame(event, event_id=str(event_id)))
        return frames

    async def closing(current: RunRecord) -> AsyncIterator[str]:
        for entry in await log.read(run_id, after_seq=handled):
            for frame in encode(entry):
                yield frame
        for event in encoder.finish(current):
            yield sse_frame(event)

    subscription = log.subscribe(run_id, after_seq=0)
    try:
        async for batch in subscription:
            for entry in batch:
                for frame in encode(entry):
                    yield frame
                handled = entry.seq
            current = await load_run()
            if current is None:
                return
            if not current.is_live:
                async for frame in closing(current):
                    yield frame
                return
    finally:
        aclose = getattr(subscription, "aclose", None)
        if aclose is not None:
            await aclose()
    current = await load_run()
    if current is not None and not current.is_live:
        async for frame in closing(current):
            yield frame


class UnwiredHarness:
    """Fails every run: no agent harness is wired into this build."""

    name = "unwired"

    async def run(
        self, run_input: RunInput, emitter: RunEmitter, cancel: CancelSignal
    ) -> HarnessResult:
        return HarnessResult(
            Failed("unavailable", "No agent harness is configured on this backend yet.")
        )


async def noop_post_settle(run: RunRecord) -> None:
    return None
