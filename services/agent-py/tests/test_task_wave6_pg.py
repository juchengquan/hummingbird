"""Wave 6-B: the background executor on a real Postgres.

Real poller, executor, Anthropic provider, SQL and `/v1/runs` routes over
a scripted model (`task_world`). Each test names the brief item it proves.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from .task_world import World, open_world, pg_only, say, spawn

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


# --- tasks.outcome at every background settle (survey bug 7) ---------------------------


async def test_a_done_task_writes_its_result_into_the_outcome(world: World) -> None:
    world.model.script("Do it", [say("It is blue.")])
    task = await world.start()
    await world.work()

    row = await world.task(task)
    assert row["status"] == "done"
    assert row["outcome"] == {"type": "success", "result": {"text": "It is blue."}}
    assert (await world.run(task))["result"] == {"text": "It is blue."}


async def test_a_failed_task_writes_its_error_into_the_outcome(world: World) -> None:
    world.key = False  # no ANTHROPIC_API_KEY: the run fails before the model (Q55)
    task = await world.start()
    await world.work()

    row = await world.task(task)
    assert row["status"] == "failed"
    assert row["outcome"]["type"] == "error"
    assert row["outcome"]["code"] == "unavailable"
    assert "ANTHROPIC_API_KEY" in row["outcome"]["message"]


async def test_a_cancelled_task_has_the_cancelled_outcome(world: World) -> None:
    world.model.script("Do it", [say("never")])
    task = await world.start()
    await world.cancel(task)
    await world.work()

    row = await world.task(task)
    assert row["status"] == "cancelled"
    assert row["outcome"] == {"type": "cancelled"}


async def test_a_sub_agent_run_settled_by_the_worker_has_its_outcome(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-a")], [say("Parent done.")])
    world.model.script("child-a", [say("child answer")])
    parent = await world.start()
    await world.work()

    [child] = await world.children(parent)
    assert (await world.task(child))["outcome"] == {
        "type": "success",
        "result": {"text": "child answer"},
    }
