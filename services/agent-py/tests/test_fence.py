"""DB-side lease fencing (`fence.fenced_connection`) + the reclaim seq
probe.

A write that passed `lease.check_current()` could still land after the
lease lapsed and another worker reclaimed the job (a long pool wait, a
slow statement). Pins:
  - the acquire is bounded;
  - the lease is re-checked AFTER the acquire;
  - with a fencing token the write runs in a transaction that first
    calls `private.fence_task_job` (0045: the task locks in their order,
    then the job row `FOR SHARE` at our `attempts`) — a reclaim blocks
    on it, and a claim already gone raises `LeaseLostError`;
  - the executor's run-state writes go through it;
  - a reclaimed run whose max-seq probe fails abandons the attempt
    instead of seeding from the checkpoint (colliding marker).
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import barrier, executor, fence, jobs, lease, store
from agent_py.lease import JobLease, LeaseLostError

from .test_pipeline_correctness import _norm, _pool, _RecordingConn

M0045 = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "0045_background_tasks_correct.sql"
)
JOB_ID = str(uuid.uuid4())
RUN_ID = str(uuid.uuid4())
USER_ID = str(uuid.uuid4())


@pytest.mark.asyncio
async def test_unbound_is_a_plain_bounded_acquire() -> None:
    conn = _RecordingConn()
    pool = _pool(conn)
    async with fence.fenced_connection(pool) as got:
        assert got is conn
    pool.acquire.assert_called_once_with(timeout=fence.ACQUIRE_TIMEOUT_S)
    assert conn.calls == []


@pytest.mark.asyncio
async def test_lease_rechecked_after_the_acquire() -> None:
    """The lease was fine when the caller checked, lost while it waited
    for a connection: nothing may run on that connection."""
    conn = _RecordingConn()
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60, attempts=2)
    pool = _pool(conn)

    async def lose_on_acquire(*_a: Any) -> _RecordingConn:
        job_lease.mark_lost("claim_taken_over")
        return conn

    pool.acquire.return_value.__aenter__ = AsyncMock(side_effect=lose_on_acquire)
    with lease.bound(job_lease), pytest.raises(LeaseLostError):
        async with fence.fenced_connection(pool):
            pytest.fail("body must not run")
    assert conn.calls == []


@pytest.mark.asyncio
async def test_fenced_write_locks_the_job_row_in_its_transaction() -> None:
    conn = _RecordingConn(fetchrow=[{"held": True}])
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60, attempts=2)
    with lease.bound(job_lease):
        async with fence.fenced_connection(_pool(conn)) as c:
            await c.execute("UPDATE public.tasks SET x = 1")
    kinds = [k for k, _ in conn.calls]
    assert kinds == ["txn_begin", "fetchrow", "execute", "txn_end"]
    sql, *args = conn.calls[1][1]
    assert "private.fence_task_job($1, $2)" in _norm(sql)
    body = M0045.read_text().split("function private.fence_task_job(")[1].split("$$;")[0]
    body = _norm(body)
    assert "j.attempts = p_attempts and j.status = 'running' for share" in body
    assert args == [uuid.UUID(JOB_ID), 2]
    # The write itself ran inside the fence's transaction.
    assert conn.calls[2][1][-1] is True


@pytest.mark.asyncio
async def test_claim_gone_raises_and_latches_the_lease() -> None:
    conn = _RecordingConn(fetchrow=[{"held": False}])
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60, attempts=2)
    with lease.bound(job_lease), pytest.raises(LeaseLostError):
        async with fence.fenced_connection(_pool(conn)) as c:
            await c.execute("UPDATE public.tasks SET x = 1")
    assert job_lease.lost
    assert not [k for k, _ in conn.calls if k == "execute"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("call", "fetchrow"),
    [
        (lambda p: store.append_event(p, _event(), user_id=USER_ID), []),
        (lambda p: store.save_checkpoint(p, run_id=RUN_ID, user_id=USER_ID, checkpoint={}), []),
        (lambda p: store.update_run(p, run_id=RUN_ID, user_id=USER_ID, status="paused"), []),
        (lambda p: jobs.enqueue_continue_job(p, task_id=RUN_ID, user_id=USER_ID), []),
        (
            lambda p: barrier.settle_task_terminal(
                p, task_id=RUN_ID, user_id=USER_ID, status="done"
            ),
            [{"parent_task_id": None}],
        ),
    ],
)
async def test_run_state_writes_are_fenced(call: Any, fetchrow: list[Any]) -> None:
    conn = _RecordingConn(fetchrow=[None, *fetchrow])  # fence finds no claim
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60, attempts=3)
    with lease.bound(job_lease), pytest.raises(LeaseLostError):
        await call(_pool(conn))
    assert not [k for k, _ in conn.calls if k == "execute"]


def _event() -> Any:
    from agent_py.events import StatusEvent

    return StatusEvent(run_id=RUN_ID, seq=3, step=0, created_at="t", status="running")


# --- reclaim seq probe ------------------------------------------------------


@pytest.mark.asyncio
async def test_reclaim_seq_probe_failure_abandons_the_attempt() -> None:
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60, attempts=2)
    with (
        patch.object(store, "max_event_seq", new=AsyncMock(side_effect=RuntimeError("db"))),
        lease.bound(job_lease),
        pytest.raises(LeaseLostError),
    ):
        await executor._seed_seq(
            MagicMock(), run_id=RUN_ID, user_id=USER_ID, checkpoint={"seq": 4}, reclaimed=True
        )
    assert job_lease.lost_reason == "seq_probe_failed_on_reclaim"


@pytest.mark.asyncio
async def test_fresh_run_seq_probe_failure_falls_back_to_the_checkpoint() -> None:
    with patch.object(store, "max_event_seq", new=AsyncMock(side_effect=RuntimeError("db"))):
        seq = await executor._seed_seq(
            MagicMock(), run_id=RUN_ID, user_id=USER_ID, checkpoint={"seq": 4}
        )
    assert seq == 4


@pytest.mark.asyncio
async def test_reclaimed_start_with_failing_probe_is_abandoned_not_failed() -> None:
    """The run must not be settled failed (nor its marker written): the
    attempt is given up and the job retried after its lease lapses."""
    job_lease = JobLease(job_id=JOB_ID, lease_seconds=60, attempts=2)
    with (
        patch.object(store, "load_checkpoint", new=AsyncMock(return_value={"seq": 4, "step": 2})),
        patch.object(store, "max_event_seq", new=AsyncMock(side_effect=RuntimeError("db"))),
        patch.object(store, "append_event", new=AsyncMock()) as append,
        patch("agent_py.executor.settle_task_terminal", new=AsyncMock()) as settle,
        lease.bound(job_lease),
        pytest.raises(LeaseLostError),
    ):
        await executor.execute_start(
            MagicMock(),
            executor.StartActionPayload(run_id=RUN_ID, user_id=USER_ID),
            reclaimed=True,
        )
    append.assert_not_awaited()
    settle.assert_not_awaited()


@pytest.mark.asyncio
async def test_poller_binds_the_claims_fencing_token() -> None:
    from agent_py import poller

    from .test_job_lease import _job, _live_settings

    job = _job(attempts=3)
    seen: dict[str, Any] = {}

    async def dispatch(_pool: Any, _job: Any) -> Any:
        bound = lease.current()
        assert bound is not None
        seen["attempts"] = bound.attempts
        return poller._Settlement(ok=True)

    with (
        patch.object(poller, "_dispatch", new=dispatch),
        patch.object(jobs, "extend_lease", new=AsyncMock(return_value=True)),
        patch.object(jobs, "mark_job_done", new=AsyncMock()),
    ):
        await poller._execute_claimed(MagicMock(), job, _live_settings())
    assert seen["attempts"] == 3
