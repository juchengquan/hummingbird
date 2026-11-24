"""RunStore — Supabase Postgres writes for tasks + task_events.

Python mirror of `lib/server/agent/store.ts`. All writes are
`user_id`-scoped on top of the own-your-rows RLS (defence in depth).

Phase 2a scope: the writes the executor needs to drive a `start`
action end-to-end:

  - `update_run` — flip task status / step / handler / mark finished.
  - `append_event` — idempotent on `(task_id, seq)` so a retried emit
    (or an overlapping replay) is a no-op rather than a duplicate.
  - `set_task_handler` — stamp `tasks.metadata.handler = 'python'` so
    postmortems can tell which service ran which run.
  - `is_run_cancelled` — cheap probe the runner polls between steps.

`create_run` and `save_checkpoint` are deliberately NOT in this PR —
the route already creates the task row before enqueueing the
`start` job, and Phase 2a doesn't yet implement HITL pause/resume.
Both land alongside Phase 2b / Phase 3.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Literal, cast, get_args

import asyncpg
import structlog

from . import events, jobs
from .events import TaskEvent, event_to_row_payload
from .fence import fenced_connection


async def update_run(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    status: str | None = None,
    step: int | None = None,
    finished: bool = False,
) -> bool:
    """Patch a live `tasks` row. Only the fields explicitly passed get
    written — partial updates are intentional so the executor can
    bump just `step` between steps without touching status. An ended
    row is left alone (terminal is final): False."""
    sets: list[str] = ["updated_at = now()"]
    args: list[object] = []
    if status is not None:
        sets.append(f"status = ${len(args) + 1}")
        args.append(status)
    if step is not None:
        sets.append(f"step = ${len(args) + 1}")
        args.append(step)
    if finished:
        sets.append("finished_at = now()")
    args.append(_coerce_uuid(run_id))
    args.append(_coerce_uuid(user_id))
    sql = (
        "UPDATE public.tasks "
        f"SET {', '.join(sets)} "
        f"WHERE id = ${len(args) - 1} AND user_id = ${len(args)} "
        "AND status NOT IN ('done', 'failed', 'cancelled');"
    )
    async with fenced_connection(pool) as conn:
        return bool(await conn.execute(sql, *args) != "UPDATE 0")


_APPEND_EVENT_SQL = """
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (task_id, seq) DO NOTHING;
"""


async def append_event(
    pool: asyncpg.Pool,
    event: TaskEvent,
    *,
    user_id: str,
) -> None:
    """Insert one event row. Idempotent — a duplicate seq hits the
    `(task_id, seq)` unique constraint and is silently ignored,
    matching the TS path's `onConflict: 'task_id,seq', ignoreDuplicates: true`.
    """
    async with fenced_connection(pool) as conn:
        await _insert_event(conn, event, _coerce_uuid(user_id))


async def _insert_event(conn: asyncpg.Connection, event: TaskEvent, user_id: uuid.UUID) -> None:
    await conn.execute(
        _APPEND_EVENT_SQL,
        _coerce_uuid(event.run_id),
        user_id,
        event.seq,
        event.step,
        event.kind,
        json.dumps(event_to_row_payload(event)),
    )


_log = structlog.get_logger(__name__)

_VALID_KINDS: frozenset[str] = frozenset(get_args(events.TaskEventKind))


def _opt_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _dict_tuple(value: object) -> tuple[dict[str, object], ...]:
    """A list of JSON objects read back from a payload; non-objects dropped."""
    if not isinstance(value, list):
        return ()
    return tuple(v for v in value if isinstance(v, dict))


def event_from_row_payload(
    *,
    seq: int,
    step: int,
    kind: str,
    created_at: str,
    payload: dict[str, object],
) -> events.TaskEvent | None:
    """Reverse of `events.event_to_row_payload` for one row.
    Returns `None` when `kind` is unknown (caller skips with a
    warning). Mirrors the TS-side projection's tolerance for newer
    event kinds. `run_id` is left empty here and patched in by the
    caller from the WHERE clause.

    `kind` is a separate `task_events.kind` column (NOT part of the
    payload jsonb) per supabase/migrations/0012_tasks.sql.
    `event_to_row_payload` writes the kind-specific fields only;
    this function reads them back by switching on the column value."""
    if kind not in _VALID_KINDS:
        _log.warning("store.unknown_event_kind", kind=str(kind))
        return None
    base: dict[str, object] = {
        "run_id": "",
        "seq": seq,
        "step": step,
        "created_at": created_at,
    }
    merged = {**base, **payload}
    if kind == "token":
        return events.TokenEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            text=str(merged.get("text", "")),
            channel=cast("Literal['text', 'reasoning']", merged.get("channel", "text")),
        )
    if kind == "status":
        return events.StatusEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            status=cast(
                "Literal['queued','running','paused','cancelled','done','failed']",
                merged.get("status", "running"),
            ),
            resumed_from_seq=_resumed_from_seq(merged.get("resumedFromSeq")),
            restarted=merged.get("restarted") is True,
        )
    if kind == "tool_output":
        results_raw = merged.get("results")
        results: list[events.ToolCallResult] | None = None
        if isinstance(results_raw, list):
            results = [
                events.ToolCallResult(
                    title=str(r.get("title", "")),
                    url=str(r.get("url", "")),
                    snippet=str(r.get("snippet", "")),
                )
                for r in results_raw
                if isinstance(r, dict)
            ]
        return events.ToolOutputEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            tool_name=str(merged.get("toolName", "")),
            summary=str(merged.get("summary", "")),
            results=results,
            is_error=merged.get("isError") is True,
        )
    if kind == "result":
        return events.ResultEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            status=cast("Literal['done', 'failed']", merged.get("status", "done")),
            final_text=cast(
                "str | None",
                merged.get("finalText") if isinstance(merged.get("finalText"), str) else None,
            ),
            error=cast(
                "str | None", merged.get("error") if isinstance(merged.get("error"), str) else None
            ),
            verification=cast(
                "dict[str, object] | None",
                merged.get("verification")
                if isinstance(merged.get("verification"), dict)
                else None,
            ),
            error_code=_opt_str(merged.get("errorCode")),
            memory_tainted=merged.get("memoryTainted") is True,
            usage=tuple(
                u
                for u in (
                    events.TokenUsage.from_payload(raw)
                    for raw in cast("list[object]", merged.get("usage") or [])
                )
                if u is not None
            )
            if isinstance(merged.get("usage"), list)
            else (),
            stopped_at=_opt_str(merged.get("stoppedAt")),
            images=tuple(
                cast("dict[str, object]", i)
                for i in cast("list[object]", merged.get("images") or [])
                if isinstance(i, dict)
            )
            if isinstance(merged.get("images"), list)
            else (),
        )
    if kind == "step_start":
        return events.StepStartEvent(run_id="", seq=seq, step=step, created_at=created_at)
    if kind == "step_end":
        return events.StepEndEvent(run_id="", seq=seq, step=step, created_at=created_at)
    if kind == "tool_input":
        args = merged.get("args")
        return events.ToolInputEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            tool_name=str(merged.get("toolName", "")),
            args=args if isinstance(args, dict) else {},
        )
    if kind == "step_error":
        return events.StepErrorEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            message=str(merged.get("message", "")),
            will_retry=bool(merged.get("willRetry", True)),
        )
    if kind == "approval":
        return events.ApprovalEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            approval_id=str(merged.get("approvalId", "")),
            phase=cast("Literal['request', 'response']", merged.get("phase", "request")),
            request_kind=cast(
                "Literal['approval','choice','input','ui-part'] | None", merged.get("requestKind")
            ),
            tool=cast(
                "str | None", merged.get("tool") if isinstance(merged.get("tool"), str) else None
            ),
            tool_call_id=cast(
                "str | None",
                merged.get("toolCallId") if isinstance(merged.get("toolCallId"), str) else None,
            ),
            args=cast(
                "dict[str, object] | None",
                merged.get("args") if isinstance(merged.get("args"), dict) else None,
            ),
            prompt=cast(
                "str | None",
                merged.get("prompt") if isinstance(merged.get("prompt"), str) else None,
            ),
            options=[
                events.InputRequestOption(id=str(o.get("id", "")), label=str(o.get("label", "")))
                for o in _dict_tuple(merged.get("options"))
            ]
            if isinstance(merged.get("options"), list)
            else None,
            multi=cast(
                "bool | None",
                merged.get("multi") if isinstance(merged.get("multi"), bool) else None,
            ),
            ui_kind=cast(
                "str | None",
                merged.get("uiKind") if isinstance(merged.get("uiKind"), str) else None,
            ),
            ui_props=cast(
                "dict[str, object] | None",
                merged.get("uiProps") if isinstance(merged.get("uiProps"), dict) else None,
            ),
            approved=cast(
                "bool | None",
                merged.get("approved") if isinstance(merged.get("approved"), bool) else None,
            ),
            selection=cast(
                "list[str] | None",
                merged.get("selection") if isinstance(merged.get("selection"), list) else None,
            ),
            value=cast(
                "str | None", merged.get("value") if isinstance(merged.get("value"), str) else None
            ),
            ui_answer=cast(
                "dict[str, object] | None",
                merged.get("uiAnswer") if isinstance(merged.get("uiAnswer"), dict) else None,
            ),
        )
    if kind == "handoff":
        return events.HandoffEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            agent=str(merged.get("agent", "")),
            phase=cast("Literal['enter', 'exit']", merged.get("phase", "enter")),
            child_task_id=_opt_str(merged.get("childTaskId")),
            subgoal=_opt_str(merged.get("subgoal")),
        )
    if kind == "plan":
        items = tuple(
            events.PlanItem(
                id=str(i.get("id", "")),
                text=str(i.get("text", "")),
                status=cast("events.PlanItemStatus", i.get("status", "pending")),
            )
            for i in _dict_tuple(merged.get("items"))
        )
        return events.PlanEvent(run_id="", seq=seq, step=step, created_at=created_at, items=items)
    if kind == "compact":
        return events.CompactEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            summary=_opt_str(merged.get("summary")),
        )
    if kind == "artifact_ref":
        return events.ArtifactRefEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            artifact_id=str(merged.get("artifactId", "")),
        )
    if kind == "tool_image":
        return events.ToolImageEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            mode=cast("events.ToolImageMode", merged.get("mode", "t2i")),
            images=_dict_tuple(merged.get("images")),
        )
    if kind == "tool_file":
        return events.ToolFileEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            files=_dict_tuple(merged.get("files")),
        )
    if kind == "code_result":
        return events.CodeResultEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            stdout=str(merged.get("stdout", "")),
            stderr=str(merged.get("stderr", "")),
            results=_dict_tuple(merged.get("results")),
        )
    if kind == "ui_part":
        props = merged.get("props")
        return events.UiPartEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            ui_kind=str(merged.get("uiKind", "")),
            props=cast("dict[str, object]", props) if isinstance(props, dict) else None,
        )
    if kind == "mcp_app":
        return events.McpAppEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            tool_call_id=str(merged.get("toolCallId", "")),
            server_id=str(merged.get("serverId", "")),
            html=str(merged.get("html", "")),
            resource_uri=_opt_str(merged.get("resourceUri")),
            truncated=merged.get("truncated") is True,
        )
    if kind == "verification":
        verification = merged.get("verification")
        return events.VerificationEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            verification=cast("dict[str, object]", verification)
            if isinstance(verification, dict)
            else {},
        )
    if kind == "suggestions":
        values = merged.get("values")
        return events.SuggestionsEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            values=tuple(v for v in values if isinstance(v, str))
            if isinstance(values, list)
            else (),
        )
    if kind == "routed_model":
        return events.RoutedModelEvent(
            run_id="", seq=seq, step=step, created_at=created_at, model=str(merged.get("model", ""))
        )
    if kind == "messages_snapshot":
        return events.MessagesSnapshotEvent(
            run_id="",
            seq=seq,
            step=step,
            created_at=created_at,
            messages=_dict_tuple(merged.get("messages")),
        )
    # Unhandled kinds in this build; the row was preserved but not
    # parsed. Caller should skip + warn.
    _log.warning("store.unhandled_event_kind", kind=kind)
    return None


def _resumed_from_seq(raw: object) -> int | None:
    """A status row's `resumedFromSeq`, or None when absent / not a
    non-negative int (a malformed marker degrades to a plain status)."""
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        return None
    return raw


# The runs before `$1` on its task's line (Q75, Q78; RUN_EVENTS.md § 4.5):
# the top-level runs of its root that hold the task's question — the root,
# and every resume that is live, done or ended after applying its answers
# (0047's `task_run_is_current` rule). A resume that failed or was cancelled
# before applying is a dead branch, never on the line. By `root_run_id`, so
# a deleted middle run doesn't cut the line short. Oldest first.
_TASK_LINE_SQL = """
SELECT t.id
FROM public.tasks r
JOIN public.tasks t
  ON t.user_id = r.user_id
 AND t.root_run_id = COALESCE(r.root_run_id, r.id)
 AND t.parent_task_id IS NULL
 AND t.id <> r.id
 AND (t.created_at, t.id) < (r.created_at, r.id)
