"""Value types of the run model, shared by every interface in `runs/`.

The vocabulary of `packages/contract/RUN_EVENTS.md` and the runs
operations in `packages/contract/openapi.yaml`, in Python. Only small,
pure helpers live here — the ones more than one wave-3b workstream needs
to agree on byte for byte (status mapping, interrupt → AG-UI, the replay
cursor, the `tasks.outcome` JSON, the `Run` resource JSON).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from ..events import (
    ApprovalEvent,
    ApprovalRequestKind,
    InputRequestOption,
    TokenUsage,
)
from ..events import (
    RunStatus as InternalStatus,
)

__all__ = [
    "Cancelled",
    "ContractStatus",
    "Failed",
    "InternalStatus",
    "Interrupted",
    "PendingInterrupt",
    "RunCursor",
    "RunMode",
    "RunOutcome",
    "RunOwner",
    "RunRecord",
    "RunResultData",
    "Succeeded",
    "contract_status",
    "outcome_from_json",
    "outcome_to_json",
    "run_to_contract",
]

RunMode = Literal["interactive", "background"]
"""`tasks.mode` / the contract's `RunMode`."""

ContractStatus = Literal["queued", "running", "interrupted", "succeeded", "failed", "cancelled"]
"""The contract's `RunStatus` (what clients see)."""


def contract_status(internal: InternalStatus, *, has_open_interrupts: bool) -> ContractStatus:
    """`tasks.status` → contract status (RUN_EVENTS.md § 1). `paused`
    is `interrupted` only while the run has open interrupts; a background
    parent paused on its sub-agent runs is still `running`."""
    if internal == "paused":
        return "interrupted" if has_open_interrupts else "running"
    mapping: dict[InternalStatus, ContractStatus] = {
        "queued": "queued",
        "running": "running",
        "done": "succeeded",
        "failed": "failed",
        "cancelled": "cancelled",
    }
    return mapping[internal]


# --- Owners ------------------------------------------------------------------


@dataclass(frozen=True)
class RunOwner:
    """Who a run belongs to: a signed-in user, or — for an anonymous run —
    whoever holds its `runToken`. Exactly one field is set. An anonymous
    owner is keyed by the SHA-256 of the token, so the token itself is
    never stored and a retry with the same token is the same owner."""

    user_id: str | None = None
    anonymous_key: str | None = None

    def __post_init__(self) -> None:
        if (self.user_id is None) == (self.anonymous_key is None):
            raise ValueError("RunOwner needs exactly one of user_id / anonymous_key")

    @staticmethod
    def user(user_id: str) -> RunOwner:
        return RunOwner(user_id=user_id)

    @staticmethod
    def anonymous(run_token: str) -> RunOwner:
        return RunOwner(anonymous_key=hashlib.sha256(run_token.encode()).hexdigest())

    @property
    def is_anonymous(self) -> bool:
        return self.anonymous_key is not None


# --- Interrupts --------------------------------------------------------------

_RESPONSE_SCHEMAS: dict[ApprovalRequestKind, dict[str, object]] = {
    "approval": {
        "type": "object",
        "required": ["approved"],
        "properties": {"approved": {"type": "boolean"}, "args": {}},
    },
    "choice": {
        "type": "object",
        "required": ["selection"],
        "properties": {"selection": {"type": "array", "items": {"type": "string"}}},
    },
    "input": {
        "type": "object",
        "required": ["value"],
        "properties": {"value": {"type": "string"}},
    },
    "ui-part": {
        "type": "object",
        "required": ["uiAnswer"],
        "properties": {"uiAnswer": {"type": "object"}},
    },
}


