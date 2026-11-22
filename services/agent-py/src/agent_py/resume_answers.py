"""A background run's answers to the run it resumes (Q41).

A runs-API resume of a paused background run (`POST /v1/runs` with
`forwardedProps.previousRunId` + `resume[]`, mode `background`) is a new
`tasks` row whose checkpoint is the paused run's checkpoint plus the
answers under `RESUME_KEY` (`runs.run_input.resume_checkpoint` writes it).
The executor's `start` applies them before the loop (`executor`
`_apply_resume_answers`): each answered interrupt's tool call gets its
`tool_result` — the approved tool's output, the "declined" text or the
answer itself — in one step of the new run, then the run continues from
there. The paused run itself is never touched (it stays `paused`, the
contract's `interrupted`).

The answer → result text mirrors the native harness's `_answer`
(`runs/native_harness.py`) so an interactive and a background resume
tell the model the same thing; the payload shapes are RUN_EVENTS.md
§ 4.2's (`{approved, args?}` / `{selection}` / `{value}` / `{uiAnswer}`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

__all__ = [
    "DECLINED_ANSWER",
    "DECLINED_APPROVAL",
    "RESUME_KEY",
    "StoredAnswer",
    "answer_text",
    "approved_args",
    "parse_resume",
    "resume_block",
]

RESUME_KEY = "resume"
"""The checkpoint key holding `{previousRunId, answers: [...]}`. Only a
resume run's initial checkpoint carries it; the executor drops it once
the answers are applied (`executor._build_checkpoint` keeps only
`messages` / `step` / `seq` / `config`)."""

# The native harness's texts (`runs/native_harness.py`), kept identical.
DECLINED_APPROVAL = (
    "User declined to run this action. Consider an alternative or ask the user how to proceed."
)
DECLINED_ANSWER = "The user declined to answer."


@dataclass(frozen=True)
class StoredAnswer:
    """One `ResumeEntry` as stored in the resume run's checkpoint."""

    interrupt_id: str
    status: Literal["resolved", "cancelled"]
    payload: dict[str, Any] | None = None

    @property
    def resolved(self) -> bool:
        return self.status == "resolved"

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = {"interruptId": self.interrupt_id, "status": self.status}
        if self.payload is not None:
            out["payload"] = self.payload
        return out


def resume_block(previous_run_id: str, answers: list[StoredAnswer]) -> dict[str, object]:
    """The `RESUME_KEY` value."""
    return {"previousRunId": previous_run_id, "answers": [a.to_json() for a in answers]}


def parse_resume(checkpoint: dict[str, Any]) -> tuple[StoredAnswer, ...] | None:
    """The answers a resume run's checkpoint carries; None when it carries
    none (every non-resume checkpoint). A malformed block raises
    `ValueError` — the run fails rather than continuing past questions
    nobody answered."""
    raw = checkpoint.get(RESUME_KEY)
    if raw is None:
        return None
    answers = raw.get("answers") if isinstance(raw, dict) else None
    if not isinstance(answers, list) or not answers:
        raise ValueError("resume: the checkpoint's answers are malformed")
    out: list[StoredAnswer] = []
    for item in answers:
        if not isinstance(item, dict):
            raise ValueError("resume: the checkpoint's answers are malformed")
        interrupt_id = item.get("interruptId")
        status = item.get("status")
        payload = item.get("payload")
        if not isinstance(interrupt_id, str) or not interrupt_id:
            raise ValueError("resume: an answer has no interruptId")
        if status not in ("resolved", "cancelled"):
            raise ValueError(f"resume: answer {interrupt_id} has an invalid status")
        out.append(
            StoredAnswer(
                interrupt_id=interrupt_id,
                status=status,
                payload=payload if isinstance(payload, dict) else None,
            )
        )
    return tuple(out)


def approved_args(
    kind: str, answer: StoredAnswer, call_args: dict[str, Any]
) -> dict[str, Any] | None:
    """For an `approval` the user approved: the arguments to run the tool
    with (`payload.args` when they edited them, else the call's own).
    None otherwise — the call gets `answer_text` instead."""
    if kind != "approval" or not answer.resolved:
        return None
    payload = answer.payload or {}
    if payload.get("approved") is not True:
        return None
    override = payload.get("args")
    return dict(override) if isinstance(override, dict) else dict(call_args)


def _strings(value: object) -> list[str]:
    return [s for s in value if isinstance(s, str)] if isinstance(value, list) else []


def answer_text(kind: str, answer: StoredAnswer) -> str:
    """The `tool_result` text for an answer that runs no tool: a declined
    or cancelled approval, or a choice / input / ui-part answer."""
    if kind == "approval":
        return DECLINED_APPROVAL
    if not answer.resolved:
        return DECLINED_ANSWER
    p = answer.payload or {}
    selection = _strings(p.get("selection"))
    value = p.get("value")
    if kind == "choice":
        return (
            f"User selected: {', '.join(selection)}"
            if selection
            else "(User submitted no selection.)"
        )
    if kind == "input":
        return value if isinstance(value, str) and value else "(User submitted no value.)"
    # ui-part: the client's formatted text, else the raw answer.
    ui_answer = p.get("uiAnswer")
    if isinstance(value, str) and value:
        return value
    if selection:
        return ", ".join(selection)
    if isinstance(ui_answer, dict) and ui_answer:
        return json.dumps(ui_answer, default=str)
    return "(User submitted no answer.)"