WHERE r.id = $1 AND r.user_id = $2 AND r.parent_task_id IS NULL
  AND (t.previous_run_id IS NULL
       OR t.status NOT IN ('failed', 'cancelled')
       OR t.answers_applied_at IS NOT NULL)
ORDER BY t.created_at, t.id;
"""


async def load_task_line(pool: asyncpg.Pool, *, run_id: str, user_id: str) -> list[str]:
    """The ids of the runs before `run_id` on its task's line, oldest
    first (`_TASK_LINE_SQL`); `[]` for a task's only run or a sub-agent
    run (answered in place: its own log is its whole answer)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(_TASK_LINE_SQL, _coerce_uuid(run_id), _coerce_uuid(user_id))
    return [str(r["id"]) for r in rows]


_CHILD_IMAGES_SQL = """
SELECT t.outcome -> 'result' -> 'images' AS images
  FROM public.tasks t
 WHERE t.parent_task_id = ANY($1::uuid[])
   AND t.user_id = $2
   AND t.status = 'done'
 ORDER BY t.created_at, t.id
"""


async def load_child_images(
    pool: asyncpg.Pool, *, parent_ids: list[str], user_id: str
) -> list[dict[str, object]]:
    """The images of the succeeded sub-agent runs of `parent_ids`, in the
    order they were spawned (Q87): each child's `outcome.result.images`,
    which already gathers its own sub-agents'."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            _CHILD_IMAGES_SQL, [_coerce_uuid(p) for p in parent_ids], _coerce_uuid(user_id)
        )
    out: list[dict[str, object]] = []
    for row in rows:
        raw = row["images"]
        images = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(images, list):
            out.extend(i for i in images if isinstance(i, dict))
    return out


async def load_run_events(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> list[events.TaskEvent]:
    """Read the full event log for a run, in seq order, and
    deserialise each row's payload jsonb into a TaskEvent. Used
    by the citation verifier to re-aggregate report text +
    web-search sources at the terminal `result` for a multi-chunk
    run. Same keyset as `append_event` writes (task_id, user_id,
    seq, step, kind, payload)."""
    # `_set_user_context` issues `SET LOCAL`, which only takes effect
    # inside a transaction — outside one Postgres warns and the query
    # runs as the pool's (RLS-bypassing) role. The explicit
    # `user_id = $2` filter is defence in depth on top of RLS.
    async with pool.acquire() as conn, conn.transaction():
        await _set_user_context(conn, user_id=user_id)
        rows = await conn.fetch(
            "SELECT seq, step, kind, payload::text AS payload, created_at "
            "FROM public.task_events WHERE task_id = $1 AND user_id = $2 ORDER BY seq",
            run_id,
            user_id,
        )
    out: list[events.TaskEvent] = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except (ValueError, TypeError):
            _log.warning(
                "store.bad_event_payload",
                run_id=run_id,
                seq=row["seq"],
            )
            continue
        ev = event_from_row_payload(
            seq=row["seq"],
            step=row["step"],
            kind=row["kind"],
            created_at=row["created_at"].isoformat()
            if hasattr(row["created_at"], "isoformat")
            else str(row["created_at"]),
            payload=payload,
        )
        if ev is None:
            continue
        # Patch the run_id back in (the SELECT didn't carry it; the
        # WHERE clause already filtered by it).
        object.__setattr__(ev, "run_id", run_id)
        out.append(ev)
    return out


_SET_HANDLER_SQL = """
UPDATE public.tasks
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('handler', $3::text),
    updated_at = now()
