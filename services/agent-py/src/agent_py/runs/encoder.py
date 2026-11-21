"""AG-UI encoder — internal events → AG-UI 1.0 events (Q13).

The only place AG-UI shapes are built, so swapping the wire protocol (a
later AG-UI version, another protocol) swaps this alone. Wave 3b-A
implements `AgUiEncoder` exactly as `packages/contract/RUN_EVENTS.md`
specifies; `RecordingEncoder` below is a fake for testing the code
around an encoder (streams, the runs API) without depending on it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from ..events import TaskEvent
from .model import RunRecord

__all__ = ["AgUiEncoder", "AgUiEncoderFactory", "AgUiEvent", "RecordingEncoder"]

AgUiEvent = dict[str, object]
"""One AG-UI event as a JSON-ready dict (`{"type": "TEXT_MESSAGE_START",
…}`), valid against the pinned `agui/1.0/schema.json` `Event`. Plain
dicts, not generated models: the encoder output goes straight to
`json.dumps`, and the conformance suite validates it against the schema."""


class AgUiEncoder(Protocol):
    """Stateful encoder for **one stream of one run** (create a fresh one
    per stream with the factory). Deterministic: the same entries in the
    same order always produce the same events, ids included
    (RUN_EVENTS.md § 2), which is what makes priming and replay exact.

    The stream drives it like this (RUN_EVENTS.md § 6):

        enc = factory(run)
        send(enc.start(run))                       # RUN_STARTED, no SSE id
        for entry in entries_up_to_cursor: enc.encode(entry)   # priming, output discarded
        for entry in entries_after_cursor: send(enc.encode(entry))   # ids <seq>[.<k>]
        ... once the run row says the run is over:
        send(enc.finish(run))                      # closing events, no SSE id

    Superseded entries are dropped by the stream before `encode` on
    replay; a resume marker is still encoded (it becomes
    `hummingbird.rewind` and resets the block state).
    """

    def start(self, run: RunRecord) -> list[AgUiEvent]:
        """The stream's opening events: exactly one `RUN_STARTED
        {threadId, runId, parentRunId?}`. Does not touch encoder state."""
        ...

    def encode(self, event: TaskEvent) -> list[AgUiEvent]:
        """The AG-UI events for one log entry, in order (possibly none),
        per RUN_EVENTS.md § 3 — including the END events of a block the
        entry closes. Entries must arrive in ascending `seq`; a
        `messages_snapshot` is only passed right after a gap."""
        ...

    def finish(self, run: RunRecord) -> list[AgUiEvent]:
        """The closing events, built from the run row (RUN_EVENTS.md
        §§ 5, 6.4): close an open block, then `RUN_FINISHED` (success /
        interrupt / cancelled outcome) or `RUN_ERROR` for `run.status`,
        with usage from the last `result` entry encoded, if any. Only
        valid when `run.status` is terminal or `interrupted`; raises
        `ValueError` otherwise. After `finish` the encoder is spent."""
        ...


AgUiEncoderFactory = Callable[[RunRecord], AgUiEncoder]
"""Builds the encoder for one stream of `run` (it needs the run id for
the ids it mints)."""


class RecordingEncoder:
    """A fake `AgUiEncoder`: valid AG-UI framing, opaque content. Each
    entry becomes one `CUSTOM` event named `test.<kind>` carrying its seq,
    so tests of streams and the runs API can see which entries went out,
    in which order, without depending on the real mapping."""

    def __init__(self, run: RunRecord) -> None:
        self.run_id = run.id
        self.encoded: list[TaskEvent] = []
        self.finished = False

    def start(self, run: RunRecord) -> list[AgUiEvent]:
        started: AgUiEvent = {"type": "RUN_STARTED", "threadId": run.thread_id, "runId": run.id}
        if run.parent_run_id is not None:
            started["parentRunId"] = run.parent_run_id
        return [started]

    def encode(self, event: TaskEvent) -> list[AgUiEvent]:
        if self.finished:
            raise RuntimeError("encoder already finished")
        self.encoded.append(event)
        return [{"type": "CUSTOM", "name": f"test.{event.kind}", "value": {"seq": event.seq}}]

    def finish(self, run: RunRecord) -> list[AgUiEvent]:
        status = run.status
        if status in ("queued", "running"):
            raise ValueError(f"run {run.id} has not ended (status {status})")
        self.finished = True
        if status == "failed":
            error = run.error or {}
            return [
                {
                    "type": "RUN_ERROR",
                    "message": str(error.get("message", "Run failed.")),
                    "code": str(error.get("code", "unknown")),
                }
            ]
        outcome: dict[str, object]
        if status == "interrupted":
            outcome = {"type": "interrupt", "interrupts": list(run.open_interrupts)}
        elif status == "cancelled":
            outcome = {"type": "cancelled"}
        else:
            outcome = {"type": "success"}
        closing: AgUiEvent = {
            "type": "RUN_FINISHED",
            "threadId": run.thread_id,
            "runId": run.id,
            "outcome": outcome,
        }
        if status == "succeeded":
            closing["result"] = run.result or {}
        return [closing]
