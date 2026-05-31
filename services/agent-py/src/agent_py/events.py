"""TaskEvent IR — the append-only event log shape.

Mirror of `lib/shared/agent/events.ts`. Phase 2 of PLAN-agent-api: we
need enough of the IR to drive the executor + persist into
`task_events`. Phase 2a shipped the happy-path kinds (status /
step_start / step_end / token / result); Phase 2b-2 adds the kinds
the tool wiring produces (`tool_input` / `tool_output` /
`step_error`). The remaining kinds (`plan` / `handoff` / `approval` /
`compact` / `artifact_ref`) land alongside the features that emit
them (HITL pause/resume in Phase 3, setPlan tool when it ports).

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


@dataclass(kw_only=True, frozen=True)
class ToolCallResult:
    """One source-strip-shaped result for a `tool_output`. Mirrors
    `ToolCallResult` in `lib/shared/types.ts` (`title` / `url` /
    `snippet`) so the existing client-side Sources rail renders
    Python-emitted rows identically."""

    title: str
    url: str
    snippet: str


@dataclass(kw_only=True, frozen=True)
class ToolInputEvent(TaskEventBase):
    """A tool call started — args are final/complete at emit time."""

    kind: Literal["tool_input"] = field(default="tool_input", init=False)
    tool_call_id: str
    tool_name: str
    args: dict[str, object]


@dataclass(kw_only=True, frozen=True)
class ToolOutputEvent(TaskEventBase):
    """A tool call resolved (success or error)."""

    kind: Literal["tool_output"] = field(default="tool_output", init=False)
    tool_call_id: str
    tool_name: str
    summary: str
    """One-line user-facing summary, e.g. "5 results" or
    "Fetched <title>" (matches the TS-side tool-pill text)."""
    results: list[ToolCallResult] | None = None
    """Optional structured rows for the Sources strip — currently
    only `webSearch`-shaped outputs populate this. None for tools
    whose output is plain text (`webFetch` summary)."""


@dataclass(kw_only=True, frozen=True)
class StepErrorEvent(TaskEventBase):
    """Per-step failure, distinct from the fatal `result: failed`.
    `will_retry=True` means the runner will retry the step (today's
    runner doesn't auto-retry tool errors — the model usually
    recovers next step — but the event still carries the hint for
    the UI)."""

    kind: Literal["step_error"] = field(default="step_error", init=False)
    message: str
    will_retry: bool = True


# Discriminated union of the kinds the Python service emits today
# (Phases 2a + 2b-1 + 2b-2). Newer kinds slot in here as their feature
# ports; the TS-side projection reducer tolerates unknown kinds, so
# a Python-only event survives an older client.
TaskEvent = (
    StatusEvent
    | StepStartEvent
    | StepEndEvent
    | TokenEvent
    | ResultEvent
    | ToolInputEvent
    | ToolOutputEvent
    | StepErrorEvent
)


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
        result_payload: dict[str, object] = {"status": event.status}
        if event.final_text is not None:
            result_payload["finalText"] = event.final_text
        if event.error is not None:
            result_payload["error"] = event.error
        return result_payload
    if isinstance(event, ToolInputEvent):
        return {
            "toolCallId": event.tool_call_id,
            "toolName": event.tool_name,
            "args": event.args,
        }
    if isinstance(event, ToolOutputEvent):
        tool_payload: dict[str, object] = {
            "toolCallId": event.tool_call_id,
            "toolName": event.tool_name,
            "summary": event.summary,
        }
        if event.results is not None:
            tool_payload["results"] = [
                {"title": r.title, "url": r.url, "snippet": r.snippet} for r in event.results
            ]
        return tool_payload
    if isinstance(event, StepErrorEvent):
        return {"message": event.message, "willRetry": event.will_retry}
    # step_start / step_end carry no payload-only fields.
    return {}