WHERE id = $1 AND user_id = $2;
"""


async def set_task_handler(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    handler: str,
) -> None:
    """Stamp `tasks.metadata.handler` so post-hoc analysis can tell
    which service executed a given run. The TS worker leaves this
    unset; Python writes 'python'. Lets us audit the Phase 2 cutover
    without instrumenting the worker code paths.

    Needs `tasks.metadata` (migration 0030). The executor treats a
    failure here as non-fatal — it's an audit nicety, not run state."""
    async with pool.acquire() as conn:
        await conn.execute(
            _SET_HANDLER_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
            handler,
        )


_MAX_EVENT_SEQ_SQL = """
SELECT COALESCE(MAX(seq), 0) AS max_seq FROM public.task_events
WHERE task_id = $1 AND user_id = $2;
"""


async def max_event_seq(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> int:
    """Highest `seq` already written for this run (0 when none).

    The executor seeds its emitter at `max(checkpoint.seq, this)` so it
    never re-uses a seq another writer already took — `append_event` is
    `ON CONFLICT DO NOTHING`, so a reused seq is a silently dropped
    event. Covers the TS route's `status: queued` (seq=1) on a fresh
    start and any events emitted after the last checkpoint save."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            _MAX_EVENT_SEQ_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
        )
    if not row:
        return 0
    value = row["max_seq"]
    return int(value) if value is not None else 0


_CLAIM_PAUSED_FOR_RESPOND_SQL = """
UPDATE public.tasks
SET status = 'running', outcome = NULL, finished_at = NULL, updated_at = now()
WHERE id = $1 AND user_id = $2 AND status = 'paused'
  AND private.task_waits_on(id, $3)
  AND NOT private.question_held_by_resume(id, $3)
RETURNING id;
"""


async def claim_paused_for_respond(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    question: str,
) -> bool:
    """Atomically flip a run paused on `question` to `running` for a
    `respond` job. This is the durable record that the answer is being
    applied, before any side effect: the run no longer waits on the
    question (0045), so nothing can answer it again.

    Returns True iff THIS call made the transition. A duplicate respond
    (double-click, retried POST, two workers) finds the row already
    `running` / settled / re-paused-and-claimed and gets False — the
    caller must then settle the job as a no-op rather than re-execute
    the approved tool."""
    async with fenced_connection(pool) as conn:
        row = await conn.fetchrow(
            _CLAIM_PAUSED_FOR_RESPOND_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
            question,
        )
    return row is not None


_OWNED_TASK_STATUS_SQL = """
SELECT status FROM public.tasks WHERE id = $1 AND user_id = $2;
"""


async def load_owned_task_status(
    pool: asyncpg.Pool,
    *,
    task_id: str,
    user_id: str,
) -> str | None:
    """`tasks.status` of `task_id` when it belongs to `user_id`, else
    None.

    `task_jobs` RLS lets a user insert any row with their own
    `user_id`, including one pointing at someone else's `task_id`. The
    poller checks this before executing so a forged job can't drive
    (or settle) another user's run — and skips a job whose task is
    already terminal (e.g. failed by the stale-run reconciler while the
    job sat unclaimed), instead of running a settled task again."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            _OWNED_TASK_STATUS_SQL,
            _coerce_uuid(task_id),
            _coerce_uuid(user_id),
        )
    return str(row["status"]) if row is not None else None


