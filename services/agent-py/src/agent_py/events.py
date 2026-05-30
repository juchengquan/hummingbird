"""TaskEvent IR — the append-only event log shape.

Mirror of `lib/shared/agent/events.ts`. Phase 2 of PLAN-agent-api: we
need enough of the IR to drive the executor + persist into
`task_events`. The full discriminated union (token / tool_input /
tool_output / step_start / step_end / status / plan / step_error /
handoff / approval / compact / artifact_ref / result) is intentionally
kept skinny for Phase 2a — the kinds the stub step-fn emits today
(`status`, `step_start`, `step_end`, `token`, `result`) cover the
end-to-end happy path. Phase 2b lands the rest as it ports more tools
and the real model call.

The wire shape (DB row) is `task_events(task_id, user_id, seq, step,
kind, payload jsonb)`. The TS side uses a discriminated union; we
keep that on the Python side too via `dataclass(kw_only=True)`
subclasses, with one shared serialise that puts the right keys in
the `payload` jsonb column.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# --- RunStatus -------------------------------------------------------------

RunStatus = Literal[
    "queued",
    "running",
    "paused",
    "cancelled",
    "done",
    "failed",
]

TERMINAL_STATUSES: frozenset[RunStatus] = frozenset({"cancelled", "done", "failed"})


def is_terminal_status(status: RunStatus) -> bool:
    return status in TERMINAL_STATUSES


# --- TaskEvent -------------------------------------------------------------

TaskEventKind = Literal[
    "token",
    "tool_input",
    "tool_output",
    "step_start",
    "step_end",
    "status",
    "plan",
    "step_error",
    "handoff",
    "approval",
    "compact",
    "artifact_ref",
    "result",
]


@dataclass(kw_only=True, frozen=True)
class TaskEventBase:
    """Fields every event carries regardless of kind. Matches
    `TaskEventBase` in `lib/shared/agent/events.ts`."""

    run_id: str
    seq: int
    step: int
    created_at: str  # ISO-8601


@dataclass(kw_only=True, frozen=True)
class StatusEvent(TaskEventBase):
    kind: Literal["status"] = field(default="status", init=False)
    status: RunStatus


@dataclass(kw_only=True, frozen=True)
class StepStartEvent(TaskEventBase):
    kind: Literal["step_start"] = field(default="step_start", init=False)


@dataclass(kw_only=True, frozen=True)
class StepEndEvent(TaskEventBase):
    kind: Literal["step_end"] = field(default="step_end", init=False)


@dataclass(kw_only=True, frozen=True)
class TokenEvent(TaskEventBase):
    kind: Literal["token"] = field(default="token", init=False)
    text: str
    channel: Literal["text", "reasoning"] = "text"


@dataclass(kw_only=True, frozen=True)
class ResultEvent(TaskEventBase):
    """Terminal projection — written once when the run settles."""

    kind: Literal["result"] = field(default="result", init=False)
    status: Literal["done", "failed"]
    final_text: str | None = None
    error: str | None = None


# Union of the kinds Phase 2a emits. Phase 2b adds tool_input /
# tool_output / step_error / approval / handoff / plan / compact /
# artifact_ref as the real step-fn + tool registry lands.
TaskEvent = StatusEvent | StepStartEvent | StepEndEvent | TokenEvent | ResultEvent


# --- Wire format -----------------------------------------------------------


def event_to_row_payload(event: TaskEvent) -> dict[str, object]:
    """Serialise an event's kind-specific fields into the jsonb
    `payload` column of `task_events`. Matches the keys the TS side
    writes via `taskEventToRow` in `lib/shared/agent/persistence.ts`
    so the projection reducer accepts rows from either producer.
    """
    if isinstance(event, StatusEvent):
        return {"status": event.status}
    if isinstance(event, TokenEvent):
        return {"text": event.text, "channel": event.channel}
    if isinstance(event, ResultEvent):
        payload: dict[str, object] = {"status": event.status}
        if event.final_text is not None:
            payload["finalText"] = event.final_text
        if event.error is not None:
            payload["error"] = event.error
        return payload
    # step_start / step_end carry no payload-only fields.
    return {}
