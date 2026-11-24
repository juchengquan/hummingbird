"""The runs-side no-worker reconciler (wave 6-A, survey bug 17), on a real
Postgres (`bun run test:db`).

The rule is Next's `reconcileStaleRuns` "never started" case
(`lib/server/agent/store.ts`): a background run still `queued`, with
nothing in its log past the `status: queued` entry, created more than
`TASK_NO_WORKER_TIMEOUT_MINUTES` ago, whose job no worker holds, is
failed "No task worker available" — but only when no worker executed
anything in that window (`task_worker_active_within`, migration 0040), so
a busy worker's backlog waits.

`task_worker_active_within` looks at every user's jobs, so these tests
use a window of a few seconds and wait it out first.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from agent_py import db as db_module
from agent_py.main import create_app

from .task_world import DB_URL, World, open_world, pg_only

pytestmark = [pg_only]

WINDOW_S = 2.0


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def backdate(world: World, task: str, seconds: float = 3600) -> None:
    await world.sql(
        "UPDATE public.tasks SET created_at = now() - make_interval(secs => $2), "
        "started_at = now() - make_interval(secs => $2) WHERE id = $1",
        uuid.UUID(task),
        float(seconds),
    )


async def quiet(world: World) -> None:
    """No worker activity inside the window: every job that ever ran ended
    more than the window ago."""
    await world.sql(
        "UPDATE public.task_jobs SET updated_at = now() - interval '1 hour' "
        "WHERE status IN ('done', 'failed') AND updated_at > now() - interval '1 hour'"
    )
    await world.sql(
        "UPDATE public.task_jobs SET lease_expires_at = now() - interval '1 hour' "
        "WHERE status = 'running'"
    )


async def reconcile(world: World) -> list[str]:
    from agent_py.runs.reconcile import reconcile_no_worker

    return await reconcile_no_worker(world.pool, timeout=timedelta(seconds=WINDOW_S))


@pytest.mark.asyncio
async def test_a_task_no_worker_picked_up_fails_no_worker(world: World) -> None:
    task = await world.start()
    young = await world.start("Young")
    await backdate(world, task)
    await quiet(world)
    assert await reconcile(world) == [task]

    run = await world.run(task)
    assert run["status"] == "failed"
    assert run["error"] == {
        "code": "no_worker",
        "message": (
            "No task worker available: this task was never picked up. Try again later, "
            "or contact the administrator if it keeps happening."
        ),
    }
    row = await world.task(task)
    assert row["outcome"]["code"] == "no_worker" and row["finished_at"] is not None
    # Its log ends with the failure, as Next's synthetic result does.
    [result] = await world.events(task, "result")
    assert (result["seq"], result["status"], result["errorCode"]) == (2, "failed", "no_worker")
    # A younger one waits; a second pass changes nothing.
    assert await world.status(young) == "queued"
    assert await reconcile(world) == []
    # It no longer counts against the 5-task cap.
    [count] = await world.sql("SELECT private.active_task_count($1) AS n", uuid.UUID(world.user))
    assert count["n"] == 1


@pytest.mark.asyncio
async def test_a_busy_workers_backlog_waits(world: World) -> None:
    busy = await world.start("Busy")
    waiting = await world.start("Waiting")
    await backdate(world, waiting)
    await quiet(world)
    # A worker holds another task's job right now (and has started it).
    await world.sql(
        "UPDATE public.task_jobs SET status = 'running', started_at = now(), "
        "lease_expires_at = now() + interval '1 minute' WHERE task_id = $1",
        uuid.UUID(busy),
    )
    await world.sql("UPDATE public.tasks SET status = 'running' WHERE id = $1", uuid.UUID(busy))
    assert await reconcile(world) == []
    assert await world.status(waiting) == "queued"

    # Or finished one inside the window.
    await world.sql(
        "UPDATE public.task_jobs SET status = 'done', lease_expires_at = NULL, "
        "updated_at = now() WHERE task_id = $1",
        uuid.UUID(busy),
    )
    assert await reconcile(world) == []
    assert await world.status(waiting) == "queued"

    # Once the window passes with nothing executed, it fails.
    await asyncio.sleep(WINDOW_S + 1.1)
    assert await reconcile(world) == [waiting]


@pytest.mark.asyncio
async def test_a_task_a_worker_holds_or_started_is_left_alone(world: World) -> None:
    held = await world.start("Held")
    started = await world.start("Started")
    for task in (held, started):
        await backdate(world, task)
    await quiet(world)
    # Its own job is leased: a worker is on it (a dry-run claim included).
    await world.sql(
        "UPDATE public.task_jobs SET status = 'running', "
        "lease_expires_at = now() + interval '1 minute' WHERE task_id = $1",
        uuid.UUID(held),
    )
    # A worker wrote past the queued entry: not a no-worker case.
    await world.sql(
        "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
        "VALUES ($1, $2, 2, 0, 'status', '{\"status\": \"running\"}'::jsonb)",
        uuid.UUID(started),
        uuid.UUID(world.user),
    )
    # Interactive runs have no worker.
    chat = str(uuid.uuid4())
    await world.sql(
        "INSERT INTO public.tasks (id, user_id, mode, thread_id, status, goal, created_at) "
        "VALUES ($1, $2, 'interactive', $3, 'queued', 'c', now() - interval '1 hour')",
        uuid.UUID(chat),
        uuid.UUID(world.user),
        uuid.UUID(world.thread),
    )
    await world.sql(
        "UPDATE public.task_jobs SET lease_expires_at = now() + interval '1 minute' "
        "WHERE task_id = $1",
        uuid.UUID(held),
    )
    assert await reconcile(world) == []
    assert [await world.status(t) for t in (held, started, chat)] == ["queued"] * 3


@pytest.mark.asyncio
async def test_a_cancel_racing_the_reconciler_wins_or_loses_cleanly(world: World) -> None:
    task = await world.start()
    await backdate(world, task)
    await quiet(world)
    reconciled, _ = await asyncio.gather(reconcile(world), world.cancel(task))
    status = await world.status(task)
    assert status in ("failed", "cancelled")
    assert (reconciled == [task]) == (status == "failed")
    results = await world.events(task, "result")
    assert len(results) == (1 if status == "failed" else 0)


def test_the_lifespan_runs_it_behind_its_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncpg

    from .task_world import seed_user

    async def make() -> tuple[str, str]:
        conn = await asyncpg.connect(DB_URL)
        try:
            user, _, thread = await seed_user(conn)
            task = uuid.uuid4()
            await conn.execute(
                "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
                "status, checkpoint, created_at) VALUES ($1, $2, 'background', $3, $3, 'g', "
                "'queued', '{\"messages\": [], \"config\": {}}'::jsonb, "
                "now() - interval '1 hour')",
                task,
                uuid.UUID(user),
                uuid.UUID(thread),
            )
            await conn.execute(
                "UPDATE public.task_jobs SET updated_at = now() - interval '1 hour' "
                "WHERE status IN ('done', 'failed') AND updated_at > now() - interval '1 hour'"
            )
            await conn.execute(
                "UPDATE public.task_jobs SET lease_expires_at = now() - interval '1 hour' "
                "WHERE status = 'running'"
            )
            return user, str(task)
        finally:
            await conn.close()

    async def status_of(task: str) -> str:
        conn = await asyncpg.connect(DB_URL)
        try:
            return str(
                await conn.fetchval(
                    "SELECT status FROM public.tasks WHERE id = $1", uuid.UUID(task)
                )
            )
        finally:
            await conn.close()

    async def drop(user: str) -> None:
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
        finally:
            await conn.close()

    def run_app(enabled: bool) -> str:
        user, task = asyncio.run(make())
        try:
            monkeypatch.setenv("SUPABASE_DB_URL", DB_URL)
            monkeypatch.setenv("WORKER_DRY_RUN", "true")
            monkeypatch.setenv("POLL_INTERVAL_SECONDS", "3600")
            monkeypatch.setenv("SCHEDULER_ENABLED", "false")
            monkeypatch.setenv("RUNS_RECONCILE_ENABLED", "true" if enabled else "false")
            monkeypatch.setenv("RUNS_RECONCILE_INTERVAL_SECONDS", "0.2")
            monkeypatch.setenv("TASK_NO_WORKER_TIMEOUT_MINUTES", str(WINDOW_S / 60))
            from agent_py import settings as settings_module

            settings_module.get_settings.cache_clear()
            with TestClient(create_app()):
                import time

                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline:
                    if asyncio.run(status_of(task)) != "queued":
                        break
                    time.sleep(0.1)
            return asyncio.run(status_of(task))
        finally:
            db_module._pool = None
            asyncio.run(drop(user))

    assert run_app(enabled=False) == "queued"
    assert run_app(enabled=True) == "failed"