_IS_CANCELLED_SQL = """
SELECT status FROM public.tasks
WHERE id = $1 AND user_id = $2;
"""


async def is_run_cancelled(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> bool:
    """Cheap probe the runner polls between steps: did the run end under
    us (cancelled, or failed by the reconciler / the owner)? A probe
    failure (DB blip, RLS reject) returns False — the run keeps going,
    and every write re-checks."""
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                _IS_CANCELLED_SQL,
                _coerce_uuid(run_id),
                _coerce_uuid(user_id),
            )
    except Exception:
        return False
    return bool(row and row["status"] in events.TERMINAL_STATUSES)


_LOAD_CHECKPOINT_SQL = """
SELECT checkpoint FROM public.tasks
WHERE id = $1 AND user_id = $2;
"""


async def load_checkpoint(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> dict[str, object] | None:
    """Read the `tasks.checkpoint` jsonb column.

    Shape mirrors `RunCheckpoint` in `lib/server/agent/checkpoint.ts` —
    `{messages, step, seq, config: {model, system?, workspaceId?,
    skills, maxSteps, mode?, ...}}`. Returns the raw dict; the
    executor / step fn coerce the bits they need.

    Returns `None` when the row isn't found (RLS reject, race with
    delete) or when `checkpoint` is null (never written — shouldn't
    happen post-route but defensive against the early Phase 2a flow
    which can race in tests). The caller decides whether to bail or
    fall back."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            _LOAD_CHECKPOINT_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
        )
    if not row:
        return None
    raw = row["checkpoint"]
    if raw is None:
        return None
    if isinstance(raw, str):
        # asyncpg returns jsonb as `str` unless a codec is registered.
        # Decode lazily here so callers don't have to.
        try:
            decoded = json.loads(raw)
        except Exception:
            return None
        return decoded if isinstance(decoded, dict) else None
    if isinstance(raw, dict):
        return raw
    return None


_SAVE_CHECKPOINT_SQL = """
UPDATE public.tasks
SET checkpoint = $3::jsonb,
    updated_at = now()
WHERE id = $1 AND user_id = $2
  AND status NOT IN ('done', 'failed', 'cancelled');
"""


async def save_checkpoint(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    checkpoint: dict[str, object],
) -> bool:
    """Overwrite a live run's `tasks.checkpoint` jsonb column with the executor's
    current state. Phase 3a uses this on the chunk-break path
    (`AgentLoopResult.kind == "yielded"`): we persist `messages` +
    `step` + `seq` + the same `config` we loaded, then enqueue a
    `continue` job that picks up from here.

    Same shape as `RunCheckpoint` in `lib/server/agent/checkpoint.ts`
    so a Python-written checkpoint is loadable by the TS worker
    (defence in depth — flag flip should never strand a run mid-loop).

    False: the run has ended (cancelled under us). Nothing was written,
    and the caller must not act any further."""
    async with fenced_connection(pool) as conn:
        result = await conn.execute(
            _SAVE_CHECKPOINT_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
            json.dumps(checkpoint),
        )
    return bool(result != "UPDATE 0")


_START_RUNNING_SQL = """
UPDATE public.tasks
SET status = 'running', updated_at = now()
WHERE id = $1 AND user_id = $2 AND status = 'queued'
RETURNING status;
"""


async def start_running(pool: asyncpg.Pool, *, run_id: str, user_id: str) -> str | None:
    """`queued` → `running` as a worker starts executing (a run reads
    `queued` only until it is claimed); returns the status the run has
    now, None when there is no such run."""
    async with fenced_connection(pool) as conn:
        row = await conn.fetchrow(_START_RUNNING_SQL, _coerce_uuid(run_id), _coerce_uuid(user_id))
        if row is None:
            row = await conn.fetchrow(
                _OWNED_TASK_STATUS_SQL, _coerce_uuid(run_id), _coerce_uuid(user_id)
            )
    return str(row["status"]) if row is not None else None


_MARK_APPLIED_SQL = """
UPDATE public.tasks
SET answers_applied_at = COALESCE(answers_applied_at, now()), updated_at = now()
WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running')
RETURNING id;
"""


async def mark_answers_applied(pool: asyncpg.Pool, *, run_id: str, user_id: str) -> bool:
    """A resume run commits to its answers — before any side effect (Q57).
    From here the questions can never be answered again, whatever becomes
    of the run. False: the run has ended; apply nothing."""
    async with fenced_connection(pool) as conn:
        row = await conn.fetchrow(_MARK_APPLIED_SQL, _coerce_uuid(run_id), _coerce_uuid(user_id))
    return row is not None


_COMMIT_PAUSE_SQL = """
UPDATE public.tasks
SET status = 'paused', checkpoint = $3::jsonb, outcome = $4::jsonb,
    finished_at = now(), updated_at = now()
WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running')
RETURNING id;
"""


async def commit_pause(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    checkpoint: dict[str, object],
    outcome: dict[str, object],
    pause_events: list[TaskEvent],
) -> bool:
    """Pause on a question in ONE transaction: the checkpoint, `paused`
    with its open interrupts and `finished_at`, and the request entries.
    False — nothing written, so no answerable question — when the run
    ended first (a cancel won)."""
    run_uuid, user_uuid = _coerce_uuid(run_id), _coerce_uuid(user_id)
    async with fenced_connection(pool) as conn, conn.transaction():
        row = await conn.fetchrow(
            _COMMIT_PAUSE_SQL, run_uuid, user_uuid, json.dumps(checkpoint), json.dumps(outcome)
        )
        if row is None:
            return False
        for event in pause_events:
            await _insert_event(conn, event, user_uuid)
    return True


_COMMIT_YIELD_SQL = """
UPDATE public.tasks
SET checkpoint = $3::jsonb, updated_at = now()
WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running')
RETURNING id;
"""


async def commit_yield(
    pool: asyncpg.Pool, *, run_id: str, user_id: str, checkpoint: dict[str, object]
) -> bool:
    """End a chunk: the checkpoint and the `continue` job in one
    transaction. False when the run ended first."""
    run_uuid, user_uuid = _coerce_uuid(run_id), _coerce_uuid(user_id)
    async with fenced_connection(pool) as conn, conn.transaction():
        row = await conn.fetchrow(_COMMIT_YIELD_SQL, run_uuid, user_uuid, json.dumps(checkpoint))
        if row is None:
            return False
        await conn.execute(
            jobs.ENQUEUE_CONTINUE_SQL, run_uuid, user_uuid, "continue", json.dumps({})
        )
    return True


_OPEN_QUESTION_SQL = """
SELECT e.payload->>'approvalId' AS id
FROM public.task_events e
WHERE e.task_id = $1 AND e.user_id = $2 AND e.kind = 'approval'
  AND e.payload->>'phase' = 'request'
  AND NOT EXISTS (
    SELECT 1 FROM public.task_events a
    WHERE a.task_id = e.task_id AND a.user_id = e.user_id AND a.kind = 'approval'
      AND a.seq > e.seq
      AND a.payload->>'phase' = 'response'
      AND a.payload->>'approvalId' = e.payload->>'approvalId')
ORDER BY e.seq DESC
LIMIT 1;
"""


async def load_open_question(pool: asyncpg.Pool, *, run_id: str, user_id: str) -> str | None:
    """The question a run paused before 0045 waits on: its log's newest
    request that no later response answers (`private.task_waits_on`)."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(_OPEN_QUESTION_SQL, _coerce_uuid(run_id), _coerce_uuid(user_id))
    if row is None or row["id"] is None:
        return None
    return str(row["id"])


def _coerce_uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)


