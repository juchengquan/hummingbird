"""Wave 5c — tasks checkpointed by the worker before 0045 finish correctly."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio

from .task_world import READ, SEND, WRITE, World, open_world, pg_only, result_of, spawn, use

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def old_row(
    world: World, task: str, status: str, checkpoint: dict[str, Any], pending: int = 0
) -> None:
    await world.sql(
        "UPDATE public.tasks SET status = $2, checkpoint = $3::jsonb, outcome = NULL, "
        "finished_at = NULL, pending_children = $4 WHERE id = $1",
        uuid.UUID(task),
        status,
        json.dumps(checkpoint),
        pending,
    )


async def test_an_old_pause_with_unanswered_siblings(world: World) -> None:
    world.model.script("Do it", [use("q", SEND, n=2)])
    task = await world.start()
    await world.work()
    checkpoint = (await world.task(task))["checkpoint"]
    checkpoint.pop("inflight_tools")
    checkpoint["messages"][-1]["content"] += [use("w", WRITE, n=1), use("r", READ)]
    await old_row(world, task, "paused", checkpoint)
    await world.respond(task, "q", approved=True)
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert (world.count(SEND), world.count(WRITE), world.count(READ)) == (1, 1, 1)


async def test_an_old_pause_whose_gate_is_gone_can_be_declined(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    checkpoint = (await world.task(task))["checkpoint"]
    checkpoint.pop("inflight_tools")
    await old_row(world, task, "paused", checkpoint)
    world.gated.clear()
    await world.respond(task, "q", approved=False)
    await world.work()
    assert await world.status(task) == "done" and world.count(SEND) == 0


async def test_an_old_half_answered_turn_is_completed(world: World) -> None:
    task = await world.start()
    checkpoint = {
        "messages": [
            {"role": "user", "content": "Do it"},
            {"role": "assistant", "content": [use("q", SEND), use("w", WRITE)]},
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "q", "content": "sent"}],
            },
        ],
        "step": 1,
        "seq": 4,
        "config": (await world.task(task))["checkpoint"]["config"],
    }
    await old_row(world, task, "running", checkpoint)
    await world.sql(
        "UPDATE public.task_jobs SET action = 'continue' WHERE task_id = $1", uuid.UUID(task)
    )
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert world.count(SEND) == 0 and world.count(WRITE) == 1


async def test_an_old_waiting_parent_with_siblings(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    task = await world.start()
    await world.tick()
    checkpoint = (await world.task(task))["checkpoint"]
    checkpoint.pop("inflight_tools")
    checkpoint["messages"][-1]["content"].append(use("w", WRITE))
    await old_row(world, task, "paused", checkpoint, pending=1)
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert "done: child" in result_of(world.model.last(), "s")["content"]
    assert world.count(WRITE) == 1
