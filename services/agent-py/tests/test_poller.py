"""Tests for the poll loop.

Phase 1 covered: dry-run release, no-pool no-op, loop survives errors,
cancellation. Phase 2 adds: feature-flag gating + executor dispatch +
supported-action filter.

The dispatch decision tree on each `_tick` (with pool + job):
  1. dry-run mode → release
  2. live mode + user opted out → fail job + task (OPTED_OUT_ERROR);
     flag lookup failed → release
  3. live mode + action not start/continue/respond → release
  4. live mode + task already terminal → settle the job done, no run
  5. live mode otherwise → execute, mark_done/failed
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import db, executor, feature_flag, jobs, poller
from agent_py.executor import ExecutorOutcome
from agent_py.jobs import ClaimedJob
from agent_py.settings import Settings


@pytest.fixture
def dry_run_settings() -> Settings:
    return Settings(
        SUPABASE_DB_URL="postgresql://localhost/fake",
        WORKER_DRY_RUN=True,
        POLL_INTERVAL_SECONDS=0.001,
    )


@pytest.fixture
def live_settings() -> Settings:
    return Settings(
        SUPABASE_DB_URL="postgresql://localhost/fake",
        WORKER_DRY_RUN=False,
        POLL_INTERVAL_SECONDS=0.001,
    )


# --- _tick: dry-run path (Phase 1 invariants preserved) -------------------


@pytest.mark.asyncio
async def test_tick_no_pool_is_noop(dry_run_settings: Settings) -> None:
    with patch.object(jobs, "claim_next_job", new=AsyncMock()) as claim:
        await poller._tick(dry_run_settings)
        claim.assert_not_called()


@pytest.mark.asyncio
async def test_tick_with_empty_queue_does_not_release(
    dry_run_settings: Settings,
) -> None:
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=None)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock()) as release,
        ):
            await poller._tick(dry_run_settings)
            release.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_dry_run_always_releases(
    dry_run_settings: Settings,
) -> None:
    """Dry-run is unconditional: no flag check, no executor — every
    claim goes back to the queue."""
    job = _make_job()
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock(return_value=True)) as release,
            patch.object(feature_flag, "python_executes_for_user", new=AsyncMock()) as flag,
            patch.object(executor, "execute_start", new=AsyncMock()) as execute,
        ):
            await poller._tick(dry_run_settings)
            release.assert_awaited_once_with(db._pool, job.id)
            flag.assert_not_called()
            execute.assert_not_called()
    finally:
        db._pool = None


# --- _tick: live mode (Phase 2) -------------------------------------------


@pytest.mark.asyncio
async def test_live_mode_opted_out_user_fails_job_and_task(live_settings: Settings) -> None:
    """Nothing else executes an opted-out user's job: it's failed (fenced
    on the claim's attempts) and its task settled with OPTED_OUT_ERROR —
    never released, which would re-claim it forever."""
    job = _make_job()
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock()) as release,
            patch.object(jobs, "mark_job_failed", new=AsyncMock(return_value=True)) as mark_failed,
            patch.object(
                feature_flag, "python_executes_for_user", new=AsyncMock(return_value=False)
            ),
            patch.object(
                executor, "settle_stranded_task", new=AsyncMock(return_value=True)
            ) as settle,
            patch.object(executor, "execute_start", new=AsyncMock()) as execute,
        ):
            await poller._tick(live_settings)
            release.assert_not_called()
            execute.assert_not_called()
            mark_failed.assert_awaited_once_with(
                db._pool, job.id, error="user_opted_out", attempts=job.attempts
            )
            settle.assert_awaited_once_with(
                db._pool,
                task_id=job.task_id,
                user_id=job.user_id,
                job_id=job.id,
                error=poller.OPTED_OUT_ERROR,
            )
    finally:
        db._pool = None


@pytest.mark.asyncio
@pytest.mark.parametrize(("executes", "reason"), [(None, "flag_lookup_failed")])
async def test_live_mode_unknown_user_releases(
    live_settings: Settings, executes: bool | None, reason: str
) -> None:
    job = _make_job()
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock(return_value=True)) as release,
            patch.object(
                feature_flag,
                "python_executes_for_user",
                new=AsyncMock(return_value=executes),
            ),
            patch.object(executor, "execute_start", new=AsyncMock()) as execute,
            patch.object(poller.logger, "info") as log_info,
        ):
            await poller._tick(live_settings)
            release.assert_awaited_once_with(db._pool, job.id)
            execute.assert_not_called()
            released_logs = [c for c in log_info.call_args_list if c.args[0] == "poller.released"]
            assert released_logs[-1].kwargs["reason"] == reason
    finally:
        db._pool = None


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["start", "continue", "respond"])
@pytest.mark.parametrize("task_status", ["done", "failed", "cancelled"])
async def test_live_mode_job_for_settled_task_is_done_without_running(
    live_settings: Settings, action: str, task_status: str
) -> None:
    """A job whose task settled while it waited — e.g. failed by the
    stale-run reconciler because no worker took it in time — must not
    run the task again after its terminal event."""
    job = _make_job(action=action, payload={"requestId": "tu_1"})
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(jobs, "mark_job_failed", new=AsyncMock()) as mark_failed,
            patch.object(
                feature_flag, "python_executes_for_user", new=AsyncMock(return_value=True)
            ),
            patch.object(
                poller.store, "load_owned_task_status", new=AsyncMock(return_value=task_status)
            ),
            patch.object(executor, "execute_start", new=AsyncMock()) as ex_start,
            patch.object(executor, "execute_continue", new=AsyncMock()) as ex_continue,
            patch.object(executor, "execute_respond", new=AsyncMock()) as ex_respond,
        ):
            await poller._tick(live_settings)
        mark_done.assert_awaited_once_with(db._pool, job.id, attempts=job.attempts)
        mark_failed.assert_not_called()
        ex_start.assert_not_called()
        ex_continue.assert_not_called()
        ex_respond.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_live_mode_flagged_respond_action_dispatches_to_executor(
    live_settings: Settings,
) -> None:
    """Phase 3b: `respond` jobs route to `executor.execute_respond`
    for flagged users. Payload `{requestId, approved}` is parsed
    into a typed `RespondActionPayload`."""
    job = _make_job(
        action="respond",
        payload={"requestId": "tu_1", "approved": True},
    )
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock()) as release,
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(
                feature_flag,
                "python_executes_for_user",
                new=AsyncMock(return_value=True),
            ),
            patch.object(
                executor,
                "execute_respond",
                new=AsyncMock(return_value=executor.ExecutorOutcome(settled=True)),
            ) as execute,
        ):
            await poller._tick(live_settings)
            execute.assert_awaited_once()
            args = execute.await_args
            assert args is not None
            payload = args.args[1]
            assert isinstance(payload, executor.RespondActionPayload)
            assert payload.request_id == "tu_1"
            assert payload.approved is True
            mark_done.assert_awaited_once_with(db._pool, job.id, attempts=job.attempts)
            release.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_live_mode_flagged_respond_invalid_payload_marks_failed(
    live_settings: Settings,
) -> None:
    """If the respond job's payload lacks `requestId` we can't find
    the pending tool call, so the executor would fail. Catch it at
    the poller boundary and mark the job failed without dispatching."""
    job = _make_job(action="respond", payload={"approved": True})  # no requestId
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "mark_job_failed", new=AsyncMock()) as mark_failed,
            patch.object(
                feature_flag,
                "python_executes_for_user",
                new=AsyncMock(return_value=True),
            ),
            patch.object(executor, "execute_respond", new=AsyncMock()) as execute,
        ):
            await poller._tick(live_settings)
            execute.assert_not_called()
            mark_failed.assert_awaited_once()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_live_mode_flagged_continue_action_dispatches_to_executor(
    live_settings: Settings,
) -> None:
    """Phase 3a: `continue` jobs route to `executor.execute_continue`
    for flagged users. The job's settled outcome marks it done."""
    job = _make_job(action="continue")
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock()) as release,
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(
                feature_flag,
                "python_executes_for_user",
                new=AsyncMock(return_value=True),
            ),
            patch.object(
                executor,
                "execute_continue",
                new=AsyncMock(return_value=executor.ExecutorOutcome(settled=True)),
            ) as execute,
        ):
            await poller._tick(live_settings)
            execute.assert_awaited_once()
            mark_done.assert_awaited_once_with(db._pool, job.id, attempts=job.attempts)
            release.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_live_mode_flagged_start_dispatches_to_executor_and_marks_done(
    live_settings: Settings,
) -> None:
    job = _make_job(action="start")
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock()) as release,
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(jobs, "mark_job_failed", new=AsyncMock()) as mark_failed,
            patch.object(
                feature_flag,
                "python_executes_for_user",
                new=AsyncMock(return_value=True),
            ),
            patch.object(
                executor,
                "execute_start",
                new=AsyncMock(return_value=ExecutorOutcome(settled=True)),
            ) as execute,
        ):
            await poller._tick(live_settings)
            execute.assert_awaited_once()
            mark_done.assert_awaited_once_with(db._pool, job.id, attempts=job.attempts)
            mark_failed.assert_not_called()
            release.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_live_mode_executor_failure_marks_job_failed(
    live_settings: Settings,
) -> None:
    job = _make_job(action="start")
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "mark_job_done", new=AsyncMock()) as mark_done,
            patch.object(jobs, "mark_job_failed", new=AsyncMock()) as mark_failed,
            patch.object(
                feature_flag,
                "python_executes_for_user",
                new=AsyncMock(return_value=True),
            ),
            patch.object(
                executor,
                "execute_start",
                new=AsyncMock(return_value=ExecutorOutcome(settled=False, error="boom")),
            ),
        ):
            await poller._tick(live_settings)
            mark_failed.assert_awaited_once()
            assert mark_failed.await_args.kwargs.get("error") == "boom"
            mark_done.assert_not_called()
    finally:
        db._pool = None


