"""Wave 6-B: the background executor on a real Postgres.

Real poller, executor, Anthropic provider, SQL and `/v1/runs` routes over
a scripted model (`task_world`). Each test names the brief item it proves.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from agent_py.resume_answers import DECLINED_ANSWER, DECLINED_APPROVAL
from agent_py.runs.in_place import respond_job_payload

from .task_world import SEND, World, ask, open_world, pg_only, result_of, say, spawn, use

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


# --- a cancelled in-place answer is a decline (brief item 7) -----------------------------


async def test_a_cancelled_in_place_answer_declines_a_childs_approval(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-send")], [say("Parent done.")])
    world.model.script("child-send", [use("c1", SEND, to="x")], [say("Did not send.")])
    parent = await world.start()
    await world.work()
    [child] = await world.children(parent)
    assert await world.status(child) == "paused"

    # What `POST /v1/runs/{child}/answers` queues for `{status: "cancelled"}`.
    await world.respond(
        child, "c1", **respond_job_payload({"interruptId": "c1", "status": "cancelled"})
    )
    await world.work()

    assert world.count(SEND) == 0
    assert await world.status(child) == "done"
    assert await world.status(parent) == "done"
    child_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "child-send"]
    assert result_of(child_calls[-1]["messages"], "c1")["content"] == DECLINED_APPROVAL
    [response] = [e for e in await world.events(child, "approval") if e["phase"] == "response"]
    assert response["approved"] is False


async def test_a_cancelled_in_place_answer_declines_a_childs_question(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child-ask")], [say("Parent done.")])
    world.model.script("child-ask", [ask("q1")], [say("No answer, moving on.")])
    parent = await world.start()
    await world.work()
    [child] = await world.children(parent)

    await world.respond(child, "q1", cancelled=True)
    await world.work()

    assert await world.status(parent) == "done"
    child_calls = [c for c in world.model.calls if c["messages"][0]["content"] == "child-ask"]
    assert result_of(child_calls[-1]["messages"], "q1")["content"] == DECLINED_ANSWER
