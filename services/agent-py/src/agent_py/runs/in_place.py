"""In-place answers to a sub-agent run's question (Q59, contract 0.5.0
`answerRun`, RUN_EVENTS.md § 4.4) — the seam between the runs API and
the executor.

`POST /v1/runs/{runId}/answers` takes AG-UI `ResumeEntry`s; the answer
reaches the worker as a `respond` job, the job the legacy
`/api/tasks/:id/respond` route queues (`enqueue_task_job`, migration
0045, which also enforces "answered once" per question). This module
fixes the job payload one entry becomes, so the router (wave 6-A) and
the executor (wave 6-B) code against one shape:

| `ResumeEntry` | `respond` job payload |
|---|---|
| `{interruptId, status: "resolved", payload: {approved, args?}}` | `{requestId, approved, args?}` |
| `… payload: {selection}` / `{value}` | `{requestId, selection}` / `{requestId, value}` |
| `… payload: {uiAnswer}` | `{requestId, uiAnswer}` |
| `{interruptId, status: "cancelled"}` | `{requestId, cancelled: true}` |

`cancelled: true` is new in 0.5.0: the executor's respond path treats it
as a decline — `approved: false` for an approval, "the user declined to
answer" for the other kinds (`resume_answers.DECLINED_*`), exactly as a
cancelled resume entry (wave 6-B; until then the executor ignores the
key, so an approval reads as not approved and a question as unanswered).
Keys of `payload` other than those above are dropped. Pure; no I/O.
"""

from __future__ import annotations

from collections.abc import Mapping

__all__ = ["ANSWER_KEYS", "respond_job_payload"]

ANSWER_KEYS = ("approved", "args", "selection", "value", "uiAnswer")
"""The answer keys a `respond` job payload carries (`RespondRequestSchema`
in `lib/shared/api-schemas.ts`, without `mcpServers`)."""


def respond_job_payload(entry: Mapping[str, object]) -> dict[str, object]:
    """The `respond` job payload for one AG-UI `ResumeEntry` (JSON).
    Raises `ValueError` for an entry without an `interruptId` or with an
    unknown `status`; shape-checking the answer against its interrupt
    (an approval needs a boolean `approved`) is the caller's job, since
    it needs the interrupt."""
    interrupt_id = entry.get("interruptId")
    if not isinstance(interrupt_id, str) or not interrupt_id:
        raise ValueError("a resume entry needs an interruptId")
    status = entry.get("status")
    if status == "cancelled":
        return {"requestId": interrupt_id, "cancelled": True}
    if status != "resolved":
        raise ValueError(f"unknown resume entry status: {status!r}")
    payload = entry.get("payload")
    out: dict[str, object] = {"requestId": interrupt_id}
    if isinstance(payload, Mapping):
        for key in ANSWER_KEYS:
            if key in payload and payload[key] is not None:
                out[key] = payload[key]
    return out