# --- run_poll_loop (unchanged from Phase 1) -------------------------------


@pytest.mark.asyncio
async def test_loop_keeps_going_after_tick_raises(
    dry_run_settings: Settings,
) -> None:
    calls: list[int] = []

    async def flaky_tick(_settings: Settings) -> None:
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("transient")

    async def fast_sleep(_s: float) -> None:
        return None

    with patch.object(poller, "_tick", new=flaky_tick):
        iters = await poller.run_poll_loop(
            dry_run_settings,
            sleep=fast_sleep,
            stop_after_iterations=3,
        )
    assert iters == 3
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_loop_cancels_cleanly(dry_run_settings: Settings) -> None:
    async def slow_sleep(_s: float) -> None:
        await asyncio.sleep(60)

    with patch.object(poller, "_tick", new=AsyncMock()):
        task = asyncio.create_task(
            poller.run_poll_loop(dry_run_settings, sleep=slow_sleep),
        )
        await asyncio.sleep(0.01)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert task.cancelled() or task.done()


# --- helpers --------------------------------------------------------------


def _make_job(**overrides: Any) -> ClaimedJob:
    base = {
        "id": "11111111-1111-1111-1111-111111111111",
        "task_id": "22222222-2222-2222-2222-222222222222",
        "user_id": "33333333-3333-3333-3333-333333333333",
        "action": "start",
        "payload": {},
        "attempts": 1,
        "max_attempts": 3,
    }
    base.update(overrides)
    return ClaimedJob(**base)  # type: ignore[arg-type]
