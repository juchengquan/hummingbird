"""From a validated `StartRunRequest` to what the run model consumes.

* `build_run_input` — the harness's `RunInput` (AG-UI input as plain
  JSON + what the backend knows about the run).
* `check_resume` — Q24: a `resume[]` must answer exactly the open
  interrupts of `forwardedProps.previousRunId`, each payload shaped as
  its interrupt's `responseSchema` (RUN_EVENTS.md § 4).
* `background_checkpoint` — the `{messages, config}` start state the
  background executor reads from `tasks.checkpoint` (the same shape the
  Next task route writes). AG-UI → model input is `runs.history`'s, the
  same conversion the native harness applies to an interactive run.
"""

from __future__ import annotations

from typing import Any

from ..contract import models
from .harness import ResumeAnswer, RunInput
from .history import last_user_text, normalize, system_texts, to_anthropic
from .model import RunMode, RunRecord

__all__ = [
    "DEFAULT_BACKGROUND_MAX_STEPS",
    "background_checkpoint",
    "build_run_input",
    "check_resume",
    "forwarded_props",
    "last_user_text",
]

DEFAULT_BACKGROUND_MAX_STEPS = 25
"""`RunForwardedProps.maxSteps` absent on a background run (the spec's 25)."""


def forwarded_props(body: models.StartRunRequest) -> models.RunForwardedProps:
    return body.forwardedProps or models.RunForwardedProps()


def _dump(value: Any) -> dict[str, object]:
    out = value.model_dump(mode="json", exclude_none=True)
    return out if isinstance(out, dict) else {}


def resume_answers(body: models.StartRunRequest) -> tuple[ResumeAnswer, ...]:
    return tuple(
        ResumeAnswer(interrupt_id=r.interruptId, status=r.status, payload=r.payload)
        for r in body.resume or ()
    )


def build_run_input(
    body: models.StartRunRequest,
    *,
    mode: RunMode,
    user_id: str | None,
    previous_run_id: str | None,
) -> RunInput:
    fp = forwarded_props(body)
    return RunInput(
        run_id=body.runId,
        thread_id=body.threadId,
        mode=mode,
        user_id=user_id,
        messages=tuple(_dump(m) for m in body.messages),
        options=_dump(fp),
        tools=tuple(_dump(t) for t in body.tools or ()),
        context=tuple(_dump(c) for c in body.context or ()),
        state=body.state,
        resume=resume_answers(body),
        previous_run_id=previous_run_id,
    )


# --- Resume (Q24) ------------------------------------------------------------------

_PAYLOAD_CHECKS: dict[str, tuple[str, type | tuple[type, ...]]] = {
    "approval": ("approved", bool),
    "choice": ("selection", list),
    "input": ("value", str),
    "ui-part": ("uiAnswer", dict),
}


def _payload_problem(reason: object, payload: object) -> str | None:
    check = _PAYLOAD_CHECKS.get(str(reason))
    if check is None:
        return None
    key, kind = check
    if not isinstance(payload, dict) or not isinstance(payload.get(key), kind):
        return f"payload must be an object with `{key}`"
    if key == "selection" and not all(isinstance(s, str) for s in payload[key]):
        return "payload `selection` must be a list of strings"
    return None


class ResumeMismatch(Exception):
    """409 `invalid_state`: the resume does not match the previous run."""


class ResumeInvalid(Exception):
    """400 `invalid_request`: a resume payload is malformed."""


def check_resume(previous: RunRecord | None, body: models.StartRunRequest) -> None:
    """Raises `ResumeMismatch` unless `previous` is the caller's run on the
    same thread, `interrupted`, and `resume[]` answers exactly its open
    interrupts (each once); `ResumeInvalid` when a `resolved` answer's
    payload does not fit its interrupt's `responseSchema`."""
    if previous is None or previous.thread_id != body.threadId:
        raise ResumeMismatch("The previous run is not one of yours on this thread.")
    if previous.status != "interrupted":
        raise ResumeMismatch(f"The previous run is {previous.status}, not interrupted.")
    open_by_id = {str(i.get("id")): i for i in previous.open_interrupts}
    answers = body.resume or []
    ids = [a.interruptId for a in answers]
    if len(set(ids)) != len(ids) or set(ids) != set(open_by_id):
        raise ResumeMismatch("resume[] must answer every open interrupt of the previous run once.")
    for answer in answers:
        if answer.status != "resolved":
            continue
        problem = _payload_problem(open_by_id[answer.interruptId].get("reason"), answer.payload)
        if problem is not None:
            raise ResumeInvalid(f"resume[{answer.interruptId}]: {problem}.")


# --- Background start state --------------------------------------------------------


def background_checkpoint(
    body: models.StartRunRequest, *, model: str, max_steps: int
) -> dict[str, object]:
    """`{messages, config}` for `create_run` (0041 pins `step`, `seq` and
    `config.maxSteps`). Messages become the executor's Anthropic-shaped
    model messages via `runs.history` (user text / images / documents,
    assistant text + tool calls, tool results; reasoning and activity
    messages dropped); `system` / `developer` text joins
    `forwardedProps.systemPrompt` as the run's system prompt."""
    agui = [_dump(m) for m in body.messages]
    messages: list[dict[str, Any]] = normalize(to_anthropic(agui))
    fp = forwarded_props(body)
    config: dict[str, object] = {"model": model, "maxSteps": max_steps}
    system = "\n\n".join([*([fp.systemPrompt] if fp.systemPrompt else []), *system_texts(agui)])
    if system:
        config["workspaceSystemPrompt"] = system
    if fp.skills:
        config["skills"] = [_dump(s) for s in fp.skills]
    return {"messages": messages, "config": config}
