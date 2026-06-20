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
    # Citation-verification verdicts for a research run (camelCase wire
    # payload from `VerificationResult.to_payload`), folded onto the
    # settled Message by the TS projection. None when verification didn't
    # run. See `agent_py.verify` + `docs/PLAN-citation-verifiability.md`.
    verification: dict[str, object] | None = None


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


@dataclass(kw_only=True, frozen=True)
class HandoffEvent(TaskEventBase):
    """Marks a subagent spawn boundary. Mirrors `HandoffEvent` in
    `lib/shared/agent/events.ts`: `phase='enter'` is emitted just
    before control transfers to a child agent; `phase='exit'` is
    emitted when the child completes and control returns to the
    parent orchestrator."""

    kind: Literal["handoff"] = field(default="handoff", init=False)
    agent: str
    phase: Literal["enter", "exit"]
    child_task_id: str | None = None
    subgoal: str | None = None


# --- Approval / HITL -------------------------------------------------------


@dataclass(kw_only=True, frozen=True)
class InputRequestOption:
    """One choice for `requestKind: 'choice'` approval requests.
    Mirrors `InputRequestOption` in `lib/shared/agent/events.ts`."""

    id: str
    label: str


# Discriminator for what kind of human input the run is waiting on.
# Defaults to `"approval"` (binary tool-approval, the original Phase 1
# HITL mechanism); `"choice"` + `"input"` ride on the same machinery
# with different payload shapes (askUser tool, Phase 5 of HITL);
# `"ui-part"` is the structured-UI variant raised by the renderUI tool
# (commit 3b of PLAN-generative-ui-parts).
ApprovalRequestKind = Literal["approval", "choice", "input", "ui-part"]


@dataclass(kw_only=True, frozen=True)
class ApprovalEvent(TaskEventBase):
    """Human-in-the-loop input request / response — the suspend point
    of an agent run. Mirror of `ApprovalEvent` in
    `lib/shared/agent/events.ts`. `phase: "request"` is emitted when
    the model calls a gated tool; `phase: "response"` is emitted from
    the executor's respond path once the user picks an answer.

    On `request`: `request_kind` + `tool` + `tool_call_id` + `args`
    describe what's pending. On `response`: `approved` / `selection`
    / `value` / `ui_answer` carry the user's answer (one of them is
    set based on `request_kind`)."""

    kind: Literal["approval"] = field(default="approval", init=False)
    approval_id: str
    phase: Literal["request", "response"]
    request_kind: ApprovalRequestKind | None = None
    tool: str | None = None
    tool_call_id: str | None = None
    args: dict[str, object] | None = None
    prompt: str | None = None
    options: list[InputRequestOption] | None = None
    multi: bool | None = None
    # Generative-UI request fields (`request_kind == "ui-part"`).
    # Mirror of `uiKind` / `uiProps` on the TS event. The client uses
    # them to render the right component without having to re-parse
    # `args`.
    ui_kind: str | None = None
    ui_props: dict[str, object] | None = None
    # Response-only fields:
    approved: bool | None = None
    selection: list[str] | None = None
    value: str | None = None
    # Generative-UI response field. Mirror of `uiAnswer` on the TS
    # event — the structured answer the client built via
    # `respondBodyForUiAnswer`.
    ui_answer: dict[str, object] | None = None


# Discriminated union of the kinds the Python service emits today
# (Phases 2a + 2b-1 + 2b-2 + 3b). Newer kinds slot in here as their
# feature ports; the TS-side projection reducer tolerates unknown
# kinds, so a Python-only event survives an older client.
TaskEvent = (
    StatusEvent
    | StepStartEvent
    | StepEndEvent
    | TokenEvent
    | ResultEvent
    | ToolInputEvent
    | ToolOutputEvent
    | StepErrorEvent
    | HandoffEvent
    | ApprovalEvent
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
        if event.verification is not None:
            result_payload["verification"] = event.verification
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
    if isinstance(event, HandoffEvent):
        handoff_payload: dict[str, object] = {"agent": event.agent, "phase": event.phase}
        if event.child_task_id is not None:
            handoff_payload["childTaskId"] = event.child_task_id
        if event.subgoal is not None:
            handoff_payload["subgoal"] = event.subgoal
        return handoff_payload
    if isinstance(event, ApprovalEvent):
        approval_payload: dict[str, object] = {
            "approvalId": event.approval_id,
            "phase": event.phase,
        }
        if event.request_kind is not None:
            approval_payload["requestKind"] = event.request_kind
        if event.tool is not None:
            approval_payload["tool"] = event.tool
        if event.tool_call_id is not None:
            approval_payload["toolCallId"] = event.tool_call_id
        if event.args is not None:
            approval_payload["args"] = event.args
        if event.prompt is not None:
            approval_payload["prompt"] = event.prompt
        if event.options is not None:
            approval_payload["options"] = [{"id": o.id, "label": o.label} for o in event.options]
        if event.multi is not None:
            approval_payload["multi"] = event.multi
        if event.ui_kind is not None:
            approval_payload["uiKind"] = event.ui_kind
        if event.ui_props is not None:
            approval_payload["uiProps"] = event.ui_props
        if event.approved is not None:
            approval_payload["approved"] = event.approved
        if event.selection is not None:
            approval_payload["selection"] = event.selection
        if event.value is not None:
            approval_payload["value"] = event.value
        if event.ui_answer is not None:
            approval_payload["uiAnswer"] = event.ui_answer
        return approval_payload
    # step_start / step_end carry no payload-only fields.
    return {}
