"""Poller shutdown + liveness.

- SIGTERM starts the poller's graceful stop at once (chained ahead of
  the server's own handler) — uvicorn only runs the lifespan shutdown
  after open SSE streams close, by which time Docker has SIGKILLed us.
- A stray `CancelledError` leaked by a library doesn't kill the loop
  (only a real `task.cancel()` does); inside a job it fails the job.
- `/readyz` reports the loop's liveness.
"""

from __future__ import annotations

import asyncio
import signal
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from agent_py import executor, jobs, main, poller, store
from agent_py.settings import Settings

from .test_job_lease import _job, _live_settings


def _settings() -> Settings:
    return Settings(
        SUPABASE_DB_URL="postgresql://localhost/fake",
        WORKER_DRY_RUN=True,
        POLL_INTERVAL_SECONDS=0.001,
    )


# --- signal hook ------------------------------------------------------------


@pytest.mark.asyncio
async def test_sigterm_begins_the_poller_stop_then_chains_the_server_handler() -> None:
    calls: list[str] = []
    began = asyncio.Event()

    def server_handler(signum: int, _frame: Any) -> None:
        calls.append(f"server:{signum}")

    def begin() -> None:
        calls.append("begin")
        began.set()

    original = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, server_handler)
    try:
        restore = main.install_shutdown_signal_hook(begin)
        signal.raise_signal(signal.SIGTERM)
        await asyncio.wait_for(began.wait(), timeout=1)
        assert calls == [f"server:{int(signal.SIGTERM)}", "begin"]
        restore()
        assert signal.getsignal(signal.SIGTERM) is server_handler
    finally:
        signal.signal(signal.SIGTERM, original)


# --- stray CancelledError ---------------------------------------------------


@pytest.mark.asyncio
async def test_stray_cancelled_error_does_not_kill_the_loop() -> None:
    ticks = 0

    async def flaky_tick(_settings: Settings) -> None:
        nonlocal ticks
        ticks += 1
        if ticks == 1:
            raise asyncio.CancelledError()  # leaked, nobody cancelled us

    with patch.object(poller, "_tick", new=flaky_tick):
        n = await poller.run_poll_loop(_settings(), stop_after_iterations=3)
    assert n == 3 and ticks == 3


@pytest.mark.asyncio
async def test_real_cancel_still_stops_the_loop() -> None:
    started = asyncio.Event()

    async def hang(_settings: Settings) -> None:
        started.set()
        await asyncio.sleep(60)

    with patch.object(poller, "_tick", new=hang):
        task = asyncio.create_task(poller.run_poll_loop(_settings()))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.asyncio
async def test_stray_cancelled_error_inside_a_job_fails_it_instead_of_handing_back() -> None:
    with (
        patch.object(store, "load_owned_task_status", new=AsyncMock(return_value="queued")),
        patch.object(
            executor, "execute_start", new=AsyncMock(side_effect=asyncio.CancelledError())
        ),
        patch.object(jobs, "hand_back_job", new=AsyncMock()) as hand_back,
        patch.object(jobs, "mark_job_failed", new=AsyncMock(return_value=True)) as failed,
        patch.object(executor, "settle_stranded_task", new=AsyncMock(return_value=True)) as st,
    ):
        await poller._execute_claimed(MagicMock(), _job(), _live_settings())
    hand_back.assert_not_called()
    failed.assert_awaited_once()
    st.assert_awaited_once()


# --- liveness ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_liveness_tracks_the_registered_task() -> None:
    poller.register_loop_task(None)
    assert poller.liveness() == (None, None)
    try:
        task = asyncio.create_task(poller.run_poll_loop(_settings(), stop_after_iterations=1))
        poller.register_loop_task(task)
        assert poller.liveness()[0] is True
        await task
        alive, age = poller.liveness()
        assert alive is False
        assert age is not None and age >= 0
    finally:
        poller.register_loop_task(None)


def test_readyz_degraded_when_the_poller_died(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(poller, "liveness", lambda: (False, 12.0))
    client = TestClient(main.create_app(enable_poller=False))
    body = client.get("/readyz").json()
    assert body["status"] == "degraded"
    assert body["checks"]["poller_alive"] is False
    assert body["checks"]["poller_last_tick_age_seconds"] == 12.0