async def load_parent_task_id(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> str | None:
    """Read `parent_task_id` from the tasks row. Returns None when the
    row has no parent (top-level task) or when the row isn't found.

    `user_id`-scoped like the other store helpers (defence in depth on
    top of RLS) — the depth cap is a safety guard, but keeping the
    filter consistent avoids a cross-user row leaking into the check."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT parent_task_id FROM public.tasks WHERE id = $1 AND user_id = $2;",
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
        )
    parent = row["parent_task_id"] if row else None
    return str(parent) if parent is not None else None


async def load_conversation_id(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> str:
    """Read `conversation_id` from the tasks row. Returns the id as a
    string. Raises when the row isn't found — callers must ensure the
    task exists before calling."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT conversation_id FROM public.tasks WHERE id = $1 AND user_id = $2;",
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
        )
    if not row or row["conversation_id"] is None:
        raise ValueError(f"load_conversation_id: no conversation_id for task {run_id}")
    return str(row["conversation_id"])


# --- Child-task helpers -------------------------------------------------------


def _as_dict(value: object) -> dict[str, object] | None:
    """Coerce a jsonb column value to a plain dict.

    asyncpg may return jsonb as a native dict (if a codec is registered)
    or as a JSON string (the default). Handle both, plus None. Returns
    None when the value is absent or not parseable as a dict — callers
    treat None as "no data"."""
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
            return decoded if isinstance(decoded, dict) else None
        except (ValueError, TypeError):
            return None
    return None