@dataclass(frozen=True)
class PendingInterrupt:
    """One thing an interrupted run waits for — the internal form of an
    AG-UI `Interrupt`, field for field the request half of an
    `ApprovalEvent`. A harness returns these in `Interrupted`; the run
    driver writes one `approval` request entry per interrupt and stores
    `to_agui()` in `tasks.outcome`."""

    id: str
    """The interrupt id clients answer by (today: the gated tool call's id)."""
    request_kind: ApprovalRequestKind = "approval"
    tool: str | None = None
    tool_call_id: str | None = None
    args: dict[str, object] | None = None
    prompt: str | None = None
    options: tuple[InputRequestOption, ...] | None = None
    multi: bool | None = None
    ui_kind: str | None = None
    ui_props: dict[str, object] | None = None

    def to_agui(self) -> dict[str, object]:
        """The AG-UI `Interrupt` (RUN_EVENTS.md § 4.1)."""
        out: dict[str, object] = {
            "id": self.id,
            "reason": self.request_kind,
            "responseSchema": _RESPONSE_SCHEMAS[self.request_kind],
        }
        if self.prompt is not None:
            out["message"] = self.prompt
        if self.tool_call_id is not None:
            out["toolCallId"] = self.tool_call_id
        hb: dict[str, object] = {}
        if self.tool is not None:
            hb["tool"] = self.tool
        if self.args is not None:
            hb["args"] = self.args
        if self.options is not None:
            hb["options"] = [{"id": o.id, "label": o.label} for o in self.options]
        if self.multi is not None:
            hb["multi"] = self.multi
        if self.ui_kind is not None:
            hb["uiKind"] = self.ui_kind
        if self.ui_props is not None:
            hb["uiProps"] = self.ui_props
        if hb:
            out["metadata"] = {"hummingbird": hb}
        return out

    @staticmethod
    def from_approval(event: ApprovalEvent) -> PendingInterrupt:
        """From an `approval` request entry (the pre-0041 fallback for
        open interrupts, RUN_EVENTS.md § 1)."""
        return PendingInterrupt(
            id=event.approval_id,
            request_kind=event.request_kind or "approval",
            tool=event.tool,
            tool_call_id=event.tool_call_id,
            args=event.args,
            prompt=event.prompt,
            options=tuple(event.options) if event.options is not None else None,
            multi=event.multi,
            ui_kind=event.ui_kind,
            ui_props=event.ui_props,
        )


# --- Outcomes ----------------------------------------------------------------


@dataclass(frozen=True)
class RunResultData:
    """A succeeded run's return value — the contract's `RunResult` and
    `RUN_FINISHED.result`. `extra` carries additive keys verbatim."""

    text: str | None = None
    memory_tainted: bool = False
    extra: dict[str, object] = field(default_factory=dict)

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = dict(self.extra)
        if self.text is not None:
            out["text"] = self.text
        if self.memory_tainted:
            out["memoryTainted"] = True
        return out

    @staticmethod
    def from_json(raw: dict[str, object]) -> RunResultData:
        text = raw.get("text")
        return RunResultData(
            text=text if isinstance(text, str) else None,
            memory_tainted=raw.get("memoryTainted") is True,
            extra={k: v for k, v in raw.items() if k not in ("text", "memoryTainted")},
        )


@dataclass(frozen=True)
class Succeeded:
    result: RunResultData = field(default_factory=RunResultData)
    usage: tuple[TokenUsage, ...] = ()


@dataclass(frozen=True)
class Interrupted:
    """The run stops until a new run answers every interrupt (Q24)."""

    interrupts: tuple[PendingInterrupt, ...]

    def __post_init__(self) -> None:
        if not self.interrupts:
            raise ValueError("Interrupted needs at least one interrupt")


@dataclass(frozen=True)
class Failed:
    code: str
    """An `ApiError` code (`rate_limit`, `provider`, `worker_lost`, …)."""
    message: str
    usage: tuple[TokenUsage, ...] = ()


@dataclass(frozen=True)
class Cancelled:
    usage: tuple[TokenUsage, ...] = ()


RunOutcome = Succeeded | Interrupted | Failed | Cancelled
"""How a run ended. `tasks.outcome` stores it (`outcome_to_json`)."""


def outcome_to_json(outcome: RunOutcome) -> dict[str, object]:
    """The `tasks.outcome` jsonb (migration 0041): shaped like AG-UI's
    closing event. Usage is not stored here — it lives on the log's
    `result` entry."""
    if isinstance(outcome, Succeeded):
        return {"type": "success", "result": outcome.result.to_json()}
    if isinstance(outcome, Interrupted):
        return {"type": "interrupt", "interrupts": [i.to_agui() for i in outcome.interrupts]}
    if isinstance(outcome, Failed):
        return {"type": "error", "code": outcome.code, "message": outcome.message}
    return {"type": "cancelled"}


