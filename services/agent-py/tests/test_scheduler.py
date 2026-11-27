"""The schedule dispatcher loop (`agent_py.scheduler`) + its lifespan
wiring and `/readyz` liveness."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from agent_py import db, main, poller, scheduler, schedules
from agent_py.settings import Settings


def _settings(**kw: Any) -> Settings:
    return Settings(SCHEDULER_INTERVAL_SECONDS=0.001, **kw)


async def test_tick_without_a_pool_is_a_no_op() -> None:
    with patch.object(schedules, "dispatch_due_schedules", new=AsyncMock()) as dispatch:
        assert await scheduler.tick() == 0
    dispatch.assert_not_called()


async def test_tick_dispatches_with_the_pg_store() -> None:
    sentinel = object()
    with (
        patch.object(db, "has_pool", return_value=True),
        patch.object(db, "get_pool", return_value=sentinel),
        patch.object(schedules, "dispatch_due_schedules", new=AsyncMock(return_value=3)) as d,
    ):
        assert await scheduler.tick() == 3
    store = d.await_args.args[0]
    assert isinstance(store, schedules.PgScheduleStore)
    assert store._pool is sentinel


async def test_loop_survives_a_failing_tick() -> None:
    calls = 0

    async def flaky() -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("connection refused")
        return 0

    with patch.object(scheduler, "tick", new=flaky):
        n = await scheduler.run_scheduler_loop(_settings(), stop_after_iterations=3)
    assert n == 3 and calls == 3


async def test_stray_cancelled_error_does_not_kill_the_loop() -> None:
    calls = 0

    async def leaky() -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise asyncio.CancelledError()
        return 0

    with patch.object(scheduler, "tick", new=leaky):
        assert await scheduler.run_scheduler_loop(_settings(), stop_after_iterations=2) == 2


async def test_stop_event_ends_the_loop_after_the_current_tick() -> None:
    stop = asyncio.Event()
    ticks = 0

    async def one() -> int:
        nonlocal ticks
        ticks += 1
        stop.set()
        return 0

    with patch.object(scheduler, "tick", new=one):
        await asyncio.wait_for(
            scheduler.run_scheduler_loop(Settings(SCHEDULER_INTERVAL_SECONDS=3600), stop=stop),
            timeout=2,
        )
    assert ticks == 1


async def test_real_cancel_stops_the_loop() -> None:
    started = asyncio.Event()

    async def hang() -> int:
        started.set()
        await asyncio.sleep(60)
        return 0

    with patch.object(scheduler, "tick", new=hang):
        task = asyncio.create_task(scheduler.run_scheduler_loop(_settings()))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_liveness_tracks_the_registered_task() -> None:
    scheduler.register_loop_task(None)
    assert scheduler.liveness() == (None, None)
    try:
        with patch.object(scheduler, "tick", new=AsyncMock(return_value=0)):
            task = asyncio.create_task(
                scheduler.run_scheduler_loop(_settings(), stop_after_iterations=1)
            )
            scheduler.register_loop_task(task)
            assert scheduler.liveness()[0] is True
            await task
        alive, age = scheduler.liveness()
        assert alive is False and age is not None
    finally:
        scheduler.register_loop_task(None)


def test_readyz_degraded_when_the_scheduler_died(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler, "liveness", lambda: (False, 7.0))
    body = TestClient(main.create_app(enable_poller=False)).get("/readyz").json()
    assert body["status"] == "degraded"
    assert body["checks"]["scheduler_alive"] is False
    assert body["checks"]["scheduler_last_tick_age_seconds"] == 7.0


def _run_lifespan(monkeypatch: pytest.MonkeyPatch, **env: str) -> dict[str, Any]:
    """Boot + shut down the app with fake loops; report what started."""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    seen: dict[str, Any] = {"poller": False, "scheduler": False}

    async def fake_poll(settings: Settings, *, stop: asyncio.Event, **_: Any) -> int:
        seen["poller"] = True
        await stop.wait()
        return 0

    async def fake_sched(settings: Settings, *, stop: asyncio.Event, **_: Any) -> int:
        seen["scheduler"] = True
        seen["interval"] = settings.SCHEDULER_INTERVAL_SECONDS
        seen["alive_during"] = scheduler.liveness()[0]
        await stop.wait()
        seen["stopped"] = True
        return 0

    monkeypatch.setattr(poller, "run_poll_loop", fake_poll)
    monkeypatch.setattr(scheduler, "run_scheduler_loop", fake_sched)
    monkeypatch.setattr(db, "init_pool", AsyncMock())
    monkeypatch.setattr(db, "close_pool", AsyncMock())
    with TestClient(main.create_app()) as client:
        client.get("/healthz")
    seen["alive_after"] = scheduler.liveness()[0]
    return seen


def test_lifespan_starts_the_scheduler_only_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A dry-run worker (the default): no scheduler either.
    monkeypatch.delenv("SCHEDULER_ENABLED", raising=False)
    monkeypatch.delenv("WORKER_DRY_RUN", raising=False)
    seen = _run_lifespan(monkeypatch, SUPABASE_DB_URL="postgresql://localhost/fake")
    assert seen["poller"] is True and seen["scheduler"] is False


def test_lifespan_starts_the_scheduler_where_the_worker_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Q130: unset, the scheduler follows the worker — live worker + a
    database → the loop runs, no `SCHEDULER_ENABLED` needed."""
    monkeypatch.delenv("SCHEDULER_ENABLED", raising=False)
    seen = _run_lifespan(
        monkeypatch, SUPABASE_DB_URL="postgresql://localhost/fake", WORKER_DRY_RUN="false"
    )
    assert seen["poller"] is True and seen["scheduler"] is True


