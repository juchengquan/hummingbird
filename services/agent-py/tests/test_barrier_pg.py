"""The join barrier on a real Postgres (migration 0045): the cases
`test_barrier.py` pinned on a fake connection while the worker did the
decrement."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from agent_py.barrier import settle_task_terminal

from .task_world import World, ask, open_world, pg_only, spawn

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def fanned_out(world: World, n: int) -> tuple[str, list[str]]:
    names = [f"child-{i}" for i in range(n)]
    world.model.script("Do it", [spawn("s", *names)])
    for name in names:
        world.model.script(name, [ask(f"q-{name}")])
    parent = await world.start()
    await world.work()
    return parent, await world.children(parent)


async def test_transition_decrement_and_reenqueue_at_zero(world: World) -> None:
    parent, [child] = await fanned_out(world, 1)
    result = await settle_task_terminal(
        world.pool, task_id=child, user_id=world.user, status="done"
    )
    assert result.transitioned and result.parent_task_id == parent
    assert (await world.task(parent))["pending_children"] == 0
    assert len(await world.jobs(parent, "continue")) == 1


async def test_decrement_but_not_reenqueue_when_children_remain(world: World) -> None:
    parent, children = await fanned_out(world, 3)
    await settle_task_terminal(world.pool, task_id=children[0], user_id=world.user, status="failed")
    assert (await world.task(parent))["pending_children"] == 2
    assert await world.jobs(parent, "continue") == []


async def test_already_terminal_decrements_nothing_more(world: World) -> None:
    parent, children = await fanned_out(world, 2)
    for _ in range(3):
        await settle_task_terminal(
            world.pool, task_id=children[0], user_id=world.user, status="done"
        )
    assert (await world.task(parent))["pending_children"] == 1


async def test_zero_counter_but_parent_cancelled_does_not_reenqueue(world: World) -> None:
    parent, [child] = await fanned_out(world, 1)
    await world.sql("UPDATE public.tasks SET status = 'cancelled' WHERE id = $1", uuid.UUID(parent))
    result = await settle_task_terminal(
        world.pool, task_id=child, user_id=world.user, status="done"
    )
    assert not result.transitioned  # it went with its parent
    assert await world.jobs(parent, "continue") == []