_CREATE_CHILD_TASK_SQL = """
INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, parent_task_id, checkpoint)
VALUES (gen_random_uuid(), $1, $2, $3, 'queued', $4, $5::jsonb)
RETURNING id;
"""


async def create_child_task(
    pool: asyncpg.Pool,
    *,
    parent_task_id: str,
    user_id: str,
    conversation_id: str,
    goal: str,
    checkpoint: dict[str, object],
) -> str:
    """Insert a child task row and return its new id.

    The checkpoint must include the subagent metadata under the
    `subagent` key (e.g. `{"personaSlug": "researcher", "subgoal": "..."}`).
    The child starts in 'queued' status; caller enqueues a `start` job
    separately via `jobs.enqueue_start_job`."""
    async with fenced_connection(pool) as conn:
        row = await conn.fetchrow(
            _CREATE_CHILD_TASK_SQL,
            _coerce_uuid(user_id),
            _coerce_uuid(conversation_id),
            goal,
            _coerce_uuid(parent_task_id),
            json.dumps(checkpoint),
        )
    return str(row["id"])


@dataclass(frozen=True)
class ChildSpawn:
    """One child task to create in `commit_spawn`. The id is minted by
    the caller so the handoff events can name it before the commit."""

    id: str
    goal: str
    checkpoint: dict[str, object]


LOCK_TASK_SCOPE_SQL = "SELECT private.lock_task_scope($1, $2);"

_TASK_CHILD_COUNT_SQL = "SELECT private.task_child_count($1);"


class ChildCapReached(Exception):
    """`commit_spawn` refused: the task already has `started` sub-agent
    runs, and this spawn would take it past `cap` (Q72). Nothing was
    written."""

    def __init__(self, started: int, cap: int) -> None:
        super().__init__(f"task has {started} sub-agent runs (cap {cap})")
        self.started = started
        self.cap = cap


async def task_child_count(pool: asyncpg.Pool, *, task_id: str) -> int:
    """Sub-agent runs `task_id`'s task has started, over every run of its
    chain (`private.task_child_count`, 0047). Unlocked: a pre-check;
    `commit_spawn` counts again under the lock."""
    async with pool.acquire() as conn:
        return int(await conn.fetchval(_TASK_CHILD_COUNT_SQL, _coerce_uuid(task_id)) or 0)


# Parent first: flip to `paused` with the absolute barrier count and the
# `awaiting_children` checkpoint — unless it settled (cancelled) under us.
_SPAWN_PARENT_SQL = """
UPDATE public.tasks
SET status = 'paused',
    pending_children = $3,
    checkpoint = $4::jsonb,
    outcome = NULL,
    finished_at = NULL,
    updated_at = now()
WHERE id = $1 AND user_id = $2
  AND status NOT IN ('done', 'failed', 'cancelled')
RETURNING id;
"""

_SPAWN_CHILD_SQL = """
INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, parent_task_id, checkpoint)
VALUES ($1, $2, $3, $4, 'queued', $5, $6::jsonb);
"""

_SPAWN_CHILD_JOB_SQL = """
INSERT INTO public.task_jobs (task_id, user_id, action, payload, status, scheduled_at)
VALUES ($1, $2, 'start', '{}'::jsonb, 'queued', now());
"""


async def commit_spawn(
    pool: asyncpg.Pool,
    *,
    parent_task_id: str,
    user_id: str,
    conversation_id: str,
    children: list[ChildSpawn],
    checkpoint: dict[str, object],
    spawn_events: list[TaskEvent] | None = None,
    max_task_children: int | None = None,
) -> bool:
    """Fan out in ONE transaction: the parent goes `paused` with
    `pending_children = len(children)` and its `awaiting_children`
    checkpoint, then the child rows and their `start` jobs are inserted.

    Atomic on purpose — the join barrier needs the parent's counter,
    checkpoint and status in place before any child can settle. With the
    old step-by-step writes a child job committed first could finish
    before the counter was set (decrementing 0 → -1, after which the
    absolute `n` never reaches zero) or before the parent was paused +
    checkpointed (the fan-in `continue` would resume a parent with no
    `awaiting_children`). Children's jobs are invisible to workers until
    the commit.

    Returns False — and creates nothing, announces nothing — when the
    parent already settled (e.g. cancelled while this chunk ran).
    `spawn_events` (the handoffs) commit with it.

    `max_task_children` (Q72): the task's sub-agent runs so far
    (`private.task_child_count`, every run of its chain) are counted under
    the user's task lock — which every writer of children holds — and a
    spawn that would pass the cap raises `ChildCapReached`, writing
    nothing."""
    parent_uuid = _coerce_uuid(parent_task_id)
    user_uuid = _coerce_uuid(user_id)
    async with fenced_connection(pool) as conn, conn.transaction():
        # 0045's lock order: conversation, user, then the task rows — so a
        # cancel either sees these children or stops this spawn.
        await conn.execute(LOCK_TASK_SCOPE_SQL, user_uuid, parent_uuid)
        if max_task_children is not None:
            started = int(await conn.fetchval(_TASK_CHILD_COUNT_SQL, parent_uuid) or 0)
            if started + len(children) > max_task_children:
                raise ChildCapReached(started, max_task_children)
        parent = await conn.fetchrow(
            _SPAWN_PARENT_SQL,
            parent_uuid,
            user_uuid,
            len(children),
            json.dumps(checkpoint),
        )
        if parent is None:
            return False
        conv_uuid = _coerce_uuid(conversation_id)
        for child in children:
            child_uuid = _coerce_uuid(child.id)
            await conn.execute(
                _SPAWN_CHILD_SQL,
                child_uuid,
                user_uuid,
                conv_uuid,
                child.goal,
                parent_uuid,
                json.dumps(child.checkpoint),
            )
            await conn.execute(_SPAWN_CHILD_JOB_SQL, child_uuid, user_uuid)
        for event in spawn_events or ():
            await _insert_event(conn, event, user_uuid)
    return True


