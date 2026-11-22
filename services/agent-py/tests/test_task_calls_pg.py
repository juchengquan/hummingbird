"""Wave 5c — one result per call (B5, B8, B9, B23), on a real Postgres
with a scripted model that refuses an unpaired history."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from .task_world import (
    READ,
    SEND,
    WRITE,
    Reply,
    World,
    ask,
    open_world,
    pg_only,
    result_of,
    say,
    spawn,
    tool_results,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


def mixed() -> list[dict]:
    return [use("w", WRITE, n=1), use("q", SEND, n=2), use("r", READ, n=3)]


async def test_start_runs_the_ungated_siblings_and_saves_them_with_the_pause(world: World) -> None:
    world.model.script("Do it", mixed())
    task = await world.start()
    await world.work()
    assert await world.status(task) == "paused"
    assert (world.count(WRITE), world.count(READ), world.count(SEND)) == (1, 1, 0)
    saved = str((await world.task(task))["checkpoint"])
    assert "mcp__s1__write ok" in saved and "mcp__s1__read ok" in saved


@pytest.mark.parametrize("path", ["respond", "resume"])
async def test_every_call_gets_one_result_on_the_next_model_call(world: World, path: str) -> None:
    world.model.script("Do it", mixed())
    task = await world.start()
    await world.work()
    if path == "respond":
        await world.respond(task, "q", approved=True)
        leaf = task
    else:
        response, leaf = await world.resume(task, {"q": {"approved": True}})
        assert response.status_code == 202, response.text
    await world.work()
    assert world.model.problems == []
    assert await world.status(leaf) == "done"
    assert sorted(r["tool_use_id"] for r in tool_results(world.model.last())) == ["q", "r", "w"]
    assert (world.count(WRITE), world.count(READ), world.count(SEND)) == (1, 1, 1)


async def test_gated_calls_are_asked_one_after_another_by_respond(world: World) -> None:
    world.model.script("Do it", [use("q1", SEND, n=1), ask("q2"), use("q3", SEND, n=3)])
    task = await world.start()
    await world.work()
    answers = {"q1": {"approved": True}, "q2": {"value": "blue"}, "q3": {"approved": False}}
    for question, answer in answers.items():
        assert await world.status(task) == "paused"
        requested = await world.events(task, "approval")
        assert [e["approvalId"] for e in requested if e["phase"] == "request"][-1] == question
        run = await world.run(task)
        assert [i["id"] for i in run["openInterrupts"]] == [question]
        await world.respond(task, question, **answer)
        await world.work()
        if question != "q3":
            assert len(world.model.calls) == 1, "no model call between the questions"
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert result_of(world.model.last(), "q2")["content"] == "blue"
    assert world.count(SEND, n=1) == 1 and world.count(SEND, n=3) == 0


async def test_gated_calls_are_asked_one_after_another_by_resumes(world: World) -> None:
    world.model.script("Do it", [use("q1", SEND, n=1), use("w", WRITE), use("q2", SEND, n=2)])
    task = await world.start()
    await world.work()
    response, second = await world.resume(task, {"q1": {"approved": True}})
    assert response.status_code == 202, response.text
    await world.work()
    run = await world.run(second)
    assert run["status"] == "interrupted", run
    assert [i["id"] for i in run["openInterrupts"]] == ["q2"]
    assert len(world.model.calls) == 1
    response, third = await world.resume(second, {"q2": {"approved": True}})
    assert response.status_code == 202, response.text
    await world.work()
    assert await world.status(third) == "done"
    assert world.model.problems == []
    assert (world.count(SEND, n=1), world.count(SEND, n=2), world.count(WRITE)) == (1, 1, 1)


async def test_a_continue_keeps_the_rule(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    async def slow() -> None:
        await asyncio.sleep(0.15)

    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", "0.05")
    world.model.script("Do it", Reply([use("first", READ)], before=slow), mixed())
    task = await world.start()
    await world.work()
    assert await world.jobs(task, "continue"), "the first chunk yielded"
    assert await world.status(task) == "paused"
    assert world.count(WRITE) == 1
    await world.respond(task, "q", approved=True)
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []


async def test_ungated_calls_run_once_across_a_crash_while_paused_turn_runs(world: World) -> None:
    class Died(BaseException):
        pass

    died = False

    async def die(name: str) -> None:
        nonlocal died
        if name == READ and not died:
            died = True
            raise Died

    world.on_effect = die
    world.model.script("Do it", [use("w", WRITE), use("r", READ), use("q", SEND)])
    task = await world.start()
    with pytest.raises(Died):
        await world.tick()
    await world.expire_leases()
    await world.work()
    assert await world.status(task) == "paused"
    assert world.count(WRITE) == 1
    await world.respond(task, "q", approved=True)
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert len(world.model.calls) == 2, "the turn was never asked again"


async def test_a_spawn_beside_other_calls(world: World) -> None:
    world.model.script("Do it", [use("w", WRITE), spawn("s", "child"), use("q", SEND)])
    task = await world.start()
    await world.work()
    assert world.count(WRITE) == 1
    assert await world.status(task) == "paused"
    assert await world.children(task) == []  # the question comes first
    await world.respond(task, "q", approved=True)
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert "done: child" in result_of(world.model.last(), "s")["content"]
    assert world.count(SEND) == 1 and world.count(WRITE) == 1


async def test_two_spawns_in_one_turn(world: World) -> None:
    world.model.script("Do it", [spawn("s1", "first"), spawn("s2", "second")])
    task = await world.start()
    await world.work()
    assert await world.status(task) == "done"
    assert world.model.problems == []
    assert "done: second" not in result_of(world.model.last(), "s1")["content"]
    assert "done: second" in result_of(world.model.last(), "s2")["content"]


@pytest.mark.parametrize(("approved", "children"), [(False, 0), (True, 1)])
async def test_spawn_respects_require_approval_for(
    world: World, approved: bool, children: int
) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    task = await world.start(requireApprovalFor=["spawnSubagent"])
    await world.work()
    assert await world.status(task) == "paused"
    assert await world.children(task) == []
    await world.respond(task, "s", approved=approved)
    await world.work()
    assert len(await world.children(task)) == children
    assert await world.status(task) == "done"
    assert world.model.problems == []


@pytest.mark.parametrize(
    "args",
    [{}, {"tasks": []}, {"tasks": "x"}, {"tasks": [{"personaSlug": "p"}]}],
)
async def test_an_empty_or_malformed_spawn_is_an_error_result(world: World, args: dict) -> None:
    world.model.script("Do it", [use("s", "spawnSubagent", **args), use("w", WRITE)])
    task = await world.start()
    await world.work()
    assert await world.status(task) == "done"
    assert result_of(world.model.last(), "s").get("is_error") is True
    assert world.count(WRITE) == 1


async def test_a_respond_that_spawns_really_spawns(world: World) -> None:
    world.model.script("Do it", [ask("q")], [spawn("s", "child")], [say("finished")])
    task = await world.start()
    await world.work()
    await world.respond(task, "q", value="yes")
    await world.work()
    assert len(await world.children(task)) == 1
    assert await world.status(task) == "done"
    assert "done: child" in result_of(world.model.last(), "s")["content"]
    assert await world.events(task, "result")


async def test_a_later_spawn_round_gets_only_its_children(world: World) -> None:
    world.model.script("Do it", [spawn("s1", "alpha")], [spawn("s2", "beta")])
    task = await world.start()
    await world.work()
    assert await world.status(task) == "done"
    second = result_of(world.model.last(), "s2")["content"]
    assert "beta" in second and "alpha" not in second


async def test_a_childs_spawn_beside_another_call(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    world.model.script("child", [spawn("nested", "grandchild"), use("w", WRITE)])
    task = await world.start()
    await world.work()
    assert await world.status(task) == "done"
    [child] = await world.children(task)
    assert await world.children(child) == []
    assert world.count(WRITE) == 1 and world.model.problems == []
