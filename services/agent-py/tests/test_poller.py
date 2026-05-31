"""Tests for the poll loop.

Phase 1 covered: dry-run release, no-pool no-op, loop survives errors,
cancellation. Phase 2 adds: feature-flag gating + executor dispatch +
supported-action filter.

The dispatch decision tree on each `_tick` (with pool + job):
  1. dry-run mode → release
  2. live mode + unflagged → release
  3. live mode + flagged + action != 'start' → release (not supported)
  4. live mode + flagged + action == 'start' → execute, mark_done/failed
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
            patch.object(feature_flag, "is_user_flagged_to_python", new=AsyncMock()) as flag,
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
async def test_live_mode_unflagged_user_releases(
    live_settings: Settings,
) -> None:
    job = _make_job()
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock(return_value=True)) as release,
            patch.object(
                feature_flag,
                "is_user_flagged_to_python",
                new=AsyncMock(return_value=False),
            ),
            patch.object(executor, "execute_start", new=AsyncMock()) as execute,
        ):
            await poller._tick(live_settings)
            release.assert_awaited_once_with(db._pool, job.id)
            execute.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_live_mode_flagged_respond_action_releases(
    live_settings: Settings,
) -> None:
    """`respond` (HITL) still rides the TS worker — Phase 3b will
    port it. Phase 3a only added `continue` end-to-end."""
    job = _make_job(action="respond")
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock(return_value=True)) as release,
            patch.object(
                feature_flag,
                "is_user_flagged_to_python",
                new=AsyncMock(return_value=True),
            ),
            patch.object(executor, "execute_start", new=AsyncMock()) as execute_start,
            patch.object(executor, "execute_continue", new=AsyncMock()) as execute_continue,
        ):
            await poller._tick(live_settings)
            release.assert_awaited_once_with(db._pool, job.id)
            execute_start.assert_not_called()
            execute_continue.assert_not_called()
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
                "is_user_flagged_to_python",
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
            mark_done.assert_awaited_once_with(db._pool, job.id)
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
                "is_user_flagged_to_python",
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
            mark_done.assert_awaited_once_with(db._pool, job.id)
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
                "is_user_flagged_to_python",
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
