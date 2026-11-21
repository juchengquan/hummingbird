"""The AG-UI 1.0 encoder — internal events → AG-UI events (Q13).

Implements `packages/contract/RUN_EVENTS.md` §§ 1 to 5 exactly: block
triples for text and reasoning, tool calls, steps, sub-agents, parts as
`ACTIVITY_SNAPSHOT`, the `hummingbird.*` `CUSTOM` events, and the
closing event built from the run row. Every id it mints is derived from
the log (§ 2), so live encoding, replay and the compaction snapshot
agree.

The stream (`stream.py`) creates one encoder per stream with
`AgUiEncoderFactory`; compaction (`compaction.py`) runs one over the
entries it folds. `gap_event` is the one AG-UI shape the stream needs
that belongs to no entry and no run row — it lives here too, so this
module stays the only place AG-UI shapes are built.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from ..events import (
    ApprovalEvent,
    ArtifactRefEvent,
    CodeResultEvent,
    CompactEvent,
    HandoffEvent,
    McpAppEvent,
    MessagesSnapshotEvent,
    PlanEvent,
    ResultEvent,
    RoutedModelEvent,
    StatusEvent,
    StepEndEvent,
    StepErrorEvent,
    StepStartEvent,
    SuggestionsEvent,
    TaskEvent,
    TokenEvent,
    ToolFileEvent,
    ToolImageEvent,
    ToolInputEvent,
    ToolOutputEvent,
    UiPartEvent,
    VerificationEvent,
    resume_discard_range,
)
from .encoder import AgUiEvent
from .model import RunRecord

__all__ = [
    "CUSTOM_CONTEXT_COMPACTED",
    "CUSTOM_GAP",
    "CUSTOM_INTERRUPT_RESOLVED",
    "CUSTOM_REWIND",
    "CUSTOM_STEP_ERROR",
    "AgUiRunEncoder",
    "activity_for",
    "agui_encoder_factory",
    "compact_json",
    "gap_event",
    "resume_payload",
]

CUSTOM_GAP = "hummingbird.gap"
CUSTOM_REWIND = "hummingbird.rewind"
CUSTOM_STEP_ERROR = "hummingbird.step_error"
CUSTOM_INTERRUPT_RESOLVED = "hummingbird.interrupt_resolved"
CUSTOM_CONTEXT_COMPACTED = "hummingbird.context_compacted"

_CLOSING_RUN_STATUSES = ("succeeded", "failed", "cancelled", "interrupted")


def compact_json(value: object) -> str:
    """RUN_EVENTS.md's `JSON()`: compact separators, keys in the dict's
    order, non-ASCII kept as is — byte for byte what `JSON.stringify`
    produces for the same object (chat's `tool-output-available.output`)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def gap_event(*, after: str, resume_at: int | None, reason: str) -> AgUiEvent:
    """`CUSTOM hummingbird.gap` (`RunGapEventValue`, RUN_EVENTS.md § 6.3)."""
    return {
        "type": "CUSTOM",
        "name": CUSTOM_GAP,
        "value": {"after": after, "resumeAt": resume_at, "reason": reason},
    }


def resume_payload(event: ApprovalEvent) -> dict[str, object]:
    """An `approval` response entry as the `ResumeEntry.payload` shape
    (RUN_EVENTS.md § 4.2): `{uiAnswer}` | `{approved, args?}` |
    `{selection}` | `{value}`. `uiAnswer` wins: the respond wire shim
    fills `value` / `selection` alongside it for older runners."""
    if event.ui_answer is not None:
        return {"uiAnswer": event.ui_answer}
    if event.approved is not None:
        out: dict[str, object] = {"approved": event.approved}
        if event.args is not None:
            out["args"] = event.args
        return out
    if event.selection is not None:
        return {"selection": list(event.selection)}
    if event.value is not None:
        return {"value": event.value}
    return {}


@dataclass(frozen=True)
class Activity:
    """One part entry as an AG-UI activity (RUN_EVENTS.md § 3.3)."""

    message_id: str
    activity_type: str
    content: dict[str, object]


def activity_for(run_id: str, event: TaskEvent) -> Activity | None:
    """The activity a part entry (or a background `result` carrying
    `verification`) becomes; None for every other entry."""
    r = run_id
    if isinstance(event, ToolImageEvent):
        return Activity(
            f"{r}:tool_image:{event.tool_call_id}",
            "hummingbird.tool_image",
            {"id": event.tool_call_id, "mode": event.mode, "images": list(event.images)},
        )
    if isinstance(event, ToolFileEvent):
        return Activity(
            f"{r}:tool_file:{event.tool_call_id}",
            "hummingbird.tool_file",
            {"id": event.tool_call_id, "files": list(event.files)},
        )
    if isinstance(event, CodeResultEvent):
        return Activity(
            f"{r}:code_result:{event.tool_call_id}",
            "hummingbird.code_result",
            {
                "id": event.tool_call_id,
                "stdout": event.stdout,
                "stderr": event.stderr,
                "results": list(event.results),
            },
        )
    if isinstance(event, UiPartEvent):
        ui: dict[str, object] = {"id": event.tool_call_id, "kind": event.ui_kind}
        if event.props is not None:
            ui["props"] = event.props
        return Activity(f"{r}:ui_part:{event.tool_call_id}", "hummingbird.ui_part", ui)
    if isinstance(event, McpAppEvent):
        app: dict[str, object] = {
            "id": event.tool_call_id,
            "serverId": event.server_id,
            "html": event.html,
        }
        if event.resource_uri is not None:
            app["resourceUri"] = event.resource_uri
        if event.truncated:
            app["truncated"] = True
        return Activity(f"{r}:mcp_app:{event.tool_call_id}", "hummingbird.mcp_app", app)
    if isinstance(event, VerificationEvent):
        return Activity(f"{r}:verification", "hummingbird.verification", dict(event.verification))
    if isinstance(event, ResultEvent):
        if event.verification is None:
            return None
        return Activity(f"{r}:verification", "hummingbird.verification", dict(event.verification))
    if isinstance(event, SuggestionsEvent):
        return Activity(
            f"{r}:suggestions", "hummingbird.suggestions", {"values": list(event.values)}
        )
    if isinstance(event, RoutedModelEvent):
        return Activity(f"{r}:routed_model", "hummingbird.routed_model", {"model": event.model})
    if isinstance(event, PlanEvent):
        return Activity(
            f"{r}:plan",
            "hummingbird.plan",
            {"items": [{"id": i.id, "text": i.text, "status": i.status} for i in event.items]},
        )
    if isinstance(event, ArtifactRefEvent):
        return Activity(
            f"{r}:artifact:{event.artifact_id}",
            "hummingbird.artifact_ref",
            {"artifactId": event.artifact_id},
        )
    return None


def tool_result_content(event: ToolOutputEvent) -> str:
    """`TOOL_CALL_RESULT.content` / `ToolMessage.content`: the exact
    string chat's `tool-output-available.output` carries today."""
    body: dict[str, object] = {"summary": event.summary}
    if event.results is not None:
        body["results"] = [
            {"title": r.title, "url": r.url, "snippet": r.snippet} for r in event.results
        ]
    return compact_json(body)


@dataclass
class _OpenSubagent:
    seq: int
    agent: str
    subagent_run_id: str
    child_task_id: str | None


class AgUiRunEncoder:
    """The `AgUiEncoder` for one stream of one run. Not thread-safe;
    one stream drives it sequentially."""

    def __init__(self, run_id: str) -> None:
        self._run_id = run_id
        # The open block: (kind, messageId) with kind "text" | "reasoning".
        self._block: tuple[str, str] | None = None
        # The current step's parent message id (what tool calls attach to).
        self._parent: str | None = None
        self._subagents: list[_OpenSubagent] = []
        self._last_result: ResultEvent | None = None
        self._finished = False

    # --- ids ---------------------------------------------------------------

    def _id(self, seq: int) -> str:
        return f"{self._run_id}:{seq}"

    # --- the Protocol --------------------------------------------------------

    def start(self, run: RunRecord) -> list[AgUiEvent]:
        started: AgUiEvent = {"type": "RUN_STARTED", "threadId": run.thread_id, "runId": run.id}
        if run.parent_run_id is not None:
            started["parentRunId"] = run.parent_run_id
        return [started]

    def encode(self, event: TaskEvent) -> list[AgUiEvent]:
        if self._finished:
            raise RuntimeError("encoder already finished")
        if isinstance(event, TokenEvent):
            return self._token(event)

        out: list[AgUiEvent] = []
        marker = resume_discard_range(event)
        if marker is not None:
            # A resume marker discards — without closing — the open block:
            # live, it was opened by the dead attempt, whose events the
            # client drops on `rewind` (END events at the marker's own seq
            # would survive that and end a message the client no longer
            # has); on replay the superseded entries are gone, so nothing
            # is open here (checkpoints sit at step boundaries).
            after = marker[0]
            self._block = None
            self._parent = None
            self._subagents = [s for s in self._subagents if s.seq <= after]
            if self._last_result is not None and self._last_result.seq > after:
                self._last_result = None
            out.append({"type": "CUSTOM", "name": CUSTOM_REWIND, "value": {"after": after}})
            return out

        out.extend(self._close_block())
        out.extend(self._entry(event))
        return out

    def finish(self, run: RunRecord) -> list[AgUiEvent]:
        status = run.status
        if status not in _CLOSING_RUN_STATUSES:
            raise ValueError(f"run {run.id} has not ended (status {status})")
        out = self._close_block()
        self._finished = True
        usage = self._usage()
        if status == "failed":
            code, message = self._error(run)
            error: AgUiEvent = {"type": "RUN_ERROR", "message": message, "code": code}
            if usage:
                error["usage"] = usage
            out.append(error)
            return out
        closing: AgUiEvent = {"type": "RUN_FINISHED", "threadId": run.thread_id, "runId": run.id}
        if status == "interrupted":
            closing["outcome"] = {"type": "interrupt", "interrupts": list(run.open_interrupts)}
        elif status == "cancelled":
            closing["outcome"] = {"type": "cancelled"}
        else:
            closing["outcome"] = {"type": "success"}
            closing["result"] = self._result(run)
        if usage:
            closing["usage"] = usage
        out.append(closing)
        return out

    # --- blocks ----------------------------------------------------------------

    def _close_block(self) -> list[AgUiEvent]:
        block, self._block = self._block, None
        if block is None:
            return []
        kind, message_id = block
        if kind == "text":
            return [{"type": "TEXT_MESSAGE_END", "messageId": message_id}]
        return [
            {"type": "REASONING_MESSAGE_END", "messageId": message_id},
            {"type": "REASONING_END", "messageId": message_id},
        ]

    def _token(self, event: TokenEvent) -> list[AgUiEvent]:
        if not event.text:
            return []
        out: list[AgUiEvent] = []
        if event.channel == "reasoning":
            if self._block is not None and self._block[0] != "reasoning":
                out.extend(self._close_block())
            if self._block is None:
                mid = self._id(event.seq)
                self._block = ("reasoning", mid)
                out.append({"type": "REASONING_START", "messageId": mid})
                out.append(
                    {"type": "REASONING_MESSAGE_START", "messageId": mid, "role": "reasoning"}
                )
            out.append(
                {
                    "type": "REASONING_MESSAGE_CONTENT",
                    "messageId": self._block[1],
                    "delta": event.text,
                }
            )
            return out
        if self._block is not None and self._block[0] != "text":
            out.extend(self._close_block())
        if self._block is None:
            mid = self._id(event.seq)
            self._block = ("text", mid)
            self._parent = mid
            out.append({"type": "TEXT_MESSAGE_START", "messageId": mid, "role": "assistant"})
        out.append(
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": self._block[1], "delta": event.text}
        )
        return out

    # --- everything else ---------------------------------------------------------

    def _entry(self, event: TaskEvent) -> list[AgUiEvent]:
        if isinstance(event, StepStartEvent):
            self._parent = None
            return [{"type": "STEP_STARTED", "stepName": f"step-{event.step}"}]
        if isinstance(event, StepEndEvent):
            return [{"type": "STEP_FINISHED", "stepName": f"step-{event.step}"}]
        if isinstance(event, ToolInputEvent):
            if self._parent is None:
                self._parent = self._id(event.seq)
            return [
                {
                    "type": "TOOL_CALL_START",
                    "toolCallId": event.tool_call_id,
                    "toolCallName": event.tool_name,
                    "parentMessageId": self._parent,
                },
                {
                    "type": "TOOL_CALL_ARGS",
                    "toolCallId": event.tool_call_id,
                    "delta": compact_json(event.args),
                },
                {"type": "TOOL_CALL_END", "toolCallId": event.tool_call_id},
            ]
        if isinstance(event, ToolOutputEvent):
            hb: dict[str, object] = {"toolName": event.tool_name}
            if event.is_error:
                hb["isError"] = True
            return [
                {
                    "type": "TOOL_CALL_RESULT",
                    "messageId": self._id(event.seq),
                    "toolCallId": event.tool_call_id,
                    "role": "tool",
                    "content": tool_result_content(event),
                    "metadata": {"hummingbird": hb},
                }
            ]
        if isinstance(event, StepErrorEvent):
            return [
                {
                    "type": "CUSTOM",
                    "name": CUSTOM_STEP_ERROR,
                    "value": {"message": event.message, "willRetry": event.will_retry},
                }
            ]
        if isinstance(event, HandoffEvent):
            return self._handoff(event)
        if isinstance(event, ApprovalEvent):
            if event.phase != "response":
                return []
            return [
                {
                    "type": "CUSTOM",
                    "name": CUSTOM_INTERRUPT_RESOLVED,
                    "value": {"interruptId": event.approval_id, "payload": resume_payload(event)},
                }
            ]
        if isinstance(event, CompactEvent):
            value: dict[str, object] = {}
            if event.summary is not None:
                value["summary"] = event.summary
            return [{"type": "CUSTOM", "name": CUSTOM_CONTEXT_COMPACTED, "value": value}]
        if isinstance(event, MessagesSnapshotEvent):
            return [{"type": "MESSAGES_SNAPSHOT", "messages": list(event.messages)}]
        if isinstance(event, ResultEvent):
            self._last_result = event
        if isinstance(event, StatusEvent):
            return []
        activity = activity_for(self._run_id, event)
        if activity is not None:
            return [
                {
                    "type": "ACTIVITY_SNAPSHOT",
                    "messageId": activity.message_id,
                    "activityType": activity.activity_type,
                    "content": activity.content,
                    "replace": True,
                }
            ]
        return []

    def _handoff(self, event: HandoffEvent) -> list[AgUiEvent]:
        if event.phase == "enter":
            sub_id = event.child_task_id or self._id(event.seq)
            self._subagents.append(
                _OpenSubagent(event.seq, event.agent, sub_id, event.child_task_id)
            )
            started: AgUiEvent = {
                "type": "SUBAGENT_STARTED",
                "subagentRunId": sub_id,
                "name": event.agent,
            }
            if event.subgoal is not None:
                started["metadata"] = {"hummingbird": {"subgoal": event.subgoal}}
            return [started]
        match: _OpenSubagent | None = None
        if event.child_task_id is not None:
            match = next(
                (s for s in self._subagents if s.subagent_run_id == event.child_task_id), None
            )
        else:
            match = next((s for s in reversed(self._subagents) if s.agent == event.agent), None)
        if match is None:
            return []
        self._subagents.remove(match)
        return [{"type": "SUBAGENT_FINISHED", "subagentRunId": match.subagent_run_id}]

    # --- closing data (§ 5) ------------------------------------------------------

    def _usage(self) -> list[dict[str, object]]:
        if self._last_result is None:
            return []
        return [u.to_payload() for u in self._last_result.usage]

    def _result(self, run: RunRecord) -> dict[str, object]:
        if run.result is not None:
            return dict(run.result)
        out: dict[str, object] = {}
        res = self._last_result
        if res is not None and res.status == "done":
            if res.final_text is not None:
                out["text"] = res.final_text
            if res.memory_tainted:
                out["memoryTainted"] = True
        return out

    def _error(self, run: RunRecord) -> tuple[str, str]:
        if run.error is not None:
            code = run.error.get("code")
            message = run.error.get("message")
            return (
                code if isinstance(code, str) else "unknown",
                message if isinstance(message, str) else "Run failed.",
            )
        res = self._last_result
        if res is not None and res.status == "failed":
            return res.error_code or "unknown", res.error or "Run failed."
        return ("worker_lost" if run.mode == "interactive" else "no_worker"), "Run failed."


def agui_encoder_factory(run: RunRecord) -> AgUiRunEncoder:
    """The `AgUiEncoderFactory` to hand the runs API / streams."""
    return AgUiRunEncoder(run.id)
