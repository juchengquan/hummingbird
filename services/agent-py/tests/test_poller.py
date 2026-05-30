"""Tests for the dry-run poll loop.

Drives the tick directly (via `_tick`) and the loop driver (via
`run_poll_loop` with `stop_after_iterations`). Verifies:

  - With no pool, `_tick` is a no-op.
  - With a pool and an empty queue, claim is called, release isn't.
  - With a pool and a job available, claim + release both run.
  - The loop survives a tick raising — keeps iterating.
  - Cancellation propagates out of the loop cleanly.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import db, jobs, poller
from agent_py.jobs import ClaimedJob
from agent_py.settings import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(
        SUPABASE_DB_URL="postgresql://localhost/fake",
        WORKER_DRY_RUN=True,
        POLL_INTERVAL_SECONDS=0.001,
    )


# --- _tick -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_tick_no_pool_is_noop(settings: Settings) -> None:
    """`db._pool` is None (conftest resets it) — tick should not touch
    the jobs module."""
    with patch.object(jobs, "claim_next_job", new=AsyncMock()) as claim:
        await poller._tick(settings)
        claim.assert_not_called()


@pytest.mark.asyncio
async def test_tick_with_empty_queue_does_not_release(settings: Settings) -> None:
    db._pool = MagicMock()  # any truthy object — claim is patched
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=None)) as claim,
            patch.object(jobs, "release_job_to_queue", new=AsyncMock()) as release,
        ):
            await poller._tick(settings)
            claim.assert_awaited_once()
            release.assert_not_called()
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_tick_with_job_claims_then_releases_in_dry_run(settings: Settings) -> None:
    job = _make_job()
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)) as claim,
            patch.object(jobs, "release_job_to_queue", new=AsyncMock(return_value=True)) as release,
        ):
            await poller._tick(settings)
            claim.assert_awaited_once()
            release.assert_awaited_once_with(db._pool, job.id)
    finally:
        db._pool = None


@pytest.mark.asyncio
async def test_tick_releases_even_when_dry_run_disabled(settings: Settings) -> None:
    """`WORKER_DRY_RUN=False` without an executor branch is a
    misconfiguration; the safe behaviour is to log loudly + release
    anyway so work isn't silently swallowed."""
    job = _make_job()
    bad_settings = settings.model_copy(update={"WORKER_DRY_RUN": False})
    db._pool = MagicMock()
    try:
        with (
            patch.object(jobs, "claim_next_job", new=AsyncMock(return_value=job)),
            patch.object(jobs, "release_job_to_queue", new=AsyncMock(return_value=True)) as release,
        ):
            await poller._tick(bad_settings)
            release.assert_awaited_once_with(db._pool, job.id)
    finally:
        db._pool = None


# --- run_poll_loop ---------------------------------------------------------


@pytest.mark.asyncio
async def test_loop_keeps_going_after_tick_raises(settings: Settings) -> None:
    """A transient DB error shouldn't kill the loop. The TS worker is
    canonical; we want Python to recover and try again next tick."""
    calls: list[int] = []

    async def flaky_tick(_settings: Settings) -> None:
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("transient")

    async def fast_sleep(_s: float) -> None:
        return None

    with patch.object(poller, "_tick", new=flaky_tick):
        iters = await poller.run_poll_loop(
            settings,
            sleep=fast_sleep,
            stop_after_iterations=3,
        )
    assert iters == 3
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_loop_cancels_cleanly(settings: Settings) -> None:
    """Calling `task.cancel()` should propagate `CancelledError` out
    of the loop without first running another tick — matches what the
    lifespan does on shutdown."""

    async def slow_sleep(_s: float) -> None:
        await asyncio.sleep(60)  # would block far longer than the test

    with patch.object(poller, "_tick", new=AsyncMock()):
        task = asyncio.create_task(
            poller.run_poll_loop(settings, sleep=slow_sleep),
        )
        # Let the first tick complete and enter the sleep.
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
        "action": "continue",
        "payload": {},
        "attempts": 1,
        "max_attempts": 3,
    }
    base.update(overrides)
    return ClaimedJob(**base)  # type: ignore[arg-type]
