"""Job lease / reclaim / settlement robustness (migration 0032).

Pins the fixes for jobs + tasks stranded `running` forever:

  1. SQL: the claim stamps a lease and (live mode) reclaims expired
     `running` rows under the attempt budget; heartbeat / settle /
     hand-back are fenced on the claim's `attempts`; the reaper fails
     expired, exhausted jobs.
  2. Poller: heartbeats while executing; settles exactly once — done /
     failed / handed back on cancel — even when the settle is itself
     interrupted; an error escaping the executor fails the task too;
     reaped jobs get their task settled.
  3. `reclaim_decision`: a reclaimed job resumes from the task's state
     instead of blindly re-running.
  4. Executor: failures before the loop's own `try` still settle the
     run; respond only owns (and fails) the task after the paused claim.
  5. Shutdown: in-flight jobs finish within the grace period, or are
     handed back.

No Postgres in CI: SQL-level checks run against a recording fake
connection; behaviour checks patch the DB edges.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import db, executor, feature_flag, jobs, poller, store
from agent_py.barrier import SettleResult
from agent_py.events import ResultEvent, TaskEvent
from agent_py.executor import ExecutorOutcome
from agent_py.jobs import ClaimedJob, JobTaskState, ReapedJob
from agent_py.main import stop_poller
from agent_py.settings import Settings

JOB_ID = "11111111-1111-1111-1111-111111111111"
RUN_ID = "22222222-2222-2222-2222-222222222222"
USER_ID = "33333333-3333-3333-3333-333333333333"
REPO_ROOT = Path(__file__).resolve().parents[3]


# --- helpers ----------------------------------------------------------------


class _RecordingConn:
    def __init__(
        self, *, fetchrow: Any = None, fetch: Any = None, execute: str = "UPDATE 1"
    ) -> None:
        self.calls: list[tuple[str, str, tuple[Any, ...]]] = []
        self._fetchrow = fetchrow
        self._fetch = fetch if fetch is not None else []
        self._execute = execute

    async def fetchrow(self, sql: str, *args: Any) -> Any:
        self.calls.append(("fetchrow", sql, args))
        return self._fetchrow

    async def fetch(self, sql: str, *args: Any) -> Any:
        self.calls.append(("fetch", sql, args))
        return self._fetch

    async def execute(self, sql: str, *args: Any) -> str:
        self.calls.append(("execute", sql, args))
        return self._execute


def _pool(conn: _RecordingConn) -> MagicMock:
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


def _norm(sql: str) -> str:
    return " ".join(sql.split())


def _job(**overrides: Any) -> ClaimedJob:
    base: dict[str, Any] = {
        "id": JOB_ID,
        "task_id": RUN_ID,
        "user_id": USER_ID,
        "action": "start",
        "payload": {},
        "attempts": 2,
        "max_attempts": 3,
    }
    base.update(overrides)
    return ClaimedJob(**base)


def _state(**overrides: Any) -> JobTaskState:
    base: dict[str, Any] = {
        "task_status": "running",
        "step": 3,
        "pending_children": 0,
        "awaiting_children": False,
        "has_other_live_job": False,
        "superseded": False,
    }
    base.update(overrides)
    return JobTaskState(**base)


def _live_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "SUPABASE_DB_URL": "postgresql://localhost/fake",
        "WORKER_DRY_RUN": False,
        "POLL_INTERVAL_SECONDS": 0.001,
    }
    base.update(overrides)
    return Settings(**base)


# --- 1. migration + SQL -----------------------------------------------------


def test_migration_adds_lease_column_and_reclaim_index() -> None:
    sql = (REPO_ROOT / "supabase" / "migrations" / "0032_task_job_lease.sql").read_text().lower()
    assert "add column if not exists lease_expires_at timestamptz" in sql
    assert "create index if not exists task_jobs_lease_idx" in sql
    assert "where status = 'running'" in sql


@pytest.mark.asyncio
async def test_claim_sets_lease_and_reclaims_expired_running_rows() -> None:
    conn = _RecordingConn(fetchrow=None)
    await jobs.claim_next_job(_pool(conn), lease_seconds=90, reclaim_expired=True)
    _, sql, args = conn.calls[0]
    flat = _norm(sql)
    assert "lease_expires_at = now() + $1::double precision * interval '1 second'" in flat
    # Fresh queued rows OR (live mode) running rows whose lease lapsed —
    # both only under the attempt budget.
    assert "attempts < max_attempts" in flat
    assert "(status = 'queued' AND scheduled_at <= now())" in flat
    assert "($2::boolean AND status = 'running' AND lease_expires_at < now())" in flat
    assert "FOR UPDATE SKIP LOCKED" in flat
    assert "attempts = t.attempts + 1" in flat
    assert "(next_job.prev_status = 'running') AS reclaimed" in flat
    assert args == (90.0, True)


@pytest.mark.asyncio
async def test_claim_maps_reclaimed_flag() -> None:
    row = {
        "id": uuid.UUID(JOB_ID),
        "task_id": uuid.UUID(RUN_ID),
        "user_id": uuid.UUID(USER_ID),
        "action": "continue",
        "payload": {},
        "attempts": 2,
        "max_attempts": 3,
        "reclaimed": True,
    }
    job = await jobs.claim_next_job(_pool(_RecordingConn(fetchrow=row)))
    assert job is not None and job.reclaimed is True


@pytest.mark.asyncio
async def test_extend_lease_is_fenced_on_the_claims_attempts() -> None:
    conn = _RecordingConn(execute="UPDATE 1")
    assert await jobs.extend_lease(_pool(conn), JOB_ID, attempts=2, lease_seconds=60) is True
    _, sql, args = conn.calls[0]
    flat = _norm(sql)
    assert "lease_expires_at = now() + $3::double precision * interval '1 second'" in flat
    assert "status = 'running'" in flat
    assert "attempts = $2::integer" in flat
    assert args == (uuid.UUID(JOB_ID), 2, 60.0)


@pytest.mark.asyncio
async def test_extend_lease_reports_a_lost_claim() -> None:
    conn = _RecordingConn(execute="UPDATE 0")
    assert await jobs.extend_lease(_pool(conn), JOB_ID, attempts=2) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("which", ["done", "failed"])
async def test_settle_clears_lease_and_is_fenced(which: str) -> None:
    conn = _RecordingConn(execute="UPDATE 0")
    if which == "done":
        ok = await jobs.mark_job_done(_pool(conn), JOB_ID, attempts=2)
    else:
        ok = await jobs.mark_job_failed(_pool(conn), JOB_ID, error="boom", attempts=2)
    assert ok is False
    _, sql, args = conn.calls[0]
    flat = _norm(sql)
    assert "lease_expires_at = NULL" in flat
    assert "status = 'running'" in flat
    assert "IS NULL OR attempts =" in flat
    assert args[-1] == 2


@pytest.mark.asyncio
async def test_release_clears_lease() -> None:
    conn = _RecordingConn(execute="UPDATE 1")
    await jobs.release_job_to_queue(_pool(conn), JOB_ID)
    assert "lease_expires_at = NULL" in _norm(conn.calls[0][1])


@pytest.mark.asyncio
async def test_hand_back_expires_lease_now_and_refunds_the_attempt() -> None:
    conn = _RecordingConn(execute="UPDATE 1")
    assert await jobs.hand_back_job(_pool(conn), JOB_ID, attempts=2) is True
    _, sql, args = conn.calls[0]
    flat = _norm(sql)
    # Stays `running` with a lapsed lease → the next claim reclaims it
    # immediately, flagged as interrupted.
    assert "status = 'queued'" not in flat
    assert "lease_expires_at = now() - interval '1 second'" in flat
    assert "attempts = GREATEST(attempts - 1, 0)" in flat
    assert "attempts = $2::integer" in flat
    assert args == (uuid.UUID(JOB_ID), 2)


@pytest.mark.asyncio
async def test_reap_fails_expired_jobs_at_the_attempt_limit() -> None:
    rows = [
        {
            "id": uuid.UUID(JOB_ID),
            "task_id": uuid.UUID(RUN_ID),
            "user_id": uuid.UUID(USER_ID),
            "action": "start",
            "attempts": 3,
        }
    ]
    conn = _RecordingConn(fetch=rows)
    reaped = await jobs.reap_expired_jobs(_pool(conn), limit=5)
    assert reaped == [
        ReapedJob(id=JOB_ID, task_id=RUN_ID, user_id=USER_ID, action="start", attempts=3)
    ]
    _, sql, args = conn.calls[0]
    flat = _norm(sql)
    assert "status = 'running'" in flat
    assert "lease_expires_at < now()" in flat
    assert "attempts >= max_attempts" in flat
    assert "SET status = 'failed'" in flat
    assert "FOR UPDATE SKIP LOCKED" in flat
    assert args == (5,)


@pytest.mark.asyncio
async def test_job_task_state_counts_queued_and_leased_jobs_as_live() -> None:
    row = {
        "status": "running",
        "step": 4,
        "pending_children": 0,
        "awaiting_children": False,
        "has_other_live_job": True,
        "superseded": False,
    }
    conn = _RecordingConn(fetchrow=row)
    state = await jobs.load_job_task_state(
        _pool(conn), task_id=RUN_ID, user_id=USER_ID, job_id=JOB_ID
    )
    assert state == _state(step=4, has_other_live_job=True)
    _, sql, args = conn.calls[0]
    flat = _norm(sql)
    assert "(j.status = 'queued' AND j.attempts < j.max_attempts)" in flat
    assert "(j.status = 'running' AND j.lease_expires_at > now())" in flat
    assert "t.id = $1 AND t.user_id = $2" in flat
    assert args == (uuid.UUID(RUN_ID), uuid.UUID(USER_ID), uuid.UUID(JOB_ID))


# --- 2. poller: claim / heartbeat / settle ----------------------------------


@pytest.mark.asyncio
async def test_dry_run_claims_queued_only() -> None:
    settings = _live_settings(WORKER_DRY_RUN=True, JOB_LEASE_SECONDS=42)
    db._pool = MagicMock()
    with (
        patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=None)) as claim,
        patch.object(jobs, "reap_expired_jobs", new=AsyncMock()) as reap,
    ):
        await poller._tick(settings)
    claim.assert_awaited_once_with(db._pool, lease_seconds=42, reclaim_expired=False)
    reap.assert_not_called()


@pytest.mark.asyncio
async def test_live_tick_reaps_and_settles_each_reaped_task() -> None:
    reaped = ReapedJob(id=JOB_ID, task_id=RUN_ID, user_id=USER_ID, action="start", attempts=3)
    db._pool = MagicMock()
    with (
        patch.object(jobs, "reap_expired_jobs", new=AsyncMock(return_value=[reaped])),
        patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=None)) as claim,
        patch.object(executor, "settle_stranded_task", new=AsyncMock(return_value=True)) as st,
    ):
        await poller._tick(_live_settings())
    st.assert_awaited_once()
    assert st.await_args.kwargs["task_id"] == RUN_ID
    assert st.await_args.kwargs["job_id"] == JOB_ID
    assert claim.await_args.kwargs["reclaim_expired"] is True


@pytest.mark.asyncio
async def test_heartbeat_extends_the_lease_while_the_job_runs() -> None:
    settings = _live_settings(JOB_LEASE_SECONDS=0.3, JOB_HEARTBEAT_SECONDS=0.02)

    async def slow_start(*_a: Any, **_k: Any) -> ExecutorOutcome:
        await asyncio.sleep(0.12)
        return ExecutorOutcome(settled=True)

    pool = MagicMock()
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=slow_start),
        patch.object(jobs, "extend_lease", new=AsyncMock(return_value=True)) as extend,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)) as done,
    ):
        await poller._execute_claimed(pool, _job(), settings)
        calls_at_settle = extend.await_count
        await asyncio.sleep(0.06)

    assert calls_at_settle >= 2
    assert extend.await_args.kwargs == {"attempts": 2, "lease_seconds": 0.3}
    # Heartbeat stops once the job is settled.
    assert extend.await_count == calls_at_settle
    done.assert_awaited_once_with(pool, JOB_ID, attempts=2)


@pytest.mark.asyncio
async def test_cancelled_job_is_handed_back_not_settled() -> None:
    started = asyncio.Event()

    async def hang(*_a: Any, **_k: Any) -> ExecutorOutcome:
        started.set()
        await asyncio.sleep(60)
        return ExecutorOutcome(settled=True)

    pool = MagicMock()
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=hang),
        patch.object(jobs, "hand_back_job", new=AsyncMock(return_value=True)) as hand_back,
        patch.object(jobs, "mark_job_done", new=AsyncMock()) as done,
        patch.object(jobs, "mark_job_failed", new=AsyncMock()) as failed,
    ):
        task = asyncio.create_task(poller._execute_claimed(pool, _job(), _live_settings()))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    hand_back.assert_awaited_once_with(pool, JOB_ID, attempts=2)
    done.assert_not_called()
    failed.assert_not_called()


@pytest.mark.asyncio
async def test_settle_write_survives_a_cancel_landing_mid_write() -> None:
    write_started = asyncio.Event()
    write_finished = asyncio.Event()

    async def slow_done(*_a: Any, **_k: Any) -> bool:
        write_started.set()
        await asyncio.sleep(0.05)
        write_finished.set()
        return True

    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(
            executor, "execute_start", new=AsyncMock(return_value=ExecutorOutcome(settled=True))
        ),
        patch.object(jobs, "mark_job_done", new=slow_done),
        patch.object(jobs, "hand_back_job", new=AsyncMock()) as hand_back,
    ):
        task = asyncio.create_task(poller._execute_claimed(MagicMock(), _job(), _live_settings()))
        await write_started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert write_finished.is_set()
    hand_back.assert_not_called()


@pytest.mark.asyncio
async def test_error_escaping_the_executor_fails_job_and_settles_task() -> None:
    pool = MagicMock()
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=AsyncMock(side_effect=RuntimeError("db gone"))),
        patch.object(jobs, "mark_job_failed", new=AsyncMock(return_value=True)) as failed,
        patch.object(executor, "settle_stranded_task", new=AsyncMock(return_value=True)) as st,
    ):
        await poller._execute_claimed(pool, _job(), _live_settings())
    failed.assert_awaited_once()
    assert "db gone" in failed.await_args.kwargs["error"]
    assert failed.await_args.kwargs["attempts"] == 2
    st.assert_awaited_once()
    assert st.await_args.kwargs["job_id"] == JOB_ID


@pytest.mark.asyncio
async def test_failing_settle_write_does_not_crash_the_tick() -> None:
    """A failed `mark_job_done` leaves the job `running`; its lease lapses
    and the reclaim path re-examines it — the tick must not raise."""
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(
            executor, "execute_start", new=AsyncMock(return_value=ExecutorOutcome(settled=True))
        ),
        patch.object(jobs, "mark_job_done", new=AsyncMock(side_effect=OSError("conn reset"))),
    ):
        await poller._execute_claimed(MagicMock(), _job(), _live_settings())


@pytest.mark.asyncio
async def test_reclaimed_job_for_a_settled_task_is_skipped() -> None:
    db._pool = MagicMock()
    job = _job(reclaimed=True)
    with (
        patch.object(jobs, "reap_expired_jobs", new=AsyncMock(return_value=[])),
        patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
        patch.object(feature_flag, "is_user_flagged_to_python", new=AsyncMock(return_value=True)),
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(
            jobs, "load_job_task_state", new=AsyncMock(return_value=_state(task_status="done"))
        ),
        patch.object(executor, "execute_start", new=AsyncMock()) as ex_start,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)) as done,
    ):
        await poller._tick(_live_settings())
    ex_start.assert_not_called()
    done.assert_awaited_once_with(db._pool, JOB_ID, attempts=2)


@pytest.mark.asyncio
async def test_reclaimed_respond_on_a_running_task_resumes_as_continue() -> None:
    db._pool = MagicMock()
    job = _job(action="respond", payload={"requestId": "tu_1"}, reclaimed=True)
    with (
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(jobs, "load_job_task_state", new=AsyncMock(return_value=_state())),
        patch.object(executor, "execute_respond", new=AsyncMock()) as ex_respond,
        patch.object(
            executor,
            "execute_continue",
            new=AsyncMock(return_value=ExecutorOutcome(settled=True)),
        ) as ex_continue,
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)),
    ):
        await poller._execute_claimed(db._pool, job, _live_settings())
    ex_respond.assert_not_called()
    ex_continue.assert_awaited_once()


# --- 3. reclaim_decision ----------------------------------------------------


@pytest.mark.parametrize(
    ("action", "state", "expected"),
    [
        ("start", _state(task_status="done"), "skip"),
        ("respond", _state(task_status="cancelled"), "skip"),
        ("start", _state(superseded=True), "skip"),
        ("continue", _state(superseded=True), "skip"),
        ("start", _state(task_status="paused"), "skip"),
        ("continue", _state(task_status="paused"), "skip"),
        ("continue", _state(task_status="paused", awaiting_children=True), "run"),
        (
            "continue",
            _state(task_status="paused", awaiting_children=True, pending_children=2),
            "skip",
        ),
        ("respond", _state(task_status="paused"), "run"),
        ("respond", _state(), "continue"),
        ("respond", _state(has_other_live_job=True), "skip"),
        ("start", _state(), "run"),
        ("continue", _state(task_status="queued"), "run"),
    ],
)
def test_reclaim_decision(action: str, state: JobTaskState, expected: str) -> None:
    decision, reason = poller.reclaim_decision(action, state)
    assert decision == expected, reason


# --- settle_stranded_task ---------------------------------------------------


def _list_sink() -> tuple[list[TaskEvent], Any]:
    collected: list[TaskEvent] = []

    async def sink(event: TaskEvent) -> None:
        collected.append(event)

    return collected, sink


@pytest.mark.asyncio
async def test_stranded_task_is_settled_failed_with_a_terminal_event() -> None:
    collected, sink = _list_sink()
    with (
        patch.object(jobs, "load_job_task_state", new=AsyncMock(return_value=_state(step=4))),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=17)),
        patch(
            "agent_py.executor.settle_task_terminal",
            new=AsyncMock(return_value=SettleResult(True, None, None, False)),
        ) as settle,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        ok = await executor.settle_stranded_task(
            MagicMock(), task_id=RUN_ID, user_id=USER_ID, job_id=JOB_ID, error="lease expired"
        )
    assert ok is True
    assert settle.await_args.kwargs["status"] == "failed"
    [event] = collected
    assert isinstance(event, ResultEvent)
    assert (event.status, event.seq, event.step, event.error) == ("failed", 18, 4, "lease expired")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [
        _state(task_status="paused"),
        _state(task_status="done"),
        _state(has_other_live_job=True),
        None,
    ],
)
async def test_stranded_settle_leaves_live_or_settled_tasks_alone(state: Any) -> None:
    with (
        patch.object(jobs, "load_job_task_state", new=AsyncMock(return_value=state)),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        ok = await executor.settle_stranded_task(
            MagicMock(), task_id=RUN_ID, user_id=USER_ID, job_id=JOB_ID, error="x"
        )
    assert ok is False
    settle.assert_not_called()


@pytest.mark.asyncio
async def test_stranded_settle_emits_nothing_when_the_run_settled_concurrently() -> None:
    collected, sink = _list_sink()
    with (
        patch.object(jobs, "load_job_task_state", new=AsyncMock(return_value=_state())),
        patch(
            "agent_py.executor.settle_task_terminal",
            new=AsyncMock(return_value=SettleResult(False, None, None, False)),
        ),
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        ok = await executor.settle_stranded_task(
            MagicMock(), task_id=RUN_ID, user_id=USER_ID, job_id=JOB_ID, error="x"
        )
    assert ok is False
    assert collected == []


# --- 4. executor: failures outside the loop's try ---------------------------


@pytest.mark.asyncio
async def test_checkpoint_load_failure_settles_the_run_failed() -> None:
    collected, sink = _list_sink()
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(side_effect=OSError("db down"))),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=1)),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_start(
            MagicMock(), executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID)
        )
    assert outcome.settled is False
    assert "db down" in (outcome.error or "")
    assert settle.await_args.kwargs["status"] == "failed"
    [event] = collected
    assert isinstance(event, ResultEvent) and event.status == "failed" and event.seq == 2


@pytest.mark.asyncio
async def test_child_results_load_failure_settles_the_parent_failed() -> None:
    checkpoint = {
        "messages": [{"role": "user", "content": "go"}],
        "step": 2,
        "seq": 9,
        "config": {},
        "awaiting_children": {"tool_call_id": "tu_spawn", "children": []},
    }
    collected, sink = _list_sink()
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=9)),
        patch.object(store, "load_child_results", new=AsyncMock(side_effect=OSError("boom"))),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_continue(
            MagicMock(), executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID)
        )
    assert outcome.settled is False
    settle.assert_awaited_once()
    assert [e.status for e in collected if isinstance(e, ResultEvent)] == ["failed"]


def _gated_checkpoint() -> dict[str, Any]:
    return {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "tu_1", "name": "danger", "input": {}}],
            },
        ],
        "step": 1,
        "seq": 8,
        "config": {"requireApprovalFor": ["danger"]},
    }


@pytest.mark.asyncio
async def test_respond_failure_before_the_paused_claim_leaves_the_task_alone() -> None:
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(side_effect=OSError("db down"))),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
    ):
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(run_id=RUN_ID, user_id=USER_ID, request_id="tu_1"),
        )
    assert outcome.settled is False
    settle.assert_not_called()


@pytest.mark.asyncio
async def test_respond_failure_after_the_paused_claim_settles_the_task_failed() -> None:
    _, sink = _list_sink()
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=_gated_checkpoint())),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock(return_value=True)),
        # Raised from the seq probe in `_fail_run` too → falls back to no
        # event; what matters is the settle.
        patch.object(store, "max_event_seq", new=AsyncMock(side_effect=OSError("db down"))),
        patch(
            "agent_py.executor._build_tool_result_text",
            new=AsyncMock(side_effect=RuntimeError("tool blew up")),
        ),
        patch(
            "agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())
        ) as settle,
        patch("agent_py.executor._make_db_sink", return_value=sink),
    ):
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=True
            ),
        )
    assert outcome.settled is False
    assert "tool blew up" in (outcome.error or "")
    assert settle.await_args.kwargs["status"] == "failed"


# --- 5. shutdown ------------------------------------------------------------


@pytest.mark.asyncio
async def test_shutdown_lets_an_in_flight_job_finish_within_the_grace() -> None:
    started = asyncio.Event()

    async def short_job(*_a: Any, **_k: Any) -> ExecutorOutcome:
        started.set()
        await asyncio.sleep(0.05)
        return ExecutorOutcome(settled=True)

    db._pool = MagicMock()
    claims = [_job(), None]
    with (
        patch.object(jobs, "reap_expired_jobs", new=AsyncMock(return_value=[])),
        patch.object(jobs, "claim_next_job", new=AsyncMock(side_effect=claims)) as claim,
        patch.object(feature_flag, "is_user_flagged_to_python", new=AsyncMock(return_value=True)),
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=short_job),
        patch.object(jobs, "mark_job_done", new=AsyncMock(return_value=True)) as done,
        patch.object(jobs, "hand_back_job", new=AsyncMock()) as hand_back,
    ):
        stop = asyncio.Event()
        task = asyncio.create_task(poller.run_poll_loop(_live_settings(), stop=stop))
        await started.wait()
        await stop_poller(task, stop, grace_s=2.0)

    assert task.done() and not task.cancelled()
    done.assert_awaited_once()
    hand_back.assert_not_called()
    # Stopped after the in-flight tick — no further claim.
    assert claim.await_count == 1


@pytest.mark.asyncio
async def test_shutdown_hands_back_a_job_that_outlives_the_grace() -> None:
    started = asyncio.Event()

    async def long_job(*_a: Any, **_k: Any) -> ExecutorOutcome:
        started.set()
        await asyncio.sleep(60)
        return ExecutorOutcome(settled=True)

    db._pool = MagicMock()
    with (
        patch.object(jobs, "reap_expired_jobs", new=AsyncMock(return_value=[])),
        patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=_job())),
        patch.object(feature_flag, "is_user_flagged_to_python", new=AsyncMock(return_value=True)),
        patch.object(store, "is_task_owned_by", new=AsyncMock(return_value=True)),
        patch.object(executor, "execute_start", new=long_job),
        patch.object(jobs, "mark_job_done", new=AsyncMock()) as done,
        patch.object(jobs, "hand_back_job", new=AsyncMock(return_value=True)) as hand_back,
    ):
        stop = asyncio.Event()
        task = asyncio.create_task(poller.run_poll_loop(_live_settings(), stop=stop))
        await started.wait()
        await stop_poller(task, stop, grace_s=0.05)

    assert task.done()
    hand_back.assert_awaited_once_with(db._pool, JOB_ID, attempts=2)
    done.assert_not_called()


@pytest.mark.asyncio
async def test_stop_cuts_an_idle_sleep_short() -> None:
    db._pool = None  # no pool → every tick is a no-op, loop just sleeps
    stop = asyncio.Event()
    task = asyncio.create_task(
        poller.run_poll_loop(_live_settings(POLL_INTERVAL_SECONDS=60), stop=stop)
    )
    await asyncio.sleep(0.01)
    await stop_poller(task, stop, grace_s=1.0)
    assert task.done() and not task.cancelled()


# --- 6. respond: tool set parity + only gated calls are answerable ----------


def _spawn_checkpoint(**extra: Any) -> dict[str, Any]:
    return {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "tu_spawn", "name": "spawnSubagent", "input": {}}
                ],
            },
        ],
        "step": 1,
        "seq": 8,
        "config": {"requireApprovalFor": ["danger"]},
        **extra,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("checkpoint", "error_fragment"),
    [
        # Parent paused on its subagents — only the barrier may resume it.
        (
            _spawn_checkpoint(awaiting_children={"tool_call_id": "tu_spawn", "children": []}),
            "subagents",
        ),
        # Even without the marker, a non-gated call isn't awaiting the user.
        (_spawn_checkpoint(), "not awaiting user input"),
    ],
)
async def test_respond_rejects_the_spawn_subagent_call(
    checkpoint: dict[str, Any], error_fragment: str
) -> None:
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock()) as claim,
    ):
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_spawn", approved=True
            ),
        )
    assert outcome.settled is False
    assert error_fragment in (outcome.error or "")
    # Rejected before the paused → running flip: the task is untouched.
    claim.assert_not_called()


@pytest.mark.asyncio
async def test_respond_executes_an_approved_mcp_tool_with_the_workspace_context() -> None:
    from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome
    from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

    mcp_name = "mcp__crm__write"
    calls: list[dict[str, Any]] = []

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        calls.append(args)
        return ToolInvocationResult(text="crm updated", summary="ok")

    async def fake_extend(
        registry: dict[str, ToolDescriptor], *, gated_out: set[str] | None = None, **kw: Any
    ) -> dict[str, ToolDescriptor]:
        assert kw["workspace_id"] == "ws_1"
        registry[mcp_name] = ToolDescriptor(
            name=mcp_name, description="", input_schema={"type": "object"}, execute=execute
        )
        # Gated by server policy, not by the checkpoint's requireApprovalFor.
        if gated_out is not None:
            gated_out.add(mcp_name)
        return registry

    checkpoint = {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "tu_1", "name": mcp_name, "input": {"id": 7}}
                ],
            },
        ],
        "step": 1,
        "seq": 8,
        "config": {"workspaceId": "ws_1"},
    }
    seen_contexts: list[Any] = []

    def make(_p: Any, _c: Any, _m: Any, ctx: Any = None) -> RunStepFn:
        seen_contexts.append(ctx)

        async def step(_ctx: RunStepContext) -> RunStepOutcome:
            return RunStepOutcome(done=True)

        return step

    _, sink = _list_sink()
    with (
        patch("agent_py.executor.extend_registry_with_mcp", new=fake_extend),
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value=checkpoint)),
        patch.object(store, "claim_paused_for_respond", new=AsyncMock(return_value=True)),
        patch.object(store, "max_event_seq", new=AsyncMock(return_value=8)),
        patch.object(store, "load_run_events", new=AsyncMock(return_value=[])),
        patch.object(store, "set_task_handler", new=AsyncMock()),
        patch.object(store, "is_run_cancelled", new=AsyncMock(return_value=False)),
        patch.object(store, "update_run", new=AsyncMock()),
        patch.object(store, "save_checkpoint", new=AsyncMock()) as save_checkpoint,
        patch("agent_py.executor._make_db_sink", return_value=sink),
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock(return_value=MagicMock())),
    ):
        outcome = await executor.execute_respond(
            MagicMock(),
            executor.RespondActionPayload(
                run_id=RUN_ID, user_id=USER_ID, request_id="tu_1", approved=True
            ),
            make_step_fn=make,
        )

    assert outcome.settled is True
    assert calls == [{"id": 7}]
    saved = save_checkpoint.await_args_list[0].kwargs["checkpoint"]
    assert saved["messages"][-1]["content"][0]["content"] == "crm updated"
    assert seen_contexts[0].workspace_id == "ws_1"
