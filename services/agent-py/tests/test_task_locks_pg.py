"""Wave 5c — one lock order, and no cross-user effect (0045, B35), on a
real Postgres."""

# ruff: noqa: B023
# (each raced action runs inside the iteration that defines it)

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from agent_py import store
from agent_py.barrier import settle_task_terminal

from .task_world import (
    DB_URL,
    SEND,
    World,
    ask,
    open_world,
    pg_only,
    seed_user,
    spawn,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


class Watch:
    """A pool that remembers every Postgres error, swallowed or not."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        self.errors: list[BaseException] = []

    def acquire(self, **kwargs: Any) -> Any:
        watch = self

        class Acquired:
            async def __aenter__(self) -> Any:
                self.inner = watch._pool.acquire(**kwargs)
                return await self.inner.__aenter__()

            async def __aexit__(self, *exc: Any) -> None:
                if isinstance(exc[1], asyncpg.PostgresError):
                    watch.errors.append(exc[1])
                await self.inner.__aexit__(*exc)

        return Acquired()


def locking_errors(errors: list[BaseException]) -> list[BaseException]:
    return [e for e in errors if getattr(e, "sqlstate", None) in ("40P01", "40001", "55P03")]


async def test_cancel_settle_respond_and_create_race_without_deadlock(world: World) -> None:
    """The four writers at once, on one tree, many times: no deadlock,
    every barrier exact."""
    names = ["asks-0", "asks-1", "works-2", "works-3"]
    world.model.script("Do it", [spawn("s", *names)])
    for name in names[:2]:
        world.model.script(name, [ask(f"q-{name}")])
    world.model.script("question", [ask("root-q")])
    watch = Watch(world.pool)
    for turn in range(30):
        await world.sql("DELETE FROM public.tasks WHERE user_id = $1", uuid.UUID(world.user))
        parent = await world.start()
        await world.work()
        asking = await world.start("question")
        await world.work()
        first, second, _, _ = await world.children(parent)

        async def owner_update() -> None:
            async with world.as_user() as conn:
                await conn.execute(
                    "UPDATE public.tasks SET status = 'failed' WHERE id = $1 "
                    "AND status IN ('queued', 'running', 'paused')",
                    uuid.UUID(second),
                )

        async def owner_delete() -> None:
            async with world.as_user() as conn:
                await conn.execute("DELETE FROM public.tasks WHERE id = $1", uuid.UUID(second))

        actions: list[Any] = [
            settle_task_terminal(watch, task_id=first, user_id=world.user, status="done"),
            settle_task_terminal(watch, task_id=second, user_id=world.user, status="failed"),
            world.cancel(first),
            world.respond(first, "q-asks-0", value="go"),
            world.resume(asking, {"root-q": {"value": "go"}}),
            owner_update() if turn % 2 else owner_delete(),
        ]
        if turn % 3 == 0:
            actions.append(world.cancel(parent))
        if turn % 3 == 1:
            actions += [world.cancel_run(asking), world.cancel_old_next(parent)]
        outcomes = await asyncio.gather(
            *actions, world.tick(watch), world.tick(watch), return_exceptions=True
        )
        errors = [o for o in outcomes if isinstance(o, BaseException)]
        unexpected = [
            e for e in errors if getattr(e, "sqlstate", None) not in ("55000", "P0002", "42501")
        ]
        assert unexpected == [], (turn, unexpected)
        assert locking_errors(watch.errors) == [], turn
        row = await world.task(parent)
        live = [
            c
            for c in await world.children(parent)
            if await world.status(c) in ("queued", "running", "paused")
        ]
        if row["status"] == "paused":
            assert row["pending_children"] == len(live), turn
        woken = await world.jobs(parent, "continue")
        assert len(woken) <= 1, (turn, "woken twice")
        if row["status"] == "paused" and not live:
            assert len(woken) == 1, (turn, "never woken")
        if row["status"] == "cancelled":
            assert live == [], (turn, "a child outlived its parent")


async def test_children_ending_together_wake_the_parent_once(world: World) -> None:
    names = [f"child-{i}" for i in range(5)]
    world.model.script("Do it", [spawn("s", *names)])
    for name in names:
        world.model.script(name, [ask(f"q-{name}")])
    for _ in range(20):
        await world.sql("DELETE FROM public.tasks WHERE user_id = $1", uuid.UUID(world.user))
        parent = await world.start()
        await world.work()
        a, b, c, d, e = await world.children(parent)
        await asyncio.gather(
            settle_task_terminal(world.pool, task_id=a, user_id=world.user, status="done"),
            settle_task_terminal(world.pool, task_id=b, user_id=world.user, status="failed"),
            world.cancel(c),
            world.cancel_run(d),
            world.cancel_old_next(e),
        )
        assert (await world.task(parent))["pending_children"] == 0
        assert len(await world.jobs(parent, "continue")) == 1


async def test_cancel_racing_spawn_leaves_nothing_live(world: World) -> None:
    world.model.script("Do it", [spawn("s", "one", "two", "three")])
    watch = Watch(world.pool)
    for turn in range(40):
        await world.sql("DELETE FROM public.tasks WHERE user_id = $1", uuid.UUID(world.user))
        parent = await world.start()

        async def cancel() -> None:
            await asyncio.sleep(0.001 * turn)
            await (world.cancel(parent) if turn % 2 else world.cancel_run(parent))

        await asyncio.gather(world.tick(watch), cancel())
        await world.work()
        if await world.status(parent) != "done":
            assert await world.status(parent) == "cancelled", turn
            for child in await world.children(parent):
                assert await world.status(child) in ("cancelled", "done"), turn
        assert locking_errors(watch.errors) == [], turn


@pytest.mark.parametrize("what", ["conversations", "workspaces"])
async def test_deleting_its_home_races_the_worker_without_deadlock(world: World, what: str) -> None:
    world.model.script("Do it", [spawn("s", "one", "two")])
    watch = Watch(world.pool)
    for turn in range(25):
        workspace, thread = uuid.uuid4(), uuid.uuid4()
        await world.sql(
            "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1, $2, 'ws')",
            workspace,
            uuid.UUID(world.user),
        )
        await world.sql(
            "INSERT INTO public.conversations (id, user_id, workspace_id, title) "
            "VALUES ($1, $2, $3, 'c')",
            thread,
            uuid.UUID(world.user),
            workspace,
        )
        world.thread = str(thread)
        doomed = thread if what == "conversations" else workspace
        await world.start()

        async def delete() -> None:
            await asyncio.sleep(0.002 * (turn % 9))
            async with world.as_user() as conn:
                await conn.execute(f"DELETE FROM public.{what} WHERE id = $1", doomed)

        await asyncio.gather(world.tick(watch), delete())
        await world.work()
        assert locking_errors(watch.errors) == [], turn


async def test_retries_of_one_resume_racing_are_one_run(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()
    body = {
        "threadId": world.thread,
        "runId": str(uuid.uuid4()),
        "messages": [{"id": "m", "role": "user", "content": "Do it"}],
        "forwardedProps": {"mode": "background", "previousRunId": task},
        "resume": [{"interruptId": "q", "status": "resolved", "payload": {"value": "x"}}],
    }
    responses = await asyncio.gather(
        *(world.http.post("/v1/runs", json=body, headers=world.headers()) for _ in range(4))
    )
    assert [r.status_code for r in responses] == [202] * 4, [r.text for r in responses]
    assert len(await world.jobs(body["runId"], "start")) == 1


# --- a second user ------------------------------------------------------------


@pytest_asyncio.fixture
async def other(world: World) -> AsyncIterator[str]:
    conn = await asyncpg.connect(DB_URL)
    try:
        user, _, _ = await seed_user(conn)
        yield user
        await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
    finally:
        await conn.close()


async def refused(world: World, user: str, sql: str, *args: Any) -> str:
    try:
        async with world.as_user(user) as conn:
            await conn.execute(sql, *args)
    except asyncpg.PostgresError as exc:
        return str(exc.sqlstate)
    return "accepted"


async def test_a_second_user_has_no_effect(world: World, other: str) -> None:
    world.model.script("Do it", [spawn("s", "asks")])
    world.model.script("asks", [use("q", SEND)])
    parent = await world.start()
    await world.work()
    [child] = await world.children(parent)
    before = [await world.task(parent), await world.task(child)]
    task = uuid.UUID(child)

    assert await refused(world, other, "SELECT public.cancel_task($1)", task) == "P0002"
    assert (
        await refused(world, other, "SELECT public.cancel_task($1)", uuid.UUID(parent)) == "P0002"
    )
    respond = "SELECT public.enqueue_task_job($1, 'respond', '{\"requestId\": \"q\"}')"
    assert await refused(world, other, respond, task) == "P0002"
    resume = (
        "SELECT * FROM public.create_run($1, $2, 'background', 'g', $3, 5, "
        '\'{"messages": [], "config": {}}\')'
    )
    assert (
        await refused(world, other, resume, uuid.uuid4(), uuid.UUID(world.thread), task)
    ) == "P0002"
    update = "UPDATE public.tasks SET status = 'cancelled' WHERE id = $1"
    assert await refused(world, other, update, task) == "accepted"  # RLS: zero rows
    assert await refused(world, other, "DELETE FROM public.tasks WHERE id = $1", task) == "accepted"
    response = await world.http.post(f"/v1/runs/{child}/cancel", headers=world.headers(other))
    assert response.status_code == 404
    assert [await world.task(parent), await world.task(child)] == before


async def test_a_second_user_cannot_take_the_owners_lock(world: World, other: str) -> None:
    task = await world.start()
    holder = await asyncpg.connect(DB_URL)
    try:
        async with holder.transaction():
            await holder.execute("SELECT private.lock_user_tasks($1)", uuid.UUID(world.user))
            # Refused before any lock: it neither waits on nor holds the owner's.
            state = await asyncio.wait_for(
                refused(world, other, "SELECT public.cancel_task($1)", uuid.UUID(task)), 3
            )
            assert state == "P0002"
    finally:
        await holder.close()
    state = await refused(world, other, "SELECT private.lock_user_tasks($1)", uuid.UUID(world.user))
    assert state == "42501"


async def test_a_trigger_never_crosses_users(world: World, other: str) -> None:
    """A row that names another user's task as parent / previous (only a
    privileged writer could make one) moves nothing of theirs."""
    world.model.script("Do it", [spawn("s", "asks")])
    world.model.script("asks", [ask("q")])
    parent = await world.start()
    await world.work()
    before = await world.task(parent)
    theirs = [uuid.uuid4(), uuid.uuid4()]
    [conversation] = await world.sql(
        "SELECT id FROM public.conversations WHERE user_id = $1", uuid.UUID(other)
    )
    for task, column in zip(theirs, ("parent_task_id", "previous_run_id"), strict=True):
        await world.sql(
            f"INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, {column}) "
            "VALUES ($1, $2, $3, 'x', 'running', $4)",
            task,
            uuid.UUID(other),
            conversation["id"],
            uuid.UUID(parent),
        )
        async with world.as_user(other) as conn:
            await conn.execute("SELECT public.cancel_task($1)", task)
        assert await world.task(parent) == before


async def test_functions_are_hardened(world: World) -> None:
    rows = await world.sql(
        "SELECT n.nspname, p.proname, p.prosecdef, p.proconfig, "
        "has_function_privilege('anon', p.oid, 'execute') AS anon, "
        "has_function_privilege('authenticated', p.oid, 'execute') AS authenticated, "
        "p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE p.proname = ANY($1::text[])",
        [
            "cancel_task",
            "create_run",
            "enqueue_task_job",
            "lock_user_tasks",
            "lock_task_scope",
            "fence_task_job",
            "task_waits_on",
            "question_held_by_resume",
            "question_held_by_respond",
            "cancel_task_tree",
            "settle_barrier",
            "tasks_lock_caller",
            "tasks_terminal_is_final",
            "tasks_ended",
            "tasks_deleted",
        ],
    )
    assert len(rows) == 15
    for row in rows:
        name = f"{row['nspname']}.{row['proname']}"
        assert row["proconfig"] == ['search_path=""'], name
        assert row["anon"] is False, name
        assert row["authenticated"] is (row["nspname"] == "public"), name
        if row["prosecdef"] and row["nspname"] == "public":
            assert "auth.uid()" in row["prosrc"], name


async def test_the_worker_fence_uses_the_one_order(world: World) -> None:
    """A job's fence waits for the user's lock before it takes a row."""
    task = await world.start()
    [job] = await world.jobs(task)
    holder = await asyncpg.connect(DB_URL)
    try:
        async with holder.transaction():
            await holder.execute("SELECT private.lock_user_tasks($1)", uuid.UUID(world.user))
            fenced = asyncio.create_task(
                world.sql("SELECT private.fence_task_job($1, 0)", job["id"])
            )
            await asyncio.sleep(0.2)
            assert not fenced.done()
            # It holds no row yet: the lock holder can still take them.
            await holder.execute("SET LOCAL lock_timeout = '2s'")
            await holder.fetchval(
                "SELECT id FROM public.tasks WHERE id = $1 FOR UPDATE", uuid.UUID(task)
            )
        await fenced
    finally:
        await holder.close()
    assert await store.load_owned_task_status(world.pool, task_id=task, user_id=world.user)