# The checkpoint's `seq` moves past its sub-agent runs' `handoff` `exit`
# entries, written to the parent's log while it waited (0049): they are the
# run's own, not a dead attempt's, so a reclaim's resume marker
# (`resumedFromSeq` = the checkpoint's seq) must not rewind them. Only those:
# anything else past the checkpoint is a dead attempt's, and stays rewound.
_CLAIM_PAUSED_FOR_FAN_IN_SQL = """
UPDATE public.tasks t
SET status = 'running', outcome = NULL, finished_at = NULL, updated_at = now(),
    checkpoint = CASE
      WHEN jsonb_typeof(t.checkpoint) = 'object' THEN jsonb_set(
        t.checkpoint, '{seq}', to_jsonb(GREATEST(
          CASE WHEN jsonb_typeof(t.checkpoint -> 'seq') = 'number'
               THEN (t.checkpoint ->> 'seq')::numeric::integer ELSE 0 END,
          (SELECT COALESCE(MAX(e.seq), 0) FROM public.task_events e
            WHERE e.task_id = t.id AND e.kind = 'handoff' AND e.payload ->> 'phase' = 'exit')
        )))
      ELSE t.checkpoint
    END
WHERE t.id = $1 AND t.user_id = $2 AND t.status = 'paused' AND t.pending_children <= 0
RETURNING t.id;
"""


_MAX_EXIT_SEQ_SQL = """
SELECT COALESCE(MAX(e.seq), 0) FROM public.task_events e
WHERE e.task_id = $1 AND e.user_id = $2 AND e.kind = 'handoff' AND e.payload ->> 'phase' = 'exit';
"""


async def max_exit_handoff_seq(pool: asyncpg.Pool, *, run_id: str, user_id: str) -> int:
    """The last `handoff` `exit` entry of a parent's log (0049: written as
    its sub-agent runs end, never by a worker); 0 without one."""
    async with pool.acquire() as conn:
        value = await conn.fetchval(_MAX_EXIT_SEQ_SQL, _coerce_uuid(run_id), _coerce_uuid(user_id))
    return int(value or 0)


async def claim_paused_for_fan_in(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
) -> bool:
    """Atomically flip a parent paused on its subagents back to
    `running` once every child settled (`pending_children <= 0`).

    The fan-in `continue` (and a stranded paused run being recovered)
    must do this before running: a run left `paused` while it actually
    runs is skipped by `poller.reclaim_decision` if its worker dies —
    the job is settled and the task stays paused forever. Returns True
    iff THIS call made the transition."""
    async with fenced_connection(pool) as conn:
        row = await conn.fetchrow(
            _CLAIM_PAUSED_FOR_FAN_IN_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
        )
    return row is not None


_SET_PENDING_CHILDREN_SQL = (
    "UPDATE public.tasks SET pending_children = $2, updated_at = now() "
    "WHERE id = $1 AND user_id = $3;"
)


async def set_pending_children(pool: asyncpg.Pool, *, task_id: str, user_id: str, n: int) -> None:
    """Set the barrier counter on the parent task.

    `pending_children` starts at `n` and each child decrements it on
    completion. When it hits 0 the orchestrator fan-in step fires."""
    async with fenced_connection(pool) as conn:
        await conn.execute(
            _SET_PENDING_CHILDREN_SQL, _coerce_uuid(task_id), n, _coerce_uuid(user_id)
        )


@dataclass(frozen=True)
class ChildResult:
    """One child task's settled outcome for fan-in aggregation."""

    persona_slug: str
    subgoal: str
    status: str
    final_text: str


# Per child: its `result` rows plus its resume markers (a `status` row
# carrying `resumedFromSeq`, or the legacy `restarted` flag), so a
# `result` a dead attempt wrote past the checkpoint its reclaimed re-run
# resumed from is discarded by the same rule as every other consumer
# (`events.drop_superseded_events`) instead of being read as the child's
# answer.
_LOAD_CHILD_RESULTS_SQL = """
SELECT t.id, t.status, t.checkpoint,
  (SELECT jsonb_agg(
            jsonb_build_object('seq', e.seq, 'step', e.step, 'kind', e.kind, 'payload', e.payload)
            ORDER BY e.seq)
     FROM public.task_events e
     WHERE e.task_id = t.id AND e.user_id = t.user_id
       AND (e.kind = 'result'
            OR (e.kind = 'status'
                AND (e.payload ? 'resumedFromSeq' OR e.payload->>'restarted' = 'true')))
  ) AS result_events
FROM public.tasks t
WHERE t.parent_task_id = $1 AND t.user_id = $2
ORDER BY t.created_at ASC;
"""


