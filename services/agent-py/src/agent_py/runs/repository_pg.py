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

`cancel` does both in one transaction: the status flip (and 0034's
child cascade, as the Next cancel route does) as the user — the guard
trigger allows exactly live → `cancelled` — then `RESET ROLE` and the
`outcome` / lease columns as the DSN role.

**Rows written before 0041** (no `outcome`): a `done` / `failed` /
`paused` row's result, error and open interrupts are rebuilt from its
log (`result` and `approval` entries) per RUN_EVENTS.md §§ 1 and 5. The
`status` filter of `list_runs` approximates that rebuild in SQL: a
pre-0041 `paused` row that is not waiting on sub-agents
(`checkpoint.awaiting_children`) counts as `interrupted`.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, cast

import asyncpg
import structlog

from .. import events, store
from ..events import ApprovalEvent, ResultEvent
from .model import (
    Cancelled,
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
    CreateResult,
    InvalidPageToken,
    PreviousRunNotFound,
    RunFilter,
    RunIdConflict,
    RunPage,
    RunSpec,
    ThreadNotFound,
    _decode_token,
    _encode_token,
)

__all__ = ["PgRunRepository", "RunWriteError"]

logger = structlog.get_logger(__name__)

_ACQUIRE_TIMEOUT_S = 10.0

WORKER_LOST_MESSAGE = "The run's process stopped unexpectedly."
NO_WORKER_MESSAGE = "No task worker available."


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

_RUN_COLUMNS = """
  t.id, t.user_id, t.thread_id, t.mode, t.status, t.created_at, t.updated_at,
  t.started_at, t.finished_at, t.parent_task_id, t.previous_run_id, t.goal,
  t.outcome::text AS outcome, t.lease_expires_at,
  COALESCE(t.checkpoint ? 'awaiting_children', false) AS awaiting_children
"""

_LIVE = ("queued", "running")

# A row the contract calls `interrupted` (RUN_EVENTS.md § 1), in SQL.
_INTERRUPTED_SQL = (
    "(t.status = 'paused' AND (t.outcome->>'type' = 'interrupt' "
    "OR (t.outcome IS NULL AND NOT COALESCE(t.checkpoint ? 'awaiting_children', false))))"
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
        self.answered: set[str] = set()

    def add(self, event: events.TaskEvent) -> None:
        if isinstance(event, ResultEvent):
            self.result = event
        elif isinstance(event, ApprovalEvent):
            if event.phase == "request":
                self.requests[event.approval_id] = event
            else:
                self.answered.add(event.approval_id)

    def open_interrupts(self) -> tuple[dict[str, object], ...]:
        return tuple(
            PendingInterrupt.from_approval(ev).to_agui()
            for approval_id, ev in self.requests.items()
            if approval_id not in self.answered
        )


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
            if r["outcome"] is None and r["status"] in ("done", "failed", "paused")
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
                record = await self._load(conn, spec.run_id, owner.user_id)
        except asyncpg.PostgresError as exc:
            state = _sqlstate(exc)
            message = str(getattr(exc, "message", "") or exc)
            if state == "23505":
                raise RunIdConflict() from None
            if state == "P0002":
                if "previous" in message:
                    raise PreviousRunNotFound() from None
                raise ThreadNotFound() from None
            if state == "22023":
                raise ValueError(message) from None
            raise
        if row is None or record is None:  # pragma: no cover — the RPC always answers
            raise RuntimeError("create_run returned no row")
        return CreateResult(record, created=bool(row["created"]))

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
        run_uuid, user_uuid = _uuid(run_id), _uuid(owner.user_id)
        async with self._as_user(owner.user_id) as conn:
            status = await conn.fetchval(
                "SELECT t.status FROM public.tasks t WHERE t.id = $1 AND t.user_id = $2 FOR UPDATE",
                run_uuid,
                user_uuid,
            )
            if status is None:
                return None
            if status in ("queued", "running", "paused"):
                # As the user: 0034's grant + guard allow exactly this.
                await conn.execute(
                    "UPDATE public.tasks SET status = 'cancelled', finished_at = now(), "
                    "updated_at = now() WHERE id = $1 AND user_id = $2",
                    run_uuid,
                    user_uuid,
                )
                # The Next cancel route's `cancelChildTasks`.
                await conn.execute(
                    "UPDATE public.tasks SET status = 'cancelled', finished_at = now(), "
                    "updated_at = now() WHERE parent_task_id = $1 AND user_id = $2 "
                    "AND mode = 'background' AND status IN ('queued', 'running', 'paused')",
                    run_uuid,
                    user_uuid,
                )
                # The columns users cannot write, as the DSN role.
                await conn.execute("RESET ROLE")
                await conn.execute(
                    "UPDATE public.tasks SET outcome = $3::jsonb, lease_expires_at = NULL "
                    "WHERE id = $1 AND user_id = $2",
                    run_uuid,
                    user_uuid,
                    json.dumps(outcome_to_json(Cancelled())),
                )
            return await self._load(conn, run_id, owner.user_id)

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
            state = _sqlstate(exc)
            mapped = _SQLSTATE_RESPONSES.get(state or "")
            if mapped is None:
                raise
            message = str(getattr(exc, "message", "") or exc) or "Request rejected."
            raise RunWriteError(state, mapped[0], mapped[1], message) from None

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

    async def settle(self, run_id: str, outcome: RunOutcome) -> bool:
        async with self._as_system() as conn:
            row = await conn.fetchrow(
                "UPDATE public.tasks SET status = $2, outcome = $3::jsonb, "
                "finished_at = now(), updated_at = now(), lease_expires_at = NULL "
                "WHERE id = $1 AND status IN ('queued', 'running') RETURNING id",
                _uuid(run_id),
                _status_for(outcome),
                json.dumps(outcome_to_json(outcome)),
            )
        return row is not None

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
        open_interrupts=open_interrupts,
        result=result,
        error=error,
        lease_expires_at=row["lease_expires_at"],
    )
