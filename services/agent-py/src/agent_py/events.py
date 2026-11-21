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

**The run model (wave 3a of PLAN-frontend-backend-split).** This IR is
also the internal event model of the runs API (Q8/Q13): every harness
adapter emits these events, the run event log stores them, and the
AG-UI encoder translates them for the wire
(`packages/contract/RUN_EVENTS.md` is the normative mapping). So it
covers everything interactive chat produces today, not only background
tasks:

  * the TS-only kinds, now on both sides: `plan`, `compact`,
    `artifact_ref`;
  * chat's AI SDK data parts, as **part** events the UI attaches to the
    turn: `tool_image` (`data-tool-image`), `tool_file`
    (`data-tool-file`), `code_result` (`data-code-result`), `ui_part`
    (`data-ui`), `mcp_app` (`data-mcp-app`), `verification`
    (`data-verification`), `suggestions` (`data-suggestions`),
    `routed_model` (`data-routed-model`);
  * on `ResultEvent`: `error_code` (chat's typed `error` frame code),
    `memory_tainted` (the `finish` frame's `messageMetadata`) and
    `usage`; on `ToolOutputEvent`: `is_error` (`errorText`);
  * `messages_snapshot` — written only by log compaction (Q17/Q30),
    never by a harness: the run's output folded into AG-UI messages.

The new kinds are Python-only: the TS task routes never read an
interactive run (0041), and the TS row codec drops kinds it does not
know and ignores extra payload keys.
"""

from __future__ import annotations

from collections.abc import Iterable
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
    # Run model (wave 3a): chat's data parts + the compaction snapshot.
    "tool_image",
    "tool_file",
    "code_result",
    "ui_part",
    "mcp_app",
    "verification",
    "suggestions",
    "routed_model",
    "messages_snapshot",
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
    # Resume marker: set on the `status: running` a reclaimed job emits
    # when it re-runs a run whose previous worker died mid-chunk. The
    # value is the `seq` of the checkpoint the run resumes from; every
    # event with `resumed_from_seq < seq < marker.seq` is the dead
    # attempt's partial output and consumers drop it (see
    # `drop_superseded_events`). A from-scratch restart is the same
    # thing resumed from the run's initial checkpoint. Serialised as
    # `resumedFromSeq` only when set. Mirror of
    # `StatusEvent.resumedFromSeq` in `lib/shared/agent/events.ts`.
    resumed_from_seq: int | None = None
    # Legacy restart marker: a reclaimed `start` that re-ran from scratch
    # set only this before `resumed_from_seq` existed. Still set on a
    # restart (older readers only understand this flag); a marker that
    # carries it without `resumed_from_seq` is read as resumed from
    # `LEGACY_RESTART_RESUMED_FROM_SEQ`. Serialised only when true.
    restarted: bool = False


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
class TokenUsage:
    """Token counts for one provider + model, in AG-UI's accounting
    (`TokenUsage` in the pinned schema): `input_tokens` / `output_tokens`
    are totals; `reasoning_tokens`, `cached_input_tokens` and
    `cache_write_input_tokens` are parts of them, never additions."""

    provider: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    cached_input_tokens: int | None = None
    cache_write_input_tokens: int | None = None

    def to_payload(self) -> dict[str, object]:
        """camelCase, set fields only — also exactly an AG-UI `TokenUsage`
        (plus `totalTokens` when both totals are known)."""
        out: dict[str, object] = {}
        for key, value in (
            ("provider", self.provider),
            ("model", self.model),
            ("inputTokens", self.input_tokens),
            ("outputTokens", self.output_tokens),
            ("reasoningTokens", self.reasoning_tokens),
            ("cachedInputTokens", self.cached_input_tokens),
            ("cacheWriteInputTokens", self.cache_write_input_tokens),
        ):
            if value is not None:
                out[key] = value
        if self.input_tokens is not None and self.output_tokens is not None:
            out["totalTokens"] = self.input_tokens + self.output_tokens
        return out

    @staticmethod
    def from_payload(raw: object) -> TokenUsage | None:
        if not isinstance(raw, dict):
            return None

        def _int(key: str) -> int | None:
            v = raw.get(key)
            return v if isinstance(v, int) and not isinstance(v, bool) else None

        def _str(key: str) -> str | None:
            v = raw.get(key)
            return v if isinstance(v, str) else None

        return TokenUsage(
            provider=_str("provider"),
            model=_str("model"),
            input_tokens=_int("inputTokens"),
            output_tokens=_int("outputTokens"),
            reasoning_tokens=_int("reasoningTokens"),
            cached_input_tokens=_int("cachedInputTokens"),
            cache_write_input_tokens=_int("cacheWriteInputTokens"),
        )


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
    # Run model (wave 3a). `error_code`: the machine code of a failure —
    # an `ApiError` code (`rate_limit`, `auth`, `context_window`,
    # `provider`, `upstream`, `max_steps`, ...), what chat's `error` frame
    # carries today. `memory_tainted`: the run read third-party content
    # (chat's `finish.messageMetadata.memoryTainted`), so post-turn memory
    # extraction must skip it. `usage`: one entry per provider + model,
    # every model call of the run (subagents included).
    error_code: str | None = None
    memory_tainted: bool = False
    usage: tuple[TokenUsage, ...] = ()


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
    is_error: bool = False
    """The tool failed; `summary` is the error text (chat's
    `tool-output-available.errorText`). Serialised only when true."""


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


# --- Plan / compact / artifact (TS-only until wave 3a) -----------------------

PlanItemStatus = Literal["pending", "in_progress", "completed"]


@dataclass(kw_only=True, frozen=True)
class PlanItem:
    """One row of the agent's todo list. Mirrors `PlanItem` in
    `lib/shared/agent/events.ts`."""

    id: str
    text: str
    status: PlanItemStatus


@dataclass(kw_only=True, frozen=True)
class PlanEvent(TaskEventBase):
    """The full todo list, carried whole every time (not deltas)."""

    kind: Literal["plan"] = field(default="plan", init=False)
    items: tuple[PlanItem, ...]


@dataclass(kw_only=True, frozen=True)
class CompactEvent(TaskEventBase):
    """Model-context compaction mid-run (a Claude compact boundary): the
    harness summarised earlier turns to fit the context window. Not log
    compaction — that is `MessagesSnapshotEvent`."""

    kind: Literal["compact"] = field(default="compact", init=False)
    summary: str | None = None


@dataclass(kw_only=True, frozen=True)
class ArtifactRefEvent(TaskEventBase):
    """An artifact (the `artifacts` entity) produced or updated mid-run."""

    kind: Literal["artifact_ref"] = field(default="artifact_ref", init=False)
    artifact_id: str


# --- Chat data parts (wave 3a) ----------------------------------------------
#
# What `ChatSseEmitter` (`lib/server/chat/sse-emitter.ts`) sends as AI SDK
# `data-*` parts today. Every part is attached to the tool call that
# produced it (`tool_call_id`, which is also the part's id on the wire)
# except the turn-level ones (`verification`, `suggestions`,
# `routed_model`). Payloads are kept as the JSON the frontend already
# parses (`lib/client/chat/sse-frame-translator.ts`), so a part survives
# the encoder byte for byte.

ToolImageMode = Literal["t2i", "i2i", "code"]


@dataclass(kw_only=True, frozen=True)
class ToolImageEvent(TaskEventBase):
    """Generated images (`data-tool-image`): `generateImage` (`t2i` /
    `i2i`) or `runCode` charts (`code`). Each image is `{id, url,
    storagePath?, width, height, format, prompt, mode}`."""

    kind: Literal["tool_image"] = field(default="tool_image", init=False)
    tool_call_id: str
    mode: ToolImageMode
    images: tuple[dict[str, object], ...]


@dataclass(kw_only=True, frozen=True)
class ToolFileEvent(TaskEventBase):
    """Generated files (`data-tool-file`): `{id, name, sizeBytes,
    mimeType, url, storagePath?}` each."""

    kind: Literal["tool_file"] = field(default="tool_file", init=False)
    tool_call_id: str
    files: tuple[dict[str, object], ...]


@dataclass(kw_only=True, frozen=True)
class CodeResultEvent(TaskEventBase):
    """Code-interpreter output (`data-code-result`): stdout / stderr plus
    the non-image result cells (`{type: "table", columns, rows}` /
    `{type: "text", value}`). Charts travel as a `ToolImageEvent`."""

    kind: Literal["code_result"] = field(default="code_result", init=False)
    tool_call_id: str
    stdout: str = ""
    stderr: str = ""
    results: tuple[dict[str, object], ...] = ()


@dataclass(kw_only=True, frozen=True)
class UiPartEvent(TaskEventBase):
    """A display-only generative-UI part (`data-ui`) from the `renderUI`
    tool, already validated against `UiPartSchema`. A `renderUI` call
    that waits for the user's answer is an interrupt (`ApprovalEvent`
    with `request_kind="ui-part"`), not this."""

    kind: Literal["ui_part"] = field(default="ui_part", init=False)
    tool_call_id: str
    ui_kind: str
    props: dict[str, object] | None = None


@dataclass(kw_only=True, frozen=True)
class McpAppEvent(TaskEventBase):
    """An MCP App (`data-mcp-app`): bundled HTML read from the tool's
    `ui://` resource, rendered in a sandboxed iframe."""

    kind: Literal["mcp_app"] = field(default="mcp_app", init=False)
    tool_call_id: str
    server_id: str
    html: str
    resource_uri: str | None = None
    truncated: bool = False


@dataclass(kw_only=True, frozen=True)
class VerificationEvent(TaskEventBase):
    """Citation-verification verdicts for the turn (`data-verification`):
    `{checks, summary}` as `VerificationResult.to_payload` builds it.
    Background runs still carry theirs on `ResultEvent.verification`."""

    kind: Literal["verification"] = field(default="verification", init=False)
    verification: dict[str, object]


@dataclass(kw_only=True, frozen=True)
class SuggestionsEvent(TaskEventBase):
    """Follow-up suggestion chips (`data-suggestions`), at most once per
    run, after the answer."""

    kind: Literal["suggestions"] = field(default="suggestions", init=False)
    values: tuple[str, ...]


@dataclass(kw_only=True, frozen=True)
class RoutedModelEvent(TaskEventBase):
    """The concrete model the `auto` option resolved to for this run
    (`data-routed-model`)."""

    kind: Literal["routed_model"] = field(default="routed_model", init=False)
    model: str


@dataclass(kw_only=True, frozen=True)
class MessagesSnapshotEvent(TaskEventBase):
    """Written by log compaction only (Q17/Q30), never by a harness: the
    output of every compacted entry, folded into AG-UI messages
    (assistant / tool / reasoning / activity), in order. Its `seq` is
    the highest compacted seq; the rejoin stream sends it as
    `MESSAGES_SNAPSHOT` after a `gap`. See `packages/contract/RUN_EVENTS.md`
    § Compaction for the exact fold."""

    kind: Literal["messages_snapshot"] = field(default="messages_snapshot", init=False)
    messages: tuple[dict[str, object], ...]


#: The part events, in the order RUN_EVENTS.md lists them. They encode to
#: AG-UI `ACTIVITY_SNAPSHOT` and fold into `ActivityMessage`s.
PART_EVENT_KINDS: frozenset[TaskEventKind] = frozenset(
    {
        "plan",
        "artifact_ref",
        "tool_image",
        "tool_file",
        "code_result",
        "ui_part",
        "mcp_app",
        "verification",
        "suggestions",
        "routed_model",
    }
)


# Discriminated union of every kind the Python service can emit or read
# back. Newer kinds slot in here; the TS-side projection reducer
# tolerates unknown kinds, so a Python-only event survives an older
# client.
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
    | PlanEvent
    | CompactEvent
    | ArtifactRefEvent
    | ToolImageEvent
    | ToolFileEvent
    | CodeResultEvent
    | UiPartEvent
    | McpAppEvent
    | VerificationEvent
    | SuggestionsEvent
    | RoutedModelEvent
    | MessagesSnapshotEvent
)


# --- Wire format -----------------------------------------------------------


def event_to_row_payload(event: TaskEvent) -> dict[str, object]:
    """Serialise an event's kind-specific fields into the jsonb
    `payload` column of `task_events`. Matches the keys the TS side
    writes via `taskEventToRow` in `lib/shared/agent/persistence.ts`
    so the projection reducer accepts rows from either producer.
    """
    if isinstance(event, StatusEvent):
        status_payload: dict[str, object] = {"status": event.status}
        if event.resumed_from_seq is not None:
            status_payload["resumedFromSeq"] = event.resumed_from_seq
        if event.restarted:
            status_payload["restarted"] = True
        return status_payload
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
        if event.error_code is not None:
            result_payload["errorCode"] = event.error_code
        if event.memory_tainted:
            result_payload["memoryTainted"] = True
        if event.usage:
            result_payload["usage"] = [u.to_payload() for u in event.usage]
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
        if event.is_error:
            tool_payload["isError"] = True
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
    if isinstance(event, PlanEvent):
        return {"items": [{"id": i.id, "text": i.text, "status": i.status} for i in event.items]}
    if isinstance(event, CompactEvent):
        return {} if event.summary is None else {"summary": event.summary}
    if isinstance(event, ArtifactRefEvent):
        return {"artifactId": event.artifact_id}
    if isinstance(event, ToolImageEvent):
        return {
            "toolCallId": event.tool_call_id,
            "mode": event.mode,
            "images": list(event.images),
        }
    if isinstance(event, ToolFileEvent):
        return {"toolCallId": event.tool_call_id, "files": list(event.files)}
    if isinstance(event, CodeResultEvent):
        return {
            "toolCallId": event.tool_call_id,
            "stdout": event.stdout,
            "stderr": event.stderr,
            "results": list(event.results),
        }
    if isinstance(event, UiPartEvent):
        ui_payload: dict[str, object] = {"toolCallId": event.tool_call_id, "uiKind": event.ui_kind}
        if event.props is not None:
            ui_payload["props"] = event.props
        return ui_payload
    if isinstance(event, McpAppEvent):
        app_payload: dict[str, object] = {
            "toolCallId": event.tool_call_id,
            "serverId": event.server_id,
            "html": event.html,
        }
        if event.resource_uri is not None:
            app_payload["resourceUri"] = event.resource_uri
        if event.truncated:
            app_payload["truncated"] = True
        return app_payload
    if isinstance(event, VerificationEvent):
        return {"verification": event.verification}
    if isinstance(event, SuggestionsEvent):
        return {"values": list(event.values)}
    if isinstance(event, RoutedModelEvent):
        return {"model": event.model}
    if isinstance(event, MessagesSnapshotEvent):
        return {"messages": list(event.messages)}
    # step_start / step_end carry no payload-only fields.
    return {}


# --- Resume markers ----------------------------------------------------------

#: What a legacy `restarted: true` marker (no `resumedFromSeq`) resumed
#: from. Those were only ever emitted by a reclaimed `start` restarting
#: from its initial checkpoint, whose `seq` is 1 for a run the TS route
#: created (seq 1 is its `status: queued`, which carries `maxSteps`) and
#: 0 for a subagent child (seq 1 is then the dead attempt's initial
#: `status: running`, which carries nothing a consumer folds). Keeping
#: seq 1 is therefore exact for the former and harmless for the latter.
#: Mirror of `LEGACY_RESTART_RESUMED_FROM_SEQ` in
#: `lib/shared/agent/events.ts`.
LEGACY_RESTART_RESUMED_FROM_SEQ = 1


def resume_discard_range(event: TaskEventBase) -> tuple[int, int] | None:
    """`(after, before)` when `event` is a resume marker: the events
    with `after < seq < before` were written by a dead attempt past the
    checkpoint the run resumed from, and are discarded. `None` for any
    other event. Mirror of `resumeDiscardRange` in
    `lib/shared/agent/events.ts`."""
    if not isinstance(event, StatusEvent):
        return None
    if event.resumed_from_seq is not None:
        return event.resumed_from_seq, event.seq
    if event.restarted:
        return LEGACY_RESTART_RESUMED_FROM_SEQ, event.seq
    return None


def drop_superseded_events[E: TaskEventBase](event_list: Iterable[E]) -> list[E]:
    """The event log with every resume marker's discard range removed
    (see `resume_discard_range`) — what the run actually produced,
    without a dead attempt's partial output. The markers themselves are
    kept. Order-preserving; the one place Python consumers of a full
    log (final text, citation inputs, the fan-in) apply the rule.
    Mirror of `dropSupersededEvents` in `lib/shared/agent/events.ts`."""
    events_in = list(event_list)
    ranges = [r for e in events_in if (r := resume_discard_range(e)) is not None]
    if not ranges:
        return events_in
    return [e for e in events_in if not any(lo < e.seq < hi for lo, hi in ranges)]