def _final_text_from_result_rows(raw: object) -> str:
    """The `finalText` of a child's last `result` event that no resume
    marker supersedes, from the `result_events` jsonb array (rows of
    `{seq, step, kind, payload}`), else ""."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return ""
    if not isinstance(raw, list):
        return ""
    decoded: list[events.TaskEvent] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        seq, step, payload = row.get("seq"), row.get("step"), row.get("payload")
        if not isinstance(seq, int) or not isinstance(payload, dict):
            continue
        ev = event_from_row_payload(
            seq=seq,
            step=step if isinstance(step, int) else 0,
            kind=str(row.get("kind", "")),
            created_at="",
            payload=payload,
        )
        if ev is not None:
            decoded.append(ev)
    results = [
        e for e in events.drop_superseded_events(decoded) if isinstance(e, events.ResultEvent)
    ]
    if not results:
        return ""
    return results[-1].final_text or ""


async def load_child_results(
    pool: asyncpg.Pool,
    *,
    parent_task_id: str,
    user_id: str,
    children: list[dict[str, object]] | None = None,
) -> list[ChildResult]:
    """Read one spawn round's children and map them to ChildResult.

    `children` is the round as the parent's checkpoint names it
    (`awaiting_children.children`: `{id, personaSlug, subgoal}`): the
    results come in its order, and a child that is gone (deleted) is
    reported with status `deleted`. Without it (no such list), every
    child of the parent.

    Reads the subagent metadata (personaSlug / subgoal) from each
    child's `tasks.checkpoint.subagent` jsonb key, and the final text
    from the child's last surviving `result` event payload under the
    `finalText` key (camelCase — mirrors the wire format written by
    `events.event_to_row_payload` for ResultEvent.final_text). A
    `result` superseded by a resume marker (a dead attempt's) is
    skipped.
    Returns an empty list when the parent has no children yet.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            _LOAD_CHILD_RESULTS_SQL, _coerce_uuid(parent_task_id), _coerce_uuid(user_id)
        )
    selected: list[tuple[asyncpg.Record | None, dict[str, object]]]
    if children is None:
        selected = [(row, {}) for row in rows]
    else:
        by_id = {str(row["id"]): row for row in rows}
        selected = [(by_id.get(str(child.get("id"))), child) for child in children]
    out: list[ChildResult] = []
    for row, named in selected:
        if row is None:
            out.append(
                ChildResult(
                    persona_slug=str(named.get("personaSlug") or ""),
                    subgoal=str(named.get("subgoal") or ""),
                    status="deleted",
                    final_text="",
                )
            )
            continue
        cp = _as_dict(row["checkpoint"])
        # subagent metadata is nested under checkpoint["subagent"]
        meta = _as_dict(cp.get("subagent")) if cp else None
        out.append(
            ChildResult(
                persona_slug=str(meta.get("personaSlug", "")) if meta else "",
                subgoal=str(meta.get("subgoal", "")) if meta else "",
                status=str(row["status"]),
                final_text=_final_text_from_result_rows(row["result_events"]),
            )
        )
    return out


# --- RLS impersonation -----------------------------------------------------
#
# Tools that read user-owned data (`searchFiles` over `files`, MCP cloud-mode
# creds when ported in Phase 3f, etc.) must NOT use the service-role pool's
# default authentication — that would bypass per-user RLS on the underlying
# tables. Supabase's RLS policies key off `auth.uid()` which reads from the
# `request.jwt.claims` GUC.
#
# The pattern:
#   1. Open a transaction on the pool.
#   2. `SET LOCAL ROLE authenticated` — drops from `postgres` / service role
#      to the role RLS policies are written against.
#   3. `SET LOCAL "request.jwt.claims" = '{"sub":"<user_id>","role":"authenticated"}'`
#      — what `auth.uid()` reads. JSON encoded so the GUC carries valid claims.
#   4. Run the actual query / RPC.
#   5. Transaction commits (or rolls back); the SET LOCALs scope-out.
#
# Mirrors how PostgREST (Supabase's REST proxy) impersonates a user for the
# duration of a request. Direct-Postgres callers (this service) do it manually.

_SET_ROLE_SQL = "SET LOCAL ROLE authenticated;"


async def _set_user_context(conn: asyncpg.Connection, *, user_id: str) -> None:
    """Within an open transaction, drop to the `authenticated` role and stamp
    the user's id as the JWT claim so `auth.uid()` returns it. Subsequent
    queries on this connection run under per-user RLS.

    The SET LOCAL settings unwind on transaction end, so callers MUST
    `async with conn.transaction():` around this + the query they care about.
    Caller responsibility — we don't open the transaction here so callers
    can compose multiple queries under the same impersonation.
    """
    await conn.execute(_SET_ROLE_SQL)
    claims = json.dumps({"sub": user_id, "role": "authenticated"})
    # `request.jwt.claims` is the GUC PostgREST + Supabase RLS read. Use
    # `set_config` (not `SET LOCAL` directly) so we can bind the JSON via
    # parameter — `SET` doesn't accept query params.
    await conn.execute(
        "SELECT set_config('request.jwt.claims', $1, true);",
        claims,
    )


# --- searchFiles RPC -------------------------------------------------------


async def search_file_sections(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    file_id: str,
    query: str,
    max_fragments: int = 3,
    max_words: int = 120,
    min_words: int = 30,
) -> list[dict[str, object]]:
    """Call the `search_file_sections` Postgres RPC under the user's auth
    context (RLS on `files` evaluates against `auth.uid()` = `user_id`).

    Returns a list of `{excerpt: str, rank: float}` dicts — one row per
    matching file (the function filters by `p_file_id`, so in practice this
    is always 0 or 1 entries). Empty list = no match OR the file doesn't
    belong to this user (RLS hides the row, same outcome). Tool callers
    distinguish via `rank == 0` for "no FTS hits" vs "no row at all"
    treated the same way.

    Raises on connection / transaction failure; the caller wraps in a
    ToolError so the model sees a clean message instead of a stack trace.
    """
    async with pool.acquire() as conn, conn.transaction():
        await _set_user_context(conn, user_id=user_id)
        rows = await conn.fetch(
            "SELECT excerpt, rank FROM public.search_file_sections($1, $2, $3, $4, $5);",
            _coerce_uuid(file_id),
            query,
            max_fragments,
            max_words,
            min_words,
        )
    return [{"excerpt": r["excerpt"], "rank": float(r["rank"])} for r in rows]
