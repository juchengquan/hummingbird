"""Wave 5c — answers (Q57, Q58, Q59: B6, B7, B11, B12, B13, B17, B19),
on a real Postgres with a scripted model."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from .task_world import (
    SEND,
    WRITE,
    Reply,
    World,
    ask,
    open_world,
    pg_only,
    result_of,
    spawn,
    sqlstate_of,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def boom() -> None:
    raise RuntimeError("provider down")


async def test_an_applied_then_failed_resume_never_reopens_the_question(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)], Reply([], before=boom))
    task = await world.start()
    await world.work()
    response, resume = await world.resume(task, {"q": {"approved": True}})
    assert response.status_code == 202
    await world.work()
    assert await world.status(resume) == "failed" and world.count(SEND) == 1
    again, _ = await world.resume(task, {"q": {"approved": True}})
    assert again.status_code == 409, "the approved tool could be replayed"
    assert await sqlstate_of(world.respond(task, "q", approved=True)) == "55000"
    await world.work()
    assert world.count(SEND) == 1


async def test_a_doubtful_crash_counts_as_applied(world: World) -> None:
    class Died(BaseException):
        pass

    async def die(_name: str) -> None:
        raise Died

    world.on_effect = die
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    response, resume = await world.resume(task, {"q": {"approved": True}})
    assert response.status_code == 202
    with pytest.raises(Died):
        await world.tick()
    await world.sql(
        "UPDATE public.task_jobs SET attempts = max_attempts WHERE task_id = $1",
        uuid.UUID(resume),
    )
    await world.expire_leases()
    await world.tick()  # the reaper
    assert await world.status(resume) == "failed"
    again, _ = await world.resume(task, {"q": {"approved": True}})
    assert again.status_code == 409


@pytest.mark.parametrize("answer_again", ["resume", "respond"])
async def test_a_resume_that_failed_before_applying_frees_the_question(
    world: World, answer_again: str
) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    response, resume = await world.resume(task, {"q": {"approved": True}})
    assert response.status_code == 202
    world.key = False
    await world.work()
    assert await world.status(resume) == "failed"
    world.key = True
    if answer_again == "resume":
        response, leaf = await world.resume(task, {"q": {"approved": True}})
        assert response.status_code == 202, response.text
    else:
        await world.respond(task, "q", approved=True)
        leaf = task
    await world.work()
    assert await world.status(leaf) == "done"
    assert world.count(SEND) == 1


async def test_a_deleted_applied_resume_never_reopens_the_question(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)], Reply([], before=boom))
    task = await world.start()
    await world.work()
    _, resume = await world.resume(task, {"q": {"approved": True}})
    await world.work()
    async with world.as_user() as conn:
        await conn.execute("DELETE FROM public.tasks WHERE id = $1", uuid.UUID(resume))
    again, _ = await world.resume(task, {"q": {"approved": True}})
    assert again.status_code == 409
    assert await sqlstate_of(world.respond(task, "q", approved=True)) == "55000"


@pytest.mark.parametrize(
    "paths",
    [
        ("respond", "resume"),
        ("respond", "respond"),
        ("resume", "respond"),
        ("resume", "resume"),
        ("respond", "resume", "respond"),
        ("resume", "respond", "resume"),
    ],
)
async def test_every_mix_of_the_two_ways_works_per_question(
    world: World, paths: tuple[str, ...]
) -> None:
    world.model.script("Do it", *[[use(f"q{i}", SEND, n=i)] for i in range(len(paths))])
    leaf = await world.start()
    await world.work()
    for i, path in enumerate(paths):
        if path == "respond":
            await world.respond(leaf, f"q{i}", approved=True)
        else:
            response, next_run = await world.resume(leaf, {f"q{i}": {"approved": True}})
            assert response.status_code == 202, (i, response.text)
            leaf = next_run
        await world.work()
    assert await world.status(leaf) == "done"
    assert [a for n, a in world.effects if n == SEND] == [{"n": i} for i in range(len(paths))]


async def test_two_responds_to_one_question_have_one_winner(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    states = await asyncio.gather(
        *(sqlstate_of(world.respond(task, "q", approved=True)) for _ in range(5))
    )
    assert sorted(states, key=str) == sorted([None] + ["55000"] * 4, key=str)
    await world.work()
    assert world.count(SEND) == 1


async def test_a_respond_and_a_resume_racing_have_one_winner(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    state, (response, _) = await asyncio.gather(
        sqlstate_of(world.respond(task, "q", approved=True)),
        world.resume(task, {"q": {"approved": True}}),
    )
    assert (state is None) != (response.status_code == 202)
    await world.work()
    assert world.count(SEND) == 1


async def test_two_resumes_have_one_winner(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    results = await asyncio.gather(
        *(world.resume(task, {"q": {"approved": True}}) for _ in range(5))
    )
    assert sorted(r.status_code for r, _ in results) == [202, 409, 409, 409, 409]
    await world.work()
    assert world.count(SEND) == 1


async def test_an_answer_to_an_earlier_question_is_refused(world: World) -> None:
    world.model.script("Do it", [ask("q0")], [ask("q1")])
    task = await world.start()
    await world.work()
    await world.respond(task, "q0", value="a")
    await world.work()
    assert await world.status(task) == "paused"
    assert await sqlstate_of(world.respond(task, "q0", value="b")) == "55000"
    stale, _ = await world.resume(task, {"q0": {"value": "b"}})
    assert stale.status_code == 409


async def test_a_respond_job_that_failed_before_applying_does_not_poison(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    await world.respond(task, "q", approved=True)
    await world.sql(
        "UPDATE public.task_jobs SET status = 'failed' WHERE task_id = $1 AND action = 'respond'",
        uuid.UUID(task),
    )
    response, resume = await world.resume(task, {"q": {"approved": True}})
    assert response.status_code == 202, response.text
    await world.work()
    assert await world.status(resume) == "done"


async def test_a_respond_without_approved_never_approves(world: World) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    await world.respond(task, "q")
    await world.work()
    assert world.count(SEND) == 0
    assert await world.status(task) == "paused"
    await world.respond(task, "q", approved=True)
    await world.work()
    assert world.count(SEND) == 1


@pytest.mark.parametrize("approved", ["true", 1, None, {"yes": True}])
async def test_only_boolean_true_approves(world: World, approved: object) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    await world.respond(task, "q", approved=approved)
    await world.work()
    assert world.count(SEND) == 0


@pytest.mark.parametrize("change", ["ungated", "removed", "disallowed"])
@pytest.mark.parametrize("path", ["respond", "resume"])
async def test_decline_always_works(world: World, change: str, path: str) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    if change == "ungated":
        world.gated.clear()
    elif change == "removed":
        world.gone.add(SEND)
    else:
        await world.sql(
            "UPDATE public.tasks SET checkpoint = jsonb_set(checkpoint, "
            "'{config,allowedMcpServerIds}', '[]') WHERE id = $1",
            uuid.UUID(task),
        )
    if path == "respond":
        await world.respond(task, "q", approved=False)
        leaf = task
    else:
        response, leaf = await world.resume(task, {"q": {"approved": False}})
        assert response.status_code == 202
    await world.work()
    assert await world.status(leaf) == "done", await world.error(leaf)
    assert world.count(SEND) == 0
    assert "declined" in result_of(world.model.last(), "q")["content"]


@pytest.mark.parametrize("path", ["respond", "resume"])
async def test_an_approve_of_something_gone_never_strands(world: World, path: str) -> None:
    world.model.script("Do it", [use("q", SEND)])
    task = await world.start()
    await world.work()
    world.gone.add(SEND)
    if path == "respond":
        await world.respond(task, "q", approved=True)
        leaf = task
    else:
        response, leaf = await world.resume(task, {"q": {"approved": True}})
        assert response.status_code == 202
    await world.work()
    assert await world.status(leaf) == "done", await world.error(leaf)
    result = result_of(world.model.last(), "q")
    assert result.get("is_error") is True and "not available" in result["content"]


async def test_the_respond_path_binds_the_tool_ledger(world: World) -> None:
    class Died(BaseException):
        pass

    died = False

    async def die(name: str) -> None:
        nonlocal died
        if name == WRITE and not died:
            died = True
            raise Died

    world.model.script("Do it", [ask("q")], [use("w", WRITE)])
    task = await world.start()
    await world.work()
    await world.respond(task, "q", value="go")
    world.on_effect = die
    with pytest.raises(Died):
        await world.tick()
    await world.expire_leases()
    await world.work()
    assert world.count(WRITE) == 1, "a worker death after the effect re-ran it"
    assert await world.status(task) == "done"


async def test_open_interrupts_hold_only_live_questions_after_a_reclaim(world: World) -> None:
    world.model.script("Do it", [ask("dead")])
    task = await world.start()
    await world.work()
    # What a pre-0045 reclaim left: a superseded request, then the live one.
    live = {
        "approvalId": "live",
        "phase": "request",
        "requestKind": "input",
        "tool": "askUser",
        "toolCallId": "live",
        "args": {"prompt": "Which?"},
    }
    [top] = await world.sql(
        "SELECT max(seq) AS seq FROM public.task_events WHERE task_id = $1", uuid.UUID(task)
    )
    checkpoint = (await world.task(task))["checkpoint"]
    await world.sql(
        "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) VALUES "
        "($1, $2, $3, 0, 'status', $4::jsonb), ($1, $2, $3 + 1, 1, 'approval', $5::jsonb)",
        uuid.UUID(task),
        uuid.UUID(world.user),
        int(top["seq"]) + 1,
        json.dumps({"status": "running", "resumedFromSeq": 1, "restarted": True}),
        json.dumps(live),
    )
    checkpoint["messages"][-1]["content"][0]["id"] = "live"
    for key in ("turn", "inflight_tools"):
        checkpoint.pop(key, None)
    await world.sql(
        "UPDATE public.tasks SET outcome = NULL, checkpoint = $2::jsonb WHERE id = $1",
        uuid.UUID(task),
        json.dumps(checkpoint),
    )
    assert [i["id"] for i in (await world.run(task))["openInterrupts"]] == ["live"]
    response, resume = await world.resume(task, {"live": {"value": "x"}})
    assert response.status_code == 202, response.text
    await world.work()
    assert await world.status(resume) == "done"


async def test_a_child_is_answered_in_place_and_the_barrier_settles(world: World) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    world.model.script("child", [use("q", SEND)])
    task = await world.start()
    await world.work()
    [child] = await world.children(task)
    assert await world.status(child) == "paused"
    assert (await world.run(task))["status"] == "running"
    await world.respond(child, "q", approved=True)
    await world.work()
    assert (await world.status(child), await world.status(task)) == ("done", "done")
    assert world.count(SEND) == 1 and (await world.task(task))["pending_children"] == 0


@pytest.mark.parametrize("props", [{}, {"mode": "interactive"}, {"mode": "background"}])
async def test_a_resume_cannot_reach_a_child(world: World, props: dict) -> None:
    world.model.script("Do it", [spawn("s", "child")])
    world.model.script("child", [use("q", SEND)])
    task = await world.start()
    await world.work()
    [child] = await world.children(task)
    response, run = await world.resume(child, {"q": {"approved": True}}, props)
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []


@pytest.mark.parametrize("props", [{}, {"mode": "interactive"}])
async def test_a_resume_cannot_cross_from_background(world: World, props: dict) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()
    response, run = await world.resume(task, {"q": {"value": "x"}}, props)
    assert response.status_code == 409 and response.json()["code"] == "invalid_state"
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []


async def test_the_rpc_refuses_a_cross_mode_resume(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()

    async def create() -> None:
        async with world.as_user() as conn:
            await conn.execute(
                "SELECT * FROM public.create_run($1, $2, 'interactive', NULL, $3)",
                uuid.uuid4(),
                uuid.UUID(world.thread),
                uuid.UUID(task),
            )

    assert await sqlstate_of(create()) == "55000"
