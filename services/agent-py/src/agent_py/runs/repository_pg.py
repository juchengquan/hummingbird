"""Postgres `RunRepository` over migration 0041 (Q27: a run is a `tasks` row).

Two kinds of access, as `repository.RunRepository` describes:

* **Owner-scoped** (`create`, `get`, `list_runs`, `cancel`, and
  `enqueue_start`) run **as the user**: inside a transaction,
  `store._set_user_context` drops to `authenticated` and stamps the JWT
  claims, so RLS, 0034's column grants and its status guard trigger
  apply exactly as they do for the Next routes. `create` is the
  `create_run` RPC (SECURITY DEFINER, idempotent on the client-minted
  id); its deliberate SQLSTATEs map to the repository's exceptions.
  Every query also filters on `user_id` (defence in depth on top of
  RLS, like `store.py`).
* **System** (`mark_running`, `settle`, `heartbeat`, `reap_expired`,
  `exists`) run as the DSN role, like the workers: users cannot write
  `outcome` / `lease_expires_at` (0034/0041).

`create` of a background run is one transaction: the row, its `status:
queued` entry and its `start` job — a refused enqueue leaves no queued
orphan and holds no resume slot. `cancel` is the `cancel_task` RPC
(0045), the one the Next route calls: for a background run the whole
task (Q60), an interactive run alone.

**Rows without an `outcome`** (written before 0041, or a background
settle before the worker wrote one): a `done` / `failed` row's result
and error, and the open interrupts of a `paused` row that is not waiting
on its sub-agents, are rebuilt from its log (`result` and `approval`
entries) per RUN_EVENTS.md §§ 1 and 5 — one query for a whole page: a
paused one waits on its newest unanswered request only, which
supersedes any a dead attempt left (`private.task_waits_on`, the same
rule). A row with an `outcome`, and a parent waiting on its sub-agents,
never read their log. The `status` filter of `list_runs` approximates
that rebuild in SQL: a `paused` row without an outcome that is not
waiting on sub-agents counts as `interrupted`.

**Reading is cheap** (wave 6, survey bugs 8, 9; Q66): one statement per
row read or list page — `_RUN_COLUMNS` carries the task fields (0047's current run,
the root's delivery mark,
the children asking, a pending `respond` job) and the log's last `seq`,
each an index lookup; "waiting on sub-agents" is 0048's
`tasks.awaiting_children`, never `checkpoint ? …`, and "current" is
0048's `task_run_is_current_by` / `task_current_run_id_by` over columns,
never 0047's row-typed functions: either would fetch the whole TOASTed
checkpoint.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, NoReturn, cast

import asyncpg
import structlog

from .. import events, store
from ..events import ApprovalEvent, ResultEvent
from .in_place import answer_problem, respond_job_payload
from .model import (
    ContractStatus,
    Failed,
    InternalStatus,
    Interrupted,
    PendingInterrupt,
    RunOutcome,
    RunOwner,
    RunRecord,
    Succeeded,
    outcome_from_json,
    outcome_to_json,
)
from .repository import (
    DEFAULT_LEASE_SECONDS,
    AnswerInvalid,
    CreateResult,
    InvalidPageToken,
    PreviousRunAlreadyAnswered,
    PreviousRunAlreadyResumed,
    PreviousRunAnswerApplied,
    PreviousRunNotFound,
    PreviousRunNotWaiting,
    QuestionAlreadyAnswered,
    RunFilter,
    RunIdConflict,
    RunNotAnswerable,
    RunNotDeliverable,
    RunPage,
    RunSpec,
    ThreadNotFound,
    _decode_token,
    _encode_token,
)

__all__ = ["JOB_QUEUE_FULL_MESSAGE", "TASK_CAP_MESSAGE", "PgRunRepository", "RunWriteError"]

logger = structlog.get_logger(__name__)

_ACQUIRE_TIMEOUT_S = 10.0

WORKER_LOST_MESSAGE = "The run's process stopped unexpectedly."
NO_WORKER_MESSAGE = "No task worker available."

TASK_CAP_MESSAGE = "5 tasks are already active. Finish or cancel one, then start this one again."
"""`startRun`'s `409 limit_reached` at the task cap (Q72, Q79: 0047's
`create_run` raises 54000)."""

JOB_QUEUE_FULL_MESSAGE = (
    "Too many queued jobs (20 per user). Wait for some to start, then try again."
)
"""`409 limit_reached` when `enqueue_task_job` refuses a job past 20
queued for the user (54000, 0034)."""


class RunWriteError(Exception):
    """A deliberate refusal from an owner-scoped write (`enqueue_task_job`,
    0034): carries the SQLSTATE and the API `(status, code)` it maps to,
    as `lib/server/agent/task-writes.ts`'s `SQLSTATE_RESPONSES` does."""

    def __init__(self, sqlstate: str | None, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.status = status
        self.code = code
        self.message = message


_SQLSTATE_RESPONSES: dict[str, tuple[int, str]] = {
    "42501": (403, "forbidden"),
    "P0002": (404, "not_found"),
    "22023": (400, "invalid_request"),
    "55000": (409, "invalid_state"),
    "54000": (409, "limit_reached"),
}

# A paused child asking a question (RUN_EVENTS.md § 1), as `c`, that no
# accepted answer holds yet: a queued or running `respond` job for it
# means the question is answered ("answer sent"), so it doesn't count.
_CHILD_ASKS_SQL = (
    "c.status = 'paused' AND (COALESCE(c.outcome->>'type' = 'interrupt', false) "
    "OR (c.outcome IS NULL AND NOT c.awaiting_children)) "
    "AND NOT EXISTS (SELECT 1 FROM public.task_jobs cj WHERE cj.task_id = c.id "
    "AND cj.action = 'respond' AND cj.status IN ('queued', 'running'))"
)

# 0047's "current run" by columns (0048): passing the row `t` to
# `task_run_is_current(t)` would make Postgres fetch its checkpoint.
_IS_CURRENT_SQL = (
    "public.task_run_is_current_by(t.id, t.user_id, t.previous_run_id, t.status, "
    "t.answers_applied_at)"
)
_CURRENT_RUN_ID_SQL = (
    "public.task_current_run_id_by(t.id, t.user_id, t.parent_task_id, t.root_run_id)"
)

# The task's root carries the delivery mark (0047, Q77).
_DELIVERED_SQL = (
    "EXISTS (SELECT 1 FROM public.tasks r WHERE r.id = COALESCE(t.root_run_id, t.id) "
    "AND r.user_id = t.user_id AND r.result_delivered_at IS NOT NULL)"
)

# Every column a run read needs, in one statement (no checkpoint, no
# per-row query). `awaiting_children` is 0048's generated column. The last
# seq is `ORDER BY … LIMIT 1`, not `MAX`: under RLS the planner may answer
# a correlated `MAX` by reading every entry of the task.
_RUN_COLUMNS = f"""
  t.id, t.user_id, t.thread_id, t.mode, t.status, t.created_at, t.updated_at,
  t.started_at, t.finished_at, t.parent_task_id, t.previous_run_id, t.goal,
  t.max_steps, t.step,
  t.outcome::text AS outcome, t.lease_expires_at,
  t.awaiting_children,
  t.root_run_id, t.research,
  CASE WHEN {_IS_CURRENT_SQL} THEN NULL ELSE {_CURRENT_RUN_ID_SQL} END AS current_run_id,
  {_DELIVERED_SQL} AS delivered,
  (SELECT count(*) FROM public.tasks c
    WHERE c.parent_task_id = t.id AND c.user_id = t.user_id
      AND {_CHILD_ASKS_SQL})::integer AS children_asking,
  (t.status = 'paused' AND EXISTS (
    SELECT 1 FROM public.task_jobs j
     WHERE j.task_id = t.id AND j.action = 'respond'
       AND j.status IN ('queued', 'running'))) AS answer_pending,
  COALESCE((SELECT e.seq FROM public.task_events e
             WHERE e.task_id = t.id ORDER BY e.seq DESC LIMIT 1), 0) AS last_seq
"""

_LIVE = ("queued", "running")

# 0045's `question_held_by_respond`, for any of these questions.
_RESPOND_HELD_SQL = (
    "SELECT EXISTS (SELECT 1 FROM public.task_jobs j WHERE j.task_id = $1 "
    "AND j.action = 'respond' AND j.status IN ('queued', 'running') "
    "AND j.payload->>'requestId' = ANY($2::text[]))"
)


def _question_ids(resume: Sequence[Mapping[str, object]]) -> list[str]:
    return [str(e.get("interruptId")) for e in resume if isinstance(e.get("interruptId"), str)]


_ONE_LIVE_RESUME = "tasks_one_live_resume"
"""0042's unique index: one live resume per interrupted run."""

_ANSWER_APPLIED = "tasks_answer_applied"
"""0046's `create_run` refusal (Q63): an interactive resume of this run
applied its answers and then ended."""

# A row the contract calls `interrupted` (RUN_EVENTS.md § 1), in SQL.
# NULL-safe: a paused row with no outcome must read false, not NULL, for
# `NOT` (the `running` filter) to list a parent waiting on sub-agents.
_INTERRUPTED_SQL = (
    "(t.status = 'paused' AND (COALESCE(t.outcome->>'type' = 'interrupt', false) "
    "OR (t.outcome IS NULL AND NOT t.awaiting_children)))"
)
_STATUS_SQL: dict[ContractStatus, str] = {
    "queued": "t.status = 'queued'",
    "running": f"(t.status = 'running' OR (t.status = 'paused' AND NOT {_INTERRUPTED_SQL}))",
    "interrupted": _INTERRUPTED_SQL,
    "succeeded": "t.status = 'done'",
    "failed": "t.status = 'failed'",
    "cancelled": "t.status = 'cancelled'",
}


def _uuid(value: str) -> uuid.UUID:
    return uuid.UUID(value)


def _json_obj(raw: object) -> dict[str, object] | None:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    return raw if isinstance(raw, dict) else None


def _sqlstate(exc: BaseException) -> str | None:
    state = getattr(exc, "sqlstate", None)
    return state if isinstance(state, str) else None


def _raise_write_error(exc: asyncpg.PostgresError, *, limit_message: str | None = None) -> NoReturn:
    """Map a deliberate refusal; `limit_message` replaces the database's
    text for 54000 (which cap it was depends on the call)."""
    state = _sqlstate(exc)
    mapped = _SQLSTATE_RESPONSES.get(state or "")
    if mapped is None:
        raise exc
    message = str(getattr(exc, "message", "") or exc) or "Request rejected."
    if state == "54000" and limit_message is not None:
        message = limit_message
    raise RunWriteError(state, mapped[0], mapped[1], message) from None


def _status_for(outcome: RunOutcome) -> InternalStatus:
    if isinstance(outcome, Succeeded):
        return "done"
    if isinstance(outcome, Failed):
        return "failed"
    if isinstance(outcome, Interrupted):
        return "paused"
    return "cancelled"


class _LogFallback:
    """What a pre-0041 row's log says about its end (RUN_EVENTS.md §§ 1, 5)."""

    def __init__(self) -> None:
        self.result: ResultEvent | None = None
        self.requests: dict[str, ApprovalEvent] = {}

    def add(self, event: events.TaskEvent) -> None:
        if isinstance(event, ResultEvent):
            self.result = event
        elif isinstance(event, ApprovalEvent):
            self.requests.pop(event.approval_id, None)
            if event.phase == "request":
                self.requests[event.approval_id] = event

    def open_interrupts(self) -> tuple[dict[str, object], ...]:
        # The executor asks one question at a time: only the newest is live.
        if not self.requests:
            return ()
        newest = list(self.requests.values())[-1]
        return (PendingInterrupt.from_approval(newest).to_agui(),)


class PgRunRepository:
    """`RunRepository` over the `tasks` table (0041). Signed-in owners
    only: an anonymous owner owns nothing here."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    # -- connections --

    @asynccontextmanager
    async def _as_user(self, user_id: str) -> AsyncIterator[asyncpg.Connection]:
        async with (
            self._pool.acquire(timeout=_ACQUIRE_TIMEOUT_S) as conn,
            conn.transaction(),
        ):
            await store._set_user_context(conn, user_id=user_id)
            yield conn

    @asynccontextmanager
    async def _as_system(self) -> AsyncIterator[asyncpg.Connection]:
        async with self._pool.acquire(timeout=_ACQUIRE_TIMEOUT_S) as conn:
            yield conn

    # -- row → record --

    async def _records(
        self, conn: asyncpg.Connection, rows: Sequence[asyncpg.Record]
    ) -> list[RunRecord]:
        """Rows → records, rebuilding pre-0041 rows' ends from their logs
        (one query for the whole batch)."""
        needs_log = [
            r["id"]
            for r in rows
            if r["outcome"] is None
            and (
                r["status"] in ("done", "failed")
                or (r["status"] == "paused" and not r["awaiting_children"])
            )
        ]
        fallbacks: dict[str, _LogFallback] = {}
        if needs_log:
            log_rows = await conn.fetch(
                "SELECT e.task_id, e.seq, e.step, e.kind, e.payload::text AS payload, "
                "e.created_at FROM public.task_events e "
                "WHERE e.task_id = ANY($1::uuid[]) AND e.kind IN ('result', 'approval') "
                "ORDER BY e.task_id, e.seq",
                needs_log,
            )
            for lr in log_rows:
                payload = _json_obj(lr["payload"])
                if payload is None:
                    continue
                created = lr["created_at"]
                ev = store.event_from_row_payload(
                    seq=lr["seq"],
                    step=lr["step"],
                    kind=lr["kind"],
                    created_at=created.isoformat() if hasattr(created, "isoformat") else "",
                    payload=payload,
                )
                if ev is not None:
                    fallbacks.setdefault(str(lr["task_id"]), _LogFallback()).add(ev)
        return [_record(r, fallbacks.get(str(r["id"]))) for r in rows]

    async def _load(self, conn: asyncpg.Connection, run_id: str, user_id: str) -> RunRecord | None:
        row = await conn.fetchrow(
            f"SELECT {_RUN_COLUMNS} FROM public.tasks t WHERE t.id = $1 AND t.user_id = $2",
            _uuid(run_id),
            _uuid(user_id),
        )
        if row is None:
            return None
        return (await self._records(conn, [row]))[0]

    # -- owner-scoped --

    async def create(self, owner: RunOwner, spec: RunSpec) -> CreateResult:
        if owner.user_id is None:
            raise ValueError("anonymous runs are not stored in Postgres")
        lease = None if spec.lease_seconds is None else round(spec.lease_seconds)
        try:
            async with self._as_user(owner.user_id) as conn:
                row = await conn.fetchrow(
                    "SELECT id, status, created FROM public.create_run("
                    "$1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
                    _uuid(spec.run_id),
                    _uuid(spec.thread_id),
                    spec.mode,
                    spec.goal,
                    None if spec.previous_run_id is None else _uuid(spec.previous_run_id),
                    spec.max_steps,
                    None if spec.checkpoint is None else json.dumps(spec.checkpoint),
                    lease,
                )
                if spec.mode == "background" and row is not None and row["created"]:
                    await self._queue(conn, spec.run_id, owner.user_id)
                record = await self._load(conn, spec.run_id, owner.user_id)
        except asyncpg.PostgresError as exc:
            state = _sqlstate(exc)
            message = str(getattr(exc, "message", "") or exc)
            if state == "23505":
                constraint = getattr(exc, "constraint_name", None)
                if constraint == _ONE_LIVE_RESUME:
                    raise PreviousRunAlreadyResumed() from None
                if constraint == _ANSWER_APPLIED:
                    raise PreviousRunAnswerApplied() from None
                raise RunIdConflict() from None
            if state == "P0002":
                if "previous" in message:
                    raise PreviousRunNotFound() from None
                raise ThreadNotFound() from None
            if state == "22023":
                raise ValueError(message) from None
            if state == "54000":
                # 0047 (Q79): a sixth active task — `409 limit_reached`,
                # nothing created.
                _raise_write_error(exc, limit_message=TASK_CAP_MESSAGE)
            if state == "55000":
                if "already answered" in message:
                    # 0045: a `respond` job holds one of the questions.
                    raise PreviousRunAlreadyAnswered() from None
                if "previous run" in message:
                    raise PreviousRunNotWaiting(message) from None
            raise
        if row is None or record is None:  # pragma: no cover — the RPC always answers
            raise RuntimeError("create_run returned no row")
        return CreateResult(record, created=bool(row["created"]))

    async def _queue(self, conn: asyncpg.Connection, run_id: str, user_id: str) -> None:
        """What the Next task route does after `create_task_run`, inside
        the create's transaction: `status: queued` as seq 1 (as the user,
        like the route; the worker continues at seq 2), then the `start`
        job. A refusal (`RunWriteError`) rolls the run back with it."""
        await conn.execute(
            "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
            "VALUES ($1, $2, 1, 0, 'status', '{\"status\": \"queued\"}'::jsonb)",
            _uuid(run_id),
            _uuid(user_id),
        )
        try:
            await conn.fetchval(
                "SELECT public.enqueue_task_job($1, 'start', '{}'::jsonb)", _uuid(run_id)
            )
        except asyncpg.PostgresError as exc:
            _raise_write_error(exc, limit_message=JOB_QUEUE_FULL_MESSAGE)

    async def get(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        if owner.user_id is None:
            return None
        async with self._as_user(owner.user_id) as conn:
            return await self._load(conn, run_id, owner.user_id)

    async def list_runs(
        self,
        owner: RunOwner,
        filt: RunFilter,
        *,
        page_size: int = 20,
        page_token: str | None = None,
    ) -> RunPage:
        if not 1 <= page_size <= 100:
            raise ValueError("page_size must be between 1 and 100")
        after: tuple[datetime, str] | None = None
        if page_token is not None:
            created_raw, last_id = _decode_token(page_token, filt.fingerprint())
            try:
                after = (datetime.fromisoformat(created_raw), str(uuid.UUID(last_id)))
            except ValueError as exc:
                raise InvalidPageToken() from exc
        if owner.user_id is None:
            return RunPage((), None)

        where = ["t.user_id = $1"]
        args: list[Any] = [_uuid(owner.user_id)]

        def param(value: object) -> str:
            args.append(value)
            return f"${len(args)}"

        if filt.thread_id is not None:
            where.append(f"t.thread_id = {param(_uuid(filt.thread_id))}")
        if filt.parent_run_id is not None:
            where.append(f"t.parent_task_id = {param(_uuid(filt.parent_run_id))}")
        if filt.mode is not None:
            where.append(f"t.mode = {param(filt.mode)}")
        if filt.statuses:
            where.append("(" + " OR ".join(_STATUS_SQL[s] for s in sorted(filt.statuses)) + ")")
        # Task filters (0.5.0): None filters nothing, False the other set.
        if filt.top_level is not None:
            where.append(f"t.parent_task_id IS {'' if filt.top_level else 'NOT '}NULL")
        if filt.current is not None:
            where.append(f"{'' if filt.current else 'NOT '}{_IS_CURRENT_SQL}")
        if filt.root_run_id is not None:
            where.append(f"t.root_run_id = {param(_uuid(filt.root_run_id))}")
        if filt.delivered is not None:
            where.append(f"{'' if filt.delivered else 'NOT '}{_DELIVERED_SQL}")
        if after is not None:
            created_p = param(after[0])
            id_p = param(_uuid(after[1]))
            where.append(f"(t.created_at, t.id) < ({created_p}::timestamptz, {id_p}::uuid)")
        limit_p = param(page_size + 1)
        sql = (
            f"SELECT {_RUN_COLUMNS} FROM public.tasks t WHERE {' AND '.join(where)} "
            f"ORDER BY t.created_at DESC, t.id DESC LIMIT {limit_p}"
        )
        async with self._as_user(owner.user_id) as conn:
            rows = await conn.fetch(sql, *args)
            records = await self._records(conn, rows[:page_size])
        token = None
        if len(rows) > page_size:
            last = records[-1]
            token = _encode_token((last.created_at.isoformat(), last.id), filt.fingerprint())
        return RunPage(tuple(records), token)

    async def cancel(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        if owner.user_id is None:
            return None
        try:
            async with self._as_user(owner.user_id) as conn:
                await conn.execute("SELECT public.cancel_task($1)", _uuid(run_id))
                return await self._load(conn, run_id, owner.user_id)
        except asyncpg.PostgresError as exc:
            if _sqlstate(exc) == "P0002":
                return None
            raise

    async def answer_in_place(
        self, owner: RunOwner, run_id: str, resume: Sequence[Mapping[str, object]]
    ) -> RunRecord | None:
        """One transaction as the user: read the run, check it is a
        sub-agent run waiting on exactly these questions with answers that
        fit (`in_place.answer_problem`), then one `respond` job per entry
        through `enqueue_task_job` (0045: under the user's task lock it
        re-checks that the run waits on the question and that no answer
        holds it, and the 20-queued-jobs cap) — all or none. Its 55000s
        map to `QuestionAlreadyAnswered` (an answer holds the question)
        or `RunNotAnswerable` (not waiting on it: cancelled, ended, moved
        on), 54000 to `RunWriteError` `limit_reached`."""
        if owner.user_id is None:
            return None
        try:
            async with self._as_user(owner.user_id) as conn:
                run = await self._load(conn, run_id, owner.user_id)
                if run is None:
                    return None
                if run.parent_run_id is None:
                    raise RunNotAnswerable(
                        "A top-level run is answered by a new run: startRun with previousRunId."
                    )
                if run.status != "interrupted":
                    # A worker already picked up an answer to it (the run
                    # is `running` while it applies it): answered, not gone.
                    if await conn.fetchval(_RESPOND_HELD_SQL, _uuid(run_id), _question_ids(resume)):
                        raise QuestionAlreadyAnswered()
                    raise RunNotAnswerable(f"The run is {run.status}, not waiting on a question.")
                problem = answer_problem(run.open_interrupts, resume)
                if problem is not None:
                    raise AnswerInvalid(problem)
                for entry in resume:
                    await conn.fetchval(
                        "SELECT public.enqueue_task_job($1, 'respond', $2::jsonb)",
                        _uuid(run_id),
                        json.dumps(respond_job_payload(entry)),
                    )
                return await self._load(conn, run_id, owner.user_id)
        except asyncpg.PostgresError as exc:
            state = _sqlstate(exc)
            message = str(getattr(exc, "message", "") or exc)
            if state == "P0002":
                return None
            if state == "55000":
                if "already answered" in message:
                    raise QuestionAlreadyAnswered() from None
                raise RunNotAnswerable("The run is no longer waiting on that question.") from None
            if state == "22023":
                raise AnswerInvalid(message) from None
            _raise_write_error(exc, limit_message=JOB_QUEUE_FULL_MESSAGE)

    async def mark_delivered(self, owner: RunOwner, run_id: str) -> RunRecord | None:
        """`public.mark_task_delivered` as the user (0047): it checks the
        owner on the database's own `auth.uid()`, that the run is a task's
        root and its current run ended, and keeps the first mark.
        P0002 → None, 55000 → `RunNotDeliverable`."""
        if owner.user_id is None:
            return None
        try:
            async with self._as_user(owner.user_id) as conn:
                await conn.fetchval("SELECT public.mark_task_delivered($1)", _uuid(run_id))
                return await self._load(conn, run_id, owner.user_id)
        except asyncpg.PostgresError as exc:
            state = _sqlstate(exc)
            if state == "P0002":
                return None
            if state == "55000":
                message = str(getattr(exc, "message", "") or exc)
                if "not ended" in message:
                    raise RunNotDeliverable("The task has not ended.") from None
                raise RunNotDeliverable(
                    "Not a task's root run: mark its rootRunId (background runs only)."
                ) from None
            raise

    async def enqueue_start(self, owner: RunOwner, run_id: str) -> None:
        """Enqueue a background run's `start` job as the user
        (`enqueue_task_job`, 0034) — what the Next task route does after
        appending `status: queued`. Raises `RunWriteError` for the RPC's
        deliberate refusals (55000 when the run is not `queued` or already
        has its `start` job; 54000 past 20 queued jobs)."""
        if owner.user_id is None:
            raise ValueError("anonymous runs have no jobs")
        try:
            async with self._as_user(owner.user_id) as conn:
                await conn.fetchval(
                    "SELECT public.enqueue_task_job($1, 'start', '{}'::jsonb)", _uuid(run_id)
                )
        except asyncpg.PostgresError as exc:
            _raise_write_error(exc, limit_message=JOB_QUEUE_FULL_MESSAGE)

    # -- system --

    async def exists(self, run_id: str) -> bool:
        """Whether any row has this id (anyone's) — run ids are global."""
        async with self._as_system() as conn:
            found = await conn.fetchval("SELECT 1 FROM public.tasks WHERE id = $1", _uuid(run_id))
        return found is not None

    async def mark_running(self, run_id: str) -> bool:
        async with self._as_system() as conn:
            row = await conn.fetchrow(
                "UPDATE public.tasks SET status = 'running', updated_at = now() "
                "WHERE id = $1 AND status = 'queued' RETURNING id",
                _uuid(run_id),
            )
        return row is not None

    async def mark_answers_applied(self, run_id: str) -> bool:
        """0046: the column the background executor writes (0045), for a
        live interactive run, as the DSN role — under the user's task lock
        (`private.lock_user_tasks`, 0045's lock order), which `create_run`
        holds while it checks a second resume: the stamp can't land
        between that check and its insert."""
        async with self._as_system() as conn, conn.transaction():
            user_id = await conn.fetchval(
                "SELECT user_id FROM public.tasks WHERE id = $1", _uuid(run_id)
            )
            if user_id is None:
                return False
            await conn.execute("SELECT private.lock_user_tasks($1)", user_id)
            row = await conn.fetchrow(
                "UPDATE public.tasks "
                "SET answers_applied_at = COALESCE(answers_applied_at, now()), updated_at = now() "
                "WHERE id = $1 AND mode = 'interactive' AND status IN ('queued', 'running') "
                "RETURNING id",
                _uuid(run_id),
            )
        return row is not None

    async def settle(
        self,
        run_id: str,
        outcome: RunOutcome,
        *,
        checkpoint: dict[str, object] | None = None,
    ) -> bool:
        async with self._as_system() as conn:
            row = await conn.fetchrow(
                "UPDATE public.tasks SET status = $2, outcome = $3::jsonb, "
                "checkpoint = COALESCE($4::jsonb, checkpoint), "
                "finished_at = now(), updated_at = now(), lease_expires_at = NULL "
                "WHERE id = $1 AND status IN ('queued', 'running') RETURNING id",
                _uuid(run_id),
                _status_for(outcome),
                json.dumps(outcome_to_json(outcome)),
                None if checkpoint is None else json.dumps(checkpoint),
            )
        return row is not None

    async def load_checkpoint(self, owner: RunOwner, run_id: str) -> dict[str, object] | None:
        """Read as the owner (RLS), like `get`."""
        if owner.user_id is None:
            return None
        async with self._as_user(owner.user_id) as conn:
            raw = await conn.fetchval(
                "SELECT t.checkpoint::text FROM public.tasks t WHERE t.id = $1 AND t.user_id = $2",
                _uuid(run_id),
                _uuid(owner.user_id),
            )
        return _json_obj(raw)

    async def heartbeat(self, run_id: str, *, lease_seconds: float = DEFAULT_LEASE_SECONDS) -> bool:
        async with self._as_system() as conn:
            row = await conn.fetchrow(
                "UPDATE public.tasks SET lease_expires_at = now() + make_interval(secs => $2) "
                "WHERE id = $1 AND mode = 'interactive' AND status IN ('queued', 'running') "
                "RETURNING id",
                _uuid(run_id),
                float(lease_seconds),
            )
        return row is not None

    async def reap_expired(self, *, limit: int = 50) -> list[RunRecord]:
        outcome = json.dumps(outcome_to_json(Failed("worker_lost", WORKER_LOST_MESSAGE)))
        async with self._as_system() as conn, conn.transaction():
            rows = await conn.fetch(
                f"""
                UPDATE public.tasks t
                   SET status = 'failed', outcome = $2::jsonb, finished_at = now(),
                       updated_at = now(), lease_expires_at = NULL
                 WHERE t.id IN (
                   SELECT x.id FROM public.tasks x
                    WHERE x.mode = 'interactive' AND x.status IN ('queued', 'running')
                      AND x.lease_expires_at < now()
                    ORDER BY x.lease_expires_at
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED)
                RETURNING {_RUN_COLUMNS}
                """,
                limit,
                outcome,
            )
            return await self._records(conn, rows)


def _record(row: asyncpg.Record, fallback: _LogFallback | None) -> RunRecord:
    status = cast("InternalStatus", row["status"])
    mode = row["mode"]
    open_interrupts: tuple[dict[str, object], ...] = ()
    result: dict[str, object] | None = None
    error: dict[str, object] | None = None
    parsed = outcome_from_json(_json_obj(row["outcome"]))
    if parsed is not None:
        kind, body = parsed
        if kind == "interrupt":
            raw = body.get("interrupts")
            if isinstance(raw, list):
                open_interrupts = tuple(i for i in raw if isinstance(i, dict))
        elif kind == "success":
            res = body.get("result")
            result = res if isinstance(res, dict) else {}
        elif kind == "error":
            error = {
                "code": str(body.get("code") or "unknown"),
                "message": str(body.get("message") or "Run failed."),
            }
    elif status == "done":
        result = {}
        if fallback is not None and fallback.result is not None:
            if fallback.result.final_text is not None:
                result["text"] = fallback.result.final_text
            if fallback.result.memory_tainted:
                result["memoryTainted"] = True
    elif status == "failed":
        res_ev = fallback.result if fallback is not None else None
        if res_ev is not None and (res_ev.error is not None or res_ev.error_code is not None):
            error = {
                "code": res_ev.error_code or "unknown",
                "message": res_ev.error or "Run failed.",
            }
        elif mode == "interactive":
            error = {"code": "worker_lost", "message": WORKER_LOST_MESSAGE}
        else:
            error = {"code": "no_worker", "message": NO_WORKER_MESSAGE}
    elif status == "paused" and not row["awaiting_children"] and fallback is not None:
        open_interrupts = fallback.open_interrupts()

    parent = row["parent_task_id"]
    previous = row["previous_run_id"]
    root = row["root_run_id"]
    return RunRecord(
        id=str(row["id"]),
        owner=RunOwner.user(str(row["user_id"])),
        thread_id=str(row["thread_id"]),
        mode=mode,
        internal_status=status,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        parent_run_id=None if parent is None else str(parent),
        previous_run_id=None if previous is None else str(previous),
        goal=row["goal"],
        max_steps=row["max_steps"],
        step=row["step"],
        open_interrupts=open_interrupts,
        result=result,
        error=error,
        lease_expires_at=row["lease_expires_at"],
        root_run_id=None if root is None else str(root),
        research=bool(row["research"]),
        current_run_id=None if row["current_run_id"] is None else str(row["current_run_id"]),
        delivered=bool(row["delivered"]),
        children_asking=int(row["children_asking"] or 0),
        answer_pending=bool(row["answer_pending"]),
        last_seq=int(row["last_seq"] or 0),
    )