def outcome_from_json(raw: object) -> tuple[str, dict[str, object]] | None:
    """`(type, body)` of a stored outcome, or None when absent/garbled.
    Interrupts stay AG-UI JSON (that is what `Run.openInterrupts` and
    `RUN_FINISHED` carry), so this is a light reader, not a full decode."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in ("success", "interrupt", "error", "cancelled"):
        return None
    return str(kind), raw


# --- The run record ----------------------------------------------------------


@dataclass(frozen=True)
class RunRecord:
    """One run as the repository reads it: a `tasks` row (or an anonymous
    run in memory). `open_interrupts`, `result` and `error` are already in
    their contract JSON shapes."""

    id: str
    owner: RunOwner
    thread_id: str
    mode: RunMode
    internal_status: InternalStatus
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    parent_run_id: str | None = None
    previous_run_id: str | None = None
    goal: str | None = None
    max_steps: int | None = None
    """The step budget (`tasks.max_steps`)."""
    step: int | None = None
    """Steps taken so far (`tasks.step`) — background-run progress."""
    open_interrupts: tuple[dict[str, object], ...] = ()
    result: dict[str, object] | None = None
    error: dict[str, object] | None = None
    lease_expires_at: datetime | None = None
    # --- Task identity (contract 0.5.0, migration 0047; RUN_EVENTS.md § 4.5).
    # Wave 6-A fills these cheaply in the repositories (no checkpoint read,
    # no per-row query); until then they keep these defaults.
    root_run_id: str | None = None
    """The task's root run (`tasks.root_run_id`); None reads as `id`."""
    current_run_id: str | None = None
    """None when this run is its task's current run
    (`public.task_run_is_current`); else the task's current run
    (`public.task_current_run_id`)."""
    research: bool = False
    """`tasks.research` (Q46)."""
    delivered: bool = False
    """The task's root has `result_delivered_at` (Q77)."""
    children_asking: int = 0
    """Live sub-agent runs of this run paused on a question."""
    answer_pending: bool = False
    """A `respond` job for this run is queued or running while the run is
    still `paused` (an in-place answer not picked up yet, Q59)."""

    @property
    def status(self) -> ContractStatus:
        return contract_status(self.internal_status, has_open_interrupts=bool(self.open_interrupts))

    @property
    def is_live(self) -> bool:
        """Still executing or waiting to (`queued` / `running`, including a
        background parent paused on its sub-agents)."""
        return self.status in ("queued", "running")


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.isoformat().replace("+00:00", "Z")


def run_to_contract(run: RunRecord, *, last_seq: int) -> dict[str, object]:
    """The contract's `Run` resource. `last_seq` comes from the event log
    (`RunEventLog.last_seq`). Applies the status ↔ result / error /
    openInterrupts rule: only the field matching the status is filled.
    `goal` / `maxSteps` / `step` are background-run progress, null for an
    interactive run. The task fields (0.5.0) come from the record as the
    repository read it; `delivered` is a background-run notion, so false
    for an interactive run."""
    status = run.status
    background = run.mode == "background"
    return {
        "id": run.id,
        "threadId": run.thread_id,
        "mode": run.mode,
        "status": status,
        "parentRunId": run.parent_run_id,
        "previousRunId": run.previous_run_id,
        "openInterrupts": list(run.open_interrupts) if status == "interrupted" else [],
        "result": (run.result or {}) if status == "succeeded" else None,
        "error": run.error if status == "failed" else None,
        "lastSeq": last_seq,
        "goal": run.goal if background else None,
        "maxSteps": run.max_steps if background else None,
        "step": run.step if background else None,
        "createdAt": _iso(run.created_at),
        "startedAt": _iso(run.started_at),
        "finishedAt": _iso(run.finished_at),
        "updatedAt": _iso(run.updated_at),
        "rootRunId": run.root_run_id or run.id,
        "currentRunId": run.current_run_id,
        "research": run.research,
        "delivered": run.delivered if background else False,
        "childrenAsking": run.children_asking,
        "answerPending": run.answer_pending if status == "interrupted" else False,
    }


# --- Replay cursor -------------------------------------------------------------

_CURSOR_RE = re.compile(r"(0|[1-9][0-9]{0,9})(?:\.(0|[1-9][0-9]{0,3}))?", re.ASCII)


@dataclass(frozen=True, order=False)
class RunCursor:
    """A stream position (RUN_EVENTS.md § 6.2): after log entry `seq`
    entirely (`k is None`, wire `"<seq>"`), or after the `k`-th AG-UI
    event entry `seq` produced (wire `"<seq>.<k>"`). `RunCursor(0)` is the
    start of the run."""

    seq: int
    k: int | None = None

    @staticmethod
    def parse(raw: str) -> RunCursor:
        """Raises ValueError on anything but the `RunCursor` grammar."""
        m = _CURSOR_RE.fullmatch(raw)
        if m is None:
            raise ValueError(f"invalid run cursor: {raw!r}")
        return RunCursor(int(m.group(1)), None if m.group(2) is None else int(m.group(2)))

    def __str__(self) -> str:
        return str(self.seq) if self.k is None else f"{self.seq}.{self.k}"

    def sort_key(self) -> tuple[int, float]:
        """`s.0 < s.1 < … < s` — an entry's last event is plain `s`."""
        return (self.seq, float("inf") if self.k is None else float(self.k))

    def __lt__(self, other: RunCursor) -> bool:
        return self.sort_key() < other.sort_key()

    def __le__(self, other: RunCursor) -> bool:
        return self.sort_key() <= other.sort_key()

    @staticmethod
    def for_event(seq: int, index: int, count: int) -> RunCursor:
        """The id of the `index`-th of the `count` events entry `seq`
        encoded to: plain `seq` for the last, `seq.index` before it."""
        if not 0 <= index < count:
            raise ValueError("index out of range")
        return RunCursor(seq) if index == count - 1 else RunCursor(seq, index)
