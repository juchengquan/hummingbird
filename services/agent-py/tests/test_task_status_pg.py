"""Wave 5c — status, cancel and the barrier (Q60: B1, B2, B4, B16, B18,
B35, B39), on a real Postgres with a scripted model."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from .task_world import (
    READ,
    SEND,
    Reply,
    World,
    ask,
    open_world,
    pg_only,
    result_of,
    say,
    spawn,
    sqlstate_of,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def test_a_run_reads_running_while_it_executes(world: World) -> None:
    seen: list[str] = []
    ids: list[str] = []

    async def look() -> None:
        seen.append((await world.run(ids[0]))["status"])

    world.model.script("Do it", Reply([say("ok")], before=look))
    ids.append(await world.start())
    assert (await world.run(ids[0]))["status"] == "queued"
    await world.work()
    assert seen == ["running"]


async def test_a_child_reads_running_while_it_executes(world: World) -> None:
    seen: list[str] = []
    parents: list[str] = []

    async def look() -> None:
        [child] = await world.children(parents[0])
        seen.append(await world.status(child))

    world.model.script("Do it", [spawn("s", "child")])
    world.model.script("child", Reply([say("ok")], before=look))
    parents.append(await world.start())
    await world.work()
    assert seen == ["running"]


ENDINGS = {
    "pause": [use("q", SEND)],
    "done": [say("all done")],
    "spawn": [spawn("s", "child")],
    "tool": [use("r", READ)],
}


@pytest.mark.parametrize("ending", list(ENDINGS))
@pytest.mark.parametrize("via", ["next", "runs"])
async def test_a_cancel_during_the_model_call_is_final(world: World, ending: str, via: str) -> None:
    ids: list[str] = []

    async def cancel() -> None:
        await (world.cancel(ids[0]) if via == "next" else world.cancel_run(ids[0]))

    world.model.script("Do it", Reply(ENDINGS[ending], before=cancel))
    ids.append(await world.start())
    await world.work()
    task = ids[0]
    assert await world.status(task) == "cancelled"
    run = await world.run(task)
    assert run["status"] == "cancelled" and run["openInterrupts"] == []
    assert await world.children(task) == []
    assert world.count(READ) == 0, "a tool ran after the cancel"
    asked = [e for e in await world.events(task, "approval") if e["phase"] == "request"]
    assert asked == [], "a lost pause left an answerable question"
    assert await sqlstate_of(world.respond(task, "q", approved=True)) == "55000"
    assert not [e for e in await world.events(task, "result") if e["status"] == "done"]


async def test_a_cancel_during_a_yield_is_final(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    ids: list[str] = []

    async def cancel_later() -> None:
        await asyncio.sleep(0.15)

    async def cancel_in_tool(_name: str) -> None:
        await world.cancel(ids[0])

    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", "0.05")
    world.on_effect = cancel_in_tool
    world.model.script("Do it", Reply([use("r", READ)], before=cancel_later))
    ids.append(await world.start())
    await world.work()
    assert await world.status(ids[0]) == "cancelled"
    assert await world.jobs(ids[0], "continue") == []


async def test_a_cancel_during_the_approved_tool_is_final(world: World) -> None:
    ids: list[str] = []

    async def cancel(_name: str) -> None:
        await world.cancel(ids[0])

    world.model.script("Do it", [use("q", SEND)], [use("q2", SEND)])
    ids.append(await world.start())
    await world.work()
    world.on_effect = cancel
    await world.respond(ids[0], "q", approved=True)
    await world.work()
    assert await world.status(ids[0]) == "cancelled"
    assert len(world.model.calls) == 1


async def test_no_worker_write_revives_a_cancelled_row(world: World) -> None:
    task = await world.start()
    await world.cancel(task)

    async def revive() -> None:
        await world.sql("UPDATE public.tasks SET status = 'paused' WHERE id = $1", uuid.UUID(task))

    assert await sqlstate_of(revive()) == "55000"
    assert await world.status(task) == "cancelled"


async def chain(world: World) -> list[str]:
    """root <- middle <- leaf, all paused on their questions."""
    world.model.script("Do it", [ask("q0")], [ask("q1")], [ask("q2")])
    ids = [await world.start()]
    await world.work()
    for i in range(2):
        response, next_run = await world.resume(ids[-1], {f"q{i}": {"value": "v"}})
        assert response.status_code == 202
        ids.append(next_run)
        await world.work()
    return ids


@pytest.mark.parametrize("at", [0, 1, 2])
@pytest.mark.parametrize("via", ["next", "runs"])
async def test_cancel_from_any_row_is_the_whole_task(world: World, at: int, via: str) -> None:
    ids = await chain(world)
    await (world.cancel(ids[at]) if via == "next" else world.cancel_run(ids[at]))
    assert [await world.status(i) for i in ids] == ["cancelled"] * 3
    response, _ = await world.resume(ids[2], {"q2": {"value": "late"}})
    assert response.status_code == 409


@pytest.mark.parametrize("via", ["next", "runs"])
async def test_cancel_of_an_answered_row_stops_the_resume_and_its_children(
    world: World, via: str
) -> None:
    world.model.script("Do it", [ask("q")], [spawn("s", "a", "b")])
    world.model.script("a", [ask("qa")])
    root = await world.start()
    await world.work()
    _, resume = await world.resume(root, {"q": {"value": "go"}})
    await world.work()
    children = await world.children(resume)
    assert len(children) == 2
    await (world.cancel(root) if via == "next" else world.cancel_run(root))
    await world.work()
    assert await world.status(root) == "cancelled"
    assert await world.status(resume) == "cancelled"
    assert sorted([await world.status(c) for c in children]) == ["cancelled", "done"]


async def test_cancelling_an_unapplied_resume_never_reopens_the_question(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    root = await world.start()
    await world.work()
    _, resume = await world.resume(root, {"q": {"value": "go"}})
    await world.cancel(resume)
    assert await world.status(root) == "cancelled"
    response, _ = await world.resume(root, {"q": {"value": "again"}})
    assert response.status_code == 409
    assert await sqlstate_of(world.respond(root, "q", value="again")) == "55000"


async def end_child(world: World, child: str, how: str) -> None:
    if how == "cancel":
        await world.cancel(child)
    elif how == "runs_cancel":
        await world.cancel_run(child)
    elif how == "old_next_cancel":
        await world.cancel_old_next(child)
    elif how == "owner_update":
        async with world.as_user() as conn:
            await conn.execute(
                "UPDATE public.tasks SET status = 'failed', finished_at = now() WHERE id = $1",
                uuid.UUID(child),
            )
    else:
        async with world.as_user() as conn:
            await conn.execute("DELETE FROM public.tasks WHERE id = $1", uuid.UUID(child))


@pytest.mark.parametrize(
    "how", ["cancel", "runs_cancel", "old_next_cancel", "owner_update", "delete"]
)
async def test_however_a_child_ends_the_parent_continues_once(world: World, how: str) -> None:
    world.model.script("Do it", [spawn("s", "asks", "works")])
    world.model.script("asks", [ask("q")])
    task = await world.start()
    await world.work()
    assert await world.status(task) == "paused"
    asks, works = await world.children(task)
    assert await world.status(works) == "done"
    assert (await world.task(task))["pending_children"] == 1
    await end_child(world, asks, how)
    assert (await world.task(task))["pending_children"] == 0
    assert len(await world.jobs(task, "continue")) == 1
    if how != "delete":
        await world.sql("UPDATE public.tasks SET updated_at = now() WHERE id = $1", uuid.UUID(asks))
        assert (await world.task(task))["pending_children"] == 0
    await world.work()
    assert await world.status(task) == "done"
    said = result_of(world.model.last(), "s")["content"]
    assert "done: works" in said
    if how != "owner_update":
        assert "skipped" in said


async def test_a_reconciled_child_decrements(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    task = await world.start()
    await world.tick()
    [child] = await world.children(task)
    async with world.as_user() as conn:  # `appendSyntheticResult`
        await conn.execute(
            "UPDATE public.tasks SET status = 'failed', finished_at = now() "
            "WHERE id = $1 AND status IN ('queued', 'running')",
            uuid.UUID(child),
        )
    await world.work()
    assert await world.status(task) == "done"


async def test_create_run_rechecks_the_pause_under_its_lock(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    root = await world.start()
    await world.work()
    checkpoint = (await world.task(root))["checkpoint"]
    await world.cancel(root)

    async def create() -> None:
        import json

        body = {
            "messages": checkpoint["messages"],
            "config": checkpoint["config"],
            "resume": {"answers": [{"interruptId": "q", "status": "cancelled"}]},
        }
        async with world.as_user() as conn:
            await conn.execute(
                "SELECT * FROM public.create_run($1, $2, 'background', 'g', $3, 5, $4::jsonb)",
                uuid.uuid4(),
                uuid.UUID(world.thread),
                uuid.UUID(root),
                json.dumps(body),
            )

    assert await sqlstate_of(create()) == "55000"


async def test_cancel_racing_resume_leaves_nothing_live(world: World) -> None:
    import asyncio

    world.model.script("Do it", [ask("q")])
    for _ in range(12):
        root = await world.start()
        await world.work()
        (response, resume), _ = await asyncio.gather(
            world.resume(root, {"q": {"value": "x"}}), world.cancel_run(root)
        )
        assert await world.status(root) == "cancelled"
        if response.status_code == 202:
            assert await world.status(resume) == "cancelled"
        else:
            assert response.status_code == 409


async def fill_queue(world: World) -> None:
    for _ in range(20):
        await world.start()


async def test_a_failed_enqueue_leaves_no_orphan(world: World) -> None:
    await fill_queue(world)
    response, run = await world.post_run({"mode": "background"})
    assert response.status_code == 409 and response.json()["code"] == "limit_reached"
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []


async def test_a_failed_enqueue_does_not_hold_the_resume_slot(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    root = await world.start()
    await world.work()
    await fill_queue(world)
    response, run = await world.resume(root, {"q": {"value": "x"}})
    assert response.status_code == 409 and response.json()["code"] == "limit_reached"
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []
    await world.sql(
        "UPDATE public.task_jobs SET status = 'done' WHERE user_id = $1 AND status = 'queued'",
        uuid.UUID(world.user),
    )
    response, _ = await world.resume(root, {"q": {"value": "x"}})
    assert response.status_code == 202, response.text


async def test_an_interrupted_background_run_reports_finished_at(world: World) -> None:
    world.model.script("Do it", [ask("q")], [spawn("s", "child")])
    world.model.script("child", [ask("inner")])
    task = await world.start()
    await world.work()
    run = await world.run(task)
    assert run["status"] == "interrupted" and run["finishedAt"] is not None
    await world.respond(task, "q", value="x")
    await world.work()
    waiting = await world.run(task)
    assert waiting["status"] == "running" and waiting["finishedAt"] is None
