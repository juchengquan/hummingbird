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
from typing import Literal, cast

import asyncpg
import structlog

from . import events
from .events import TaskEvent, event_to_row_payload


async def update_run(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    status: str | None = None,
    step: int | None = None,
    finished: bool = False,
) -> None:
    """Patch a `tasks` row. Only the fields explicitly passed get
    written — partial updates are intentional so the executor can
    bump just `step` between steps without touching status."""
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
        f"WHERE id = ${len(args) - 1} AND user_id = ${len(args)};"
    )
    async with pool.acquire() as conn:
        await conn.execute(sql, *args)


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
    payload = event_to_row_payload(event)
    async with pool.acquire() as conn:
        await conn.execute(
            _APPEND_EVENT_SQL,
            _coerce_uuid(event.run_id),
            _coerce_uuid(user_id),
            event.seq,
            event.step,
            event.kind,
            json.dumps(payload),
        )


_log = structlog.get_logger(__name__)

_VALID_KINDS: frozenset[str] = frozenset(
    {
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
    }
)


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
            options=cast(
                "list[events.InputRequestOption] | None",
                merged.get("options") if isinstance(merged.get("options"), list) else None,
            ),
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
    # Unhandled kinds in this build; the row was preserved but not
    # parsed. Caller should skip + warn.
    _log.warning("store.unhandled_event_kind", kind=kind)
    return None


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
    async with pool.acquire() as conn:
        await _set_user_context(conn, user_id=user_id)
        rows = await conn.fetch(
            "SELECT seq, step, kind, payload::text AS payload, created_at "
            "FROM public.task_events WHERE task_id = $1 ORDER BY seq",
            run_id,
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
    without instrumenting the worker code paths."""
    async with pool.acquire() as conn:
        await conn.execute(
            _SET_HANDLER_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
            handler,
        )


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
    """Cheap status probe the runner polls between steps. A probe
    failure (DB blip, RLS reject) returns False — the run keeps
    going. The TS path makes the same call."""
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                _IS_CANCELLED_SQL,
                _coerce_uuid(run_id),
                _coerce_uuid(user_id),
            )
    except Exception:
        return False
    return bool(row and row["status"] == "cancelled")


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
WHERE id = $1 AND user_id = $2;
"""


async def save_checkpoint(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    checkpoint: dict[str, object],
) -> None:
    """Overwrite the `tasks.checkpoint` jsonb column with the executor's
    current state. Phase 3a uses this on the chunk-break path
    (`AgentLoopResult.kind == "yielded"`): we persist `messages` +
    `step` + `seq` + the same `config` we loaded, then enqueue a
    `continue` job that picks up from here.

    Same shape as `RunCheckpoint` in `lib/server/agent/checkpoint.ts`
    so a Python-written checkpoint is loadable by the TS worker
    (defence in depth — flag flip should never strand a run mid-loop)."""
    async with pool.acquire() as conn:
        await conn.execute(
            _SAVE_CHECKPOINT_SQL,
            _coerce_uuid(run_id),
            _coerce_uuid(user_id),
            json.dumps(checkpoint),
        )


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
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            _CREATE_CHILD_TASK_SQL,
            _coerce_uuid(user_id),
            _coerce_uuid(conversation_id),
            goal,
            _coerce_uuid(parent_task_id),
            json.dumps(checkpoint),
        )
    return str(row["id"])


_SET_PENDING_CHILDREN_SQL = (
    "UPDATE public.tasks SET pending_children = $2, updated_at = now() WHERE id = $1;"
)


async def set_pending_children(pool: asyncpg.Pool, *, task_id: str, user_id: str, n: int) -> None:
    """Set the barrier counter on the parent task.

    `pending_children` starts at `n` and each child decrements it on
    completion. When it hits 0 the orchestrator fan-in step fires."""
    async with pool.acquire() as conn:
        await conn.execute(_SET_PENDING_CHILDREN_SQL, _coerce_uuid(task_id), n)


@dataclass(frozen=True)
class ChildResult:
    """One child task's settled outcome for fan-in aggregation."""

    persona_slug: str
    subgoal: str
    status: str
    final_text: str


_LOAD_CHILD_RESULTS_SQL = """
SELECT t.id, t.status, t.checkpoint,
  (SELECT e.payload FROM public.task_events e
     WHERE e.task_id = t.id AND e.kind = 'result'
     ORDER BY e.seq DESC LIMIT 1) AS result_payload
FROM public.tasks t
WHERE t.parent_task_id = $1
ORDER BY t.created_at ASC;
"""


async def load_child_results(
    pool: asyncpg.Pool, *, parent_task_id: str, user_id: str
) -> list[ChildResult]:
    """Read all child tasks for a parent and map them to ChildResult.

    Reads the subagent metadata (personaSlug / subgoal) from each
    child's `tasks.checkpoint.subagent` jsonb key, and the final text
    from the child's terminal `result` event payload under the
    `finalText` key (camelCase — mirrors the wire format written by
    `events.event_to_row_payload` for ResultEvent.final_text).
    Returns an empty list when the parent has no children yet.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(_LOAD_CHILD_RESULTS_SQL, _coerce_uuid(parent_task_id))
    out: list[ChildResult] = []
    for row in rows:
        cp = _as_dict(row["checkpoint"])
        # subagent metadata is nested under checkpoint["subagent"]
        meta = _as_dict(cp.get("subagent")) if cp else None
        # result_payload is the jsonb from task_events for kind='result'
        # Its shape is written by event_to_row_payload(ResultEvent):
        #   {"status": ..., "finalText": <str>}  (camelCase wire key)
        payload = _as_dict(row["result_payload"])
        out.append(
            ChildResult(
                persona_slug=str(meta.get("personaSlug", "")) if meta else "",
                subgoal=str(meta.get("subgoal", "")) if meta else "",
                status=str(row["status"]),
                final_text=str(payload.get("finalText", "")) if payload else "",
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