def test_lifespan_explicit_false_keeps_the_scheduler_off_beside_a_live_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = _run_lifespan(
        monkeypatch,
        SUPABASE_DB_URL="postgresql://localhost/fake",
        WORKER_DRY_RUN="false",
        SCHEDULER_ENABLED="false",
    )
    assert seen["poller"] is True and seen["scheduler"] is False


def test_lifespan_runs_and_stops_the_enabled_scheduler(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _run_lifespan(
        monkeypatch,
        SUPABASE_DB_URL="postgresql://localhost/fake",
        SCHEDULER_ENABLED="true",
        SCHEDULER_INTERVAL_SECONDS="30",
    )
    assert seen["scheduler"] is True and seen["interval"] == 30.0
    assert seen["alive_during"] is True
    assert seen["stopped"] is True
    assert seen["alive_after"] is None


def test_lifespan_skips_the_scheduler_without_a_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    seen = _run_lifespan(monkeypatch, SUPABASE_DB_URL="", SCHEDULER_ENABLED="true")
    assert seen["scheduler"] is False


def test_scheduler_settings_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("SCHEDULER_ENABLED", "WORKER_DRY_RUN", "SUPABASE_DB_URL"):
        monkeypatch.delenv(key, raising=False)
    s = Settings(_env_file=None)
    assert s.SCHEDULER_ENABLED is False
    assert s.SCHEDULER_INTERVAL_SECONDS == 60.0


DSN = "postgresql://localhost/fake"


@pytest.mark.parametrize(
    ("dry_run", "dsn", "expected"),
    [
        (False, DSN, True),  # a live worker with a database: on
        (True, DSN, False),  # a dry-run worker executes nothing: off
        (False, "", False),  # no database: nothing to dispatch
        (True, "", False),
    ],
)
def test_unset_the_scheduler_follows_the_worker(
    monkeypatch: pytest.MonkeyPatch, dry_run: bool, dsn: str, expected: bool
) -> None:
    """Q130: the default is where the worker runs."""
    monkeypatch.delenv("SCHEDULER_ENABLED", raising=False)
    s = Settings(_env_file=None, WORKER_DRY_RUN=dry_run, SUPABASE_DB_URL=dsn)
    assert s.SCHEDULER_ENABLED is expected


@pytest.mark.parametrize(
    ("raw", "dry_run", "expected"),
    [
        ("false", False, False),  # an explicit false wins over a live worker
        ("true", True, True),  # …and an explicit true over a dry-run one
        ("", False, True),  # empty (a compose `${VAR:-}`) is unset
        ("", True, False),
    ],
)
def test_an_explicit_setting_wins(
    monkeypatch: pytest.MonkeyPatch, raw: str, dry_run: bool, expected: bool
) -> None:
    monkeypatch.setenv("SCHEDULER_ENABLED", raw)
    monkeypatch.setenv("WORKER_DRY_RUN", "true" if dry_run else "false")
    monkeypatch.setenv("SUPABASE_DB_URL", DSN)
    assert Settings(_env_file=None).SCHEDULER_ENABLED is expected
