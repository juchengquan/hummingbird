"""Wave 6-A: the runs API for tasks, on a real Postgres with the real
executor and a scripted model (`bun run test:db`).

* The task fields of `Run` (contract 0.5.0, RUN_EVENTS.md § 4.5) and the
  `listRuns` task filters, absent vs `false` included.
* `answerRun` (Q59, § 4.4): a sub-agent run answered in place through the
  real `enqueue_task_job` and executor, waking its parent; every refusal
  the contract lists; two answers racing; an answer racing a cancel.
* `markRunDelivered` (Q77): through `public.mark_task_delivered` as the
  user, idempotent, refusals.
* `startRun` at the 5-task cap (Q72, Q79): two starts from two
  connections, and the message.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio

from .task_world import (
    SEND,
    World,
    ask,
    new_id,
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


# --- helpers -------------------------------------------------------------------------


async def answer(
    world: World, run_id: str, entries: list[dict[str, Any]], user: str | None = None
) -> httpx.Response:
    return await world.http.post(
        f"/v1/runs/{run_id}/answers", json={"resume": entries}, headers=world.headers(user)
    )


def approve(question: str = "q", approved: object = True) -> dict[str, Any]:
    return {"interruptId": question, "status": "resolved", "payload": {"approved": approved}}


async def deliver(world: World, run_id: str, user: str | None = None) -> httpx.Response:
    return await world.http.post(f"/v1/runs/{run_id}/delivered", headers=world.headers(user))


async def listed(world: World, query: str) -> list[dict[str, Any]]:
    response = await world.http.get(f"/v1/runs?pageSize=100&{query}", headers=world.headers())
    assert response.status_code == 200, response.text
    runs: list[dict[str, Any]] = response.json()["runs"]
    return runs


async def ids(world: World, query: str) -> set[str]:
    return {r["id"] for r in await listed(world, query)}


async def asking_child(world: World) -> tuple[str, str]:
    """A task whose one sub-agent run is paused on an approval `q`."""
    world.model.script("Do it", [spawn("s", "child")])
    world.model.script("child", [use("q", SEND)])
    task = await world.start()
    await world.work()
    [child] = await world.children(task)
    assert await world.status(child) == "paused"
    return task, child


def task_fields(run: dict[str, Any]) -> tuple[Any, ...]:
    return (
        run["rootRunId"],
        run["currentRunId"],
        run["research"],
        run["delivered"],
        run["childrenAsking"],
        run["answerPending"],
    )


# --- the task fields and filters -------------------------------------------------------


async def test_a_chain_names_its_root_and_current_run(world: World) -> None:
    world.model.script("Do it", [ask("q")], [ask("q2")])
    task = await world.start()
    await world.work()
    paused = await world.run(task)
    assert paused["status"] == "interrupted"
    assert task_fields(paused) == (task, None, False, False, 0, False)

    response, resume = await world.resume(task, {"q": {"value": "a"}})
    assert response.status_code == 202, response.text
    # The answered run names the run that took its question over.
    assert (await world.run(task))["currentRunId"] == resume
    assert task_fields(await world.run(resume)) == (task, None, False, False, 0, False)

    await world.work()
    assert (await world.run(resume))["status"] == "interrupted"
    assert await ids(world, "mode=background&topLevel=true&current=true") == {resume}
    assert await ids(world, "mode=background&current=false") == {task}
    assert await ids(world, f"rootRunId={task}") == {task, resume}
    # Absent does not filter.
    assert await ids(world, "mode=background") == {task, resume}


async def test_a_resume_that_failed_before_applying_is_a_dead_branch(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()
    response, resume = await world.resume(task, {"q": {"value": "a"}})
    assert response.status_code == 202
    # Cancelled before a worker applied anything: the cancel takes the
    # whole task (Q60), so fail it instead, as a dead worker would.
    await world.sql(
        "UPDATE public.tasks SET status = 'failed', finished_at = now() WHERE id = $1",
        uuid.UUID(resume),
    )
    assert (await world.run(resume))["currentRunId"] == task
    assert (await world.run(task))["currentRunId"] is None
    assert await ids(world, "mode=background&current=true") == {task}
    assert await ids(world, "mode=background&current=false") == {resume}


async def test_research_comes_from_the_root_and_reaches_its_resume(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    response, task = await world.post_run(
        {"mode": "background", "goal": "g", "research": True, "model": "anthropic/claude-haiku-4.5"}
    )
    assert response.status_code == 202, response.text
    plain = await world.start("Plain")
    assert (await world.run(task))["research"] is True
    assert (await world.run(plain))["research"] is False
    await world.work()
    response, resume = await world.resume(task, {"q": {"value": "a"}})
    assert response.status_code == 202, response.text
    assert (await world.run(resume))["research"] is True


async def test_children_asking_and_the_top_level_filter(world: World) -> None:
    task, child = await asking_child(world)
    parent = await world.run(task)
    assert parent["status"] == "running", "a parent waiting on sub-agents reads running"
    assert parent["childrenAsking"] == 1
    kid = await world.run(child)
    assert kid["status"] == "interrupted"
    assert task_fields(kid) == (task, None, False, False, 0, False)
    assert kid["parentRunId"] == task

    assert await ids(world, "topLevel=true") == {task}
    assert await ids(world, "topLevel=false") == {child}
    assert await ids(world, f"parentRunId={task}") == {child}
    # A sub-agent run is always its own current run.
    assert child in await ids(world, "current=true")
    assert await ids(world, "status=interrupted") == {child}
    assert await ids(world, "status=running") == {task}


async def test_delivered_absent_true_and_false(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    other = await world.start("Other")
    await world.work()
    response, resume = await world.resume(task, {"q": {"value": "a"}})
    assert response.status_code == 202
    await world.work()
    assert (await world.run(resume))["status"] == "succeeded"
    assert (await world.run(other))["status"] == "succeeded"

    # An interactive run is never delivered.
    chat = new_id()
    await world.sql(
        "INSERT INTO public.tasks (id, user_id, mode, thread_id, status, goal) "
        "VALUES ($1, $2, 'interactive', $3, 'done', 'chat')",
        uuid.UUID(chat),
        uuid.UUID(world.user),
        uuid.UUID(world.thread),
    )

    marked = await deliver(world, task)
    assert marked.status_code == 200, marked.text
    assert marked.json()["id"] == task and marked.json()["delivered"] is True
    # Every run of the task reads it, from its root.
    assert (await world.run(resume))["delivered"] is True
    assert (await world.run(other))["delivered"] is False
    assert (await world.run(chat))["delivered"] is False

    assert await ids(world, "delivered=true") == {task, resume}
    assert await ids(world, "delivered=false") == {other, chat}
    assert await ids(world, "") == {task, resume, other, chat}
    assert await ids(world, "mode=background&current=true&status=succeeded&delivered=false") == {
        other
    }


# --- markRunDelivered ----------------------------------------------------------------


async def test_mark_delivered_is_idempotent_and_keeps_the_first_mark(world: World) -> None:
    task = await world.start()
    await world.work()
    first = await deliver(world, task)
    assert first.status_code == 200, first.text
    [at] = await world.sql(
        "SELECT result_delivered_at FROM public.tasks WHERE id = $1", uuid.UUID(task)
    )
    again = await deliver(world, task)
    assert again.status_code == 200 and again.json()["delivered"] is True
    [still] = await world.sql(
        "SELECT result_delivered_at FROM public.tasks WHERE id = $1", uuid.UUID(task)
    )
    assert still["result_delivered_at"] == at["result_delivered_at"] is not None


async def test_mark_delivered_refusals(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()
    # Not ended: the task waits on a question.
    live = await deliver(world, task)
    assert (live.status_code, live.json()["code"]) == (409, "invalid_state")
    response, resume = await world.resume(task, {"q": {"value": "a"}})
    assert response.status_code == 202
    await world.work()
    # A resume is not the root.
    not_root = await deliver(world, resume)
    assert (not_root.status_code, not_root.json()["code"]) == (409, "invalid_state")
    # Someone else's, or nobody's: the same 404.
    async with world.pool.acquire() as conn:
        stranger, _, _ = await seed_user(conn)
    try:
        foreign = await deliver(world, task, user=stranger)
        assert (foreign.status_code, foreign.json()["code"]) == (404, "not_found")
    finally:
        await world.sql("DELETE FROM auth.users WHERE id = $1", uuid.UUID(stranger))
    missing = await deliver(world, new_id())
    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")
    assert (await world.http.post(f"/v1/runs/{task}/delivered")).status_code == 401
    assert (
        await world.sql(
            "SELECT result_delivered_at FROM public.tasks WHERE id = $1", uuid.UUID(task)
        )
    )[0]["result_delivered_at"] is None


async def test_a_child_is_not_a_root_to_mark(world: World) -> None:
    _, child = await asking_child(world)
    await world.cancel_run(child)
    refused = await deliver(world, child)
    assert (refused.status_code, refused.json()["code"]) == (409, "invalid_state")


# --- answerRun -----------------------------------------------------------------------


async def test_a_child_answered_in_place_wakes_its_parent(world: World) -> None:
    task, child = await asking_child(world)
    response = await answer(world, child, [approve()])
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["id"] == child and body["status"] == "interrupted"
    assert body["answerPending"] is True
    # The answer is the real `respond` job, through `enqueue_task_job`.
    [job] = await world.jobs(child, "respond")
    payload = job["payload"] if isinstance(job["payload"], dict) else json.loads(job["payload"])
    assert payload == {"requestId": "q", "approved": True}
    assert (await world.run(task))["childrenAsking"] == 1

    await world.work()
    assert (await world.run(child))["status"] == "succeeded"
    assert (await world.run(child))["answerPending"] is False
    parent = await world.run(task)
    assert parent["status"] == "succeeded", "the parent never woke"
    assert parent["childrenAsking"] == 0
    assert world.count(SEND) == 1


async def test_a_declined_child_question_is_queued_as_cancelled(world: World) -> None:
    _, child = await asking_child(world)
    response = await answer(world, child, [{"interruptId": "q", "status": "cancelled"}])
    assert response.status_code == 202, response.text
    [job] = await world.jobs(child, "respond")
    payload = job["payload"] if isinstance(job["payload"], dict) else json.loads(job["payload"])
    assert payload == {"requestId": "q", "cancelled": True}
    await world.work()
    # What the executor does with `cancelled` is wave 6-B's (a decline);
    # either way the tool never runs.
    assert world.count(SEND) == 0, "a decline ran the tool"


@pytest.mark.parametrize(
    "entries",
    [
        [approve("other")],
        [approve(), approve("other")],
        [approve(), approve()],
        [approve(approved="true")],
        [{"interruptId": "q", "status": "resolved", "payload": {}}],
        [{"interruptId": "q", "status": "resolved"}],
    ],
)
async def test_an_answer_that_does_not_fit_is_400(
    world: World, entries: list[dict[str, Any]]
) -> None:
    _, child = await asking_child(world)
    response = await answer(world, child, entries)
    assert (response.status_code, response.json()["code"]) == (400, "invalid_request")
    assert await world.jobs(child, "respond") == []


async def test_answer_refusals(world: World) -> None:
    world.model.script("Do it", [ask("q")])
    task = await world.start()
    await world.work()
    # A top-level run is answered with startRun + previousRunId.
    top = await answer(
        world, task, [{"interruptId": "q", "status": "resolved", "payload": {"value": "a"}}]
    )
    assert (top.status_code, top.json()["code"]) == (409, "invalid_state")
    missing = await answer(world, new_id(), [approve()])
    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")
    assert (
        await world.http.post(f"/v1/runs/{task}/answers", json={"resume": [approve()]})
    ).status_code == 401
    assert await world.jobs(task, "respond") == []


async def test_a_child_that_is_not_asking_is_invalid_state(world: World) -> None:
    _, child = await asking_child(world)
    await world.cancel_run(child)
    response = await answer(world, child, [approve()])
    assert (response.status_code, response.json()["code"]) == (409, "invalid_state")


async def test_someone_elses_child_is_404(world: World) -> None:
    _, child = await asking_child(world)
    async with world.pool.acquire() as conn:
        stranger, _, _ = await seed_user(conn)
    try:
        response = await answer(world, child, [approve()], user=stranger)
        assert (response.status_code, response.json()["code"]) == (404, "not_found")
    finally:
        await world.sql("DELETE FROM auth.users WHERE id = $1", uuid.UUID(stranger))
    assert await world.jobs(child, "respond") == []


async def test_an_answer_through_the_old_route_holds_the_question(world: World) -> None:
    _, child = await asking_child(world)
    await world.respond(child, "q", approved=True)
    response = await answer(world, child, [approve()])
    assert (response.status_code, response.json()["code"]) == (409, "run_already_answered")
    await world.work()
    assert world.count(SEND) == 1


async def test_an_answer_a_worker_is_applying_is_already_answered(world: World) -> None:
    _, child = await asking_child(world)
    first = await answer(world, child, [approve()])
    assert first.status_code == 202
    # A worker claimed the respond job: the run reads `running` meanwhile.
    await world.sql(
        "UPDATE public.task_jobs SET status = 'running', lease_expires_at = now() + "
        "interval '1 minute' WHERE task_id = $1 AND action = 'respond'",
        uuid.UUID(child),
    )
    await world.sql("UPDATE public.tasks SET status = 'running' WHERE id = $1", uuid.UUID(child))
    again = await answer(world, child, [approve()])
    assert (again.status_code, again.json()["code"]) == (409, "run_already_answered")
    # Once the run ended, it is no longer waiting at all.
    await world.sql(
        "UPDATE public.task_jobs SET status = 'done' WHERE task_id = $1", uuid.UUID(child)
    )
    await world.sql("UPDATE public.tasks SET status = 'done' WHERE id = $1", uuid.UUID(child))
    ended = await answer(world, child, [approve()])
    assert (ended.status_code, ended.json()["code"]) == (409, "invalid_state")


async def test_two_answers_to_one_question_have_one_winner(world: World) -> None:
    _, child = await asking_child(world)
    responses = await asyncio.gather(*(answer(world, child, [approve()]) for _ in range(5)))
    codes = sorted(
        (r.status_code, r.json().get("code") if r.status_code != 202 else None) for r in responses
    )
    assert codes == [(202, None)] + [(409, "run_already_answered")] * 4, codes
    assert len(await world.jobs(child, "respond")) == 1
    await world.work()
    assert world.count(SEND) == 1


async def test_an_answer_racing_a_cancel_never_runs_the_tool(world: World) -> None:
    task, child = await asking_child(world)
    response, cancelled = await asyncio.gather(
        answer(world, child, [approve()]),
        world.http.post(f"/v1/runs/{child}/cancel", headers=world.headers()),
    )
    assert cancelled.status_code == 200
    assert response.status_code == 202 or (
        response.status_code == 409 and response.json()["code"] == "invalid_state"
    ), response.text
    await world.work()
    assert (await world.run(child))["status"] == "cancelled"
    assert world.count(SEND) == 0
    # Cancelling a child skips it: its parent continues (Q60).
    assert (await world.run(task))["status"] == "succeeded"


async def test_an_answer_past_the_job_queue_cap_is_limit_reached(world: World) -> None:
    _, child = await asking_child(world)
    for _ in range(20):
        await world.sql(
            "INSERT INTO public.task_jobs (task_id, user_id, action, payload, status, "
            "scheduled_at) VALUES ($1, $2, 'continue', '{}'::jsonb, 'queued', "
            "now() + interval '1 hour')",
            uuid.UUID(child),
            uuid.UUID(world.user),
        )
    response = await answer(world, child, [approve()])
    assert (response.status_code, response.json()["code"]) == (409, "limit_reached")
    assert await world.jobs(child, "respond") == []


# --- the cap -------------------------------------------------------------------------


CAP_MESSAGE = "5 tasks are already active. Finish or cancel one, then start this one again."


async def test_two_starts_at_the_cap_from_two_connections(world: World) -> None:
    for i in range(4):
        await world.start(f"Task {i}")
    props = {"mode": "background", "goal": "g", "model": "anthropic/claude-haiku-4.5"}
    (a, run_a), (b, run_b) = await asyncio.gather(world.post_run(props), world.post_run(props))
    assert sorted([a.status_code, b.status_code]) == [202, 409], (a.text, b.text)
    refused = a if a.status_code == 409 else b
    assert refused.json() == {"code": "limit_reached", "message": CAP_MESSAGE}
    loser = run_a if refused is a else run_b
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(loser)) == []
    assert len(await listed(world, "mode=background&topLevel=true&current=true")) == 5


async def test_a_full_job_queue_is_limit_reached_with_its_own_message(world: World) -> None:
    task = await world.start()
    for _ in range(19):
        await world.sql(
            "INSERT INTO public.task_jobs (task_id, user_id, action, payload, status) "
            "VALUES ($1, $2, 'continue', '{}'::jsonb, 'queued')",
            uuid.UUID(task),
            uuid.UUID(world.user),
        )
    response, run = await world.post_run(
        {"mode": "background", "goal": "g", "model": "anthropic/claude-haiku-4.5"}
    )
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "limit_reached" and body["message"] != CAP_MESSAGE
    assert "queued" in body["message"]
    assert await world.sql("SELECT 1 FROM public.tasks WHERE id = $1", uuid.UUID(run)) == []
