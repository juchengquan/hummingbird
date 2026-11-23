"""Wave 5c — the invariants, attacked at the worker's awaits.

The worker's awaits between two writes are its database round trips (and
the model / tool calls, which `test_task_status_pg.py` and
`test_task_calls_pg.py` cover). Each scenario is replayed once per
boundary — before a connection is acquired, after one is released (so:
before and after each commit) — with a worker death, a database error or
a cancel there.

By default every `DEFAULT_STRIDE`-th boundary, from a different first one
per scenario, so the suite stays within CI's time. All of them (about 8
minutes):

    TASK_SWEEP_STRIDE=1 bun run test:db tests/test_task_sweeps_pg.py

What must hold:

* one result per call (the model refuses an unpaired history);
* one effect per approval, also when the question is answered again;
* one decrement per child;
* terminal is final, and a cancel leaves nothing live;
* one winner per question.
"""

# ruff: noqa: B023
# (each chaos action runs inside the iteration that defines it)
from __future__ import annotations

import asyncio
import contextlib
import os
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import pytest
import pytest_asyncio

from agent_py import store
from agent_py.events import drop_superseded_events

from .task_world import (
    READ,
    SEND,
    WRITE,
    Reply,
    World,
    ask,
    open_world,
    pg_only,
    spawn,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]

MAX_POINTS = 400
DEFAULT_STRIDE = 5
STRIDE = int(os.environ.get("TASK_SWEEP_STRIDE") or DEFAULT_STRIDE)


class Died(BaseException):
    """The worker process is gone."""


class ChaosPool:
    """`pool`, doing `action` at one boundary: point `2k` is before the
    k-th acquire, `2k + 1` after its release."""

    def __init__(self, pool: Any, at: int, action: Callable[[], Awaitable[None]]) -> None:
        self._pool = pool
        self._at = at
        self._action = action
        self._next = 0
        self.fired = False
        self.dead = False

    async def boundary(self) -> None:
        if self.dead:
            raise Died
        point, self._next = self._next, self._next + 1
        if point == self._at and not self.fired:
            self.fired = True
            try:
                await self._action()
            except Died:
                self.dead = True
                raise

    def acquire(self, **kwargs: Any) -> Any:
        chaos = self

        class Acquired:
            async def __aenter__(self) -> Any:
                await chaos.boundary()
                self.inner = chaos._pool.acquire(**kwargs)
                return await self.inner.__aenter__()

            async def __aexit__(self, *exc: Any) -> None:
                await self.inner.__aexit__(*exc)
                if exc[0] is None:
                    await chaos.boundary()

        return Acquired()


@dataclass(frozen=True, eq=False)
class Scenario:
    name: str
    scripts: dict[str, list[Any]]
    answer: str = "respond"
    children: int = 0
    side_effects: tuple[tuple[str, int], ...] = ()
    config: tuple[tuple[str, Any], ...] = ()
    budget: str = "0"


async def slow() -> None:
    await asyncio.sleep(0.06)


SCENARIOS = [
    Scenario(
        "mixed_respond",
        {"Do it": [[use("w", WRITE, n=1), use("q", SEND, n=2), use("r", READ, n=3)]]},
        side_effects=((WRITE, 1), (SEND, 2)),
    ),
    Scenario(
        "mixed_resume",
        {"Do it": [[use("w", WRITE, n=1), use("q", SEND, n=2), use("r", READ, n=3)]]},
        answer="resume",
        side_effects=((WRITE, 1), (SEND, 2)),
    ),
    Scenario(
        "questions_respond",
        {"Do it": [[use("q1", SEND, n=1), ask("q2"), use("q3", SEND, n=3)]]},
        side_effects=((SEND, 1), (SEND, 3)),
    ),
    Scenario(
        "questions_mixed_paths",
        {"Do it": [[use("q1", SEND, n=1), ask("q2"), use("q3", SEND, n=3)]]},
        answer="mix",
        side_effects=((SEND, 1), (SEND, 3)),
    ),
    Scenario(
        "spawn_beside_calls",
        {
            "Do it": [[use("w", WRITE, n=1), spawn("s", "asks", "works")]],
            "asks": [[use("q", SEND, n=2)]],
        },
        children=2,
        side_effects=((WRITE, 1), (SEND, 2)),
    ),
    Scenario(
        "respond_then_two_spawns",
        {"Do it": [[ask("q")], [spawn("s1", "first"), spawn("s2", "second")]]},
        children=2,
    ),
    Scenario(
        "resume_approves_a_spawn",
        {"Do it": [[spawn("s", "child")]]},
        answer="resume",
        children=1,
        config=(("requireApprovalFor", ["spawnSubagent"]),),
    ),
    Scenario(
        "yield",
        {
            "Do it": [
                Reply([use("w", WRITE, n=1)], before=slow),
                [use("q", SEND, n=2)],
            ]
        },
        side_effects=((WRITE, 1), (SEND, 2)),
        budget="0.05",
    ),
]


def points(scenario: Scenario | None = None) -> range:
    first = SCENARIOS.index(scenario) if scenario is not None else 0
    return range(first % STRIDE, MAX_POINTS, STRIDE)


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


async def fresh(world: World, scenario: Scenario) -> str:
    await world.sql("DELETE FROM public.tasks WHERE user_id = $1", uuid.UUID(world.user))
    world.effects.clear()
    world.model.calls.clear()
    world.model.problems.clear()
    world.model.scripts.clear()
    for key, replies in scenario.scripts.items():
        world.model.script(key, *replies)
    return await world.start(**dict(scenario.config))


async def rows_of(world: World) -> list[dict[str, Any]]:
    ids = await world.sql(
        "SELECT id FROM public.tasks WHERE user_id = $1 ORDER BY created_at, id",
        uuid.UUID(world.user),
    )
    return [await world.task(str(r["id"])) for r in ids]


def waiting_on(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    answered = {
        r["previous_run_id"]
        for r in rows
        if r["previous_run_id"] is not None
        and (r["status"] not in ("failed", "cancelled") or r["answers_applied_at"] is not None)
    }
    return [
        r
        for r in rows
        if r["status"] == "paused"
        and r["id"] not in answered
        and (r["outcome"] or {}).get("type") == "interrupt"
    ]


async def worker(world: World, pool: Any) -> Any:
    for _ in range(80):
        # A released job (a failed flag lookup) waits out its backoff; here
        # time passes at once.
        await world.sql(
            "UPDATE public.task_jobs SET scheduled_at = now() "
            "WHERE user_id = $1 AND status = 'queued'",
            uuid.UUID(world.user),
        )
        if not await world.ready():
            return pool
        try:
            await world.tick(pool)
        except Died:
            await world.expire_leases()
            pool = world.pool  # the next process
    raise AssertionError("the queue never drained")


async def drive(world: World, scenario: Scenario, pool: Any) -> None:
    for answered in range(12):
        pool = await worker(world, pool)
        waiting = waiting_on(await rows_of(world))
        if not waiting:
            return
        row = waiting[0]
        [question] = row["outcome"]["interrupts"]
        payload = {"value": "go"} if question["reason"] == "input" else {"approved": True}
        path = scenario.answer
        if path == "mix":
            path = ("resume", "respond")[answered % 2]
        if row["parent_task_id"] is not None or path == "respond":
            await world.respond(str(row["id"]), question["id"], **payload)
        else:
            response, _ = await world.resume(str(row["id"]), {question["id"]: payload})
            assert response.status_code == 202, response.text
    raise AssertionError("the task never finished asking")


async def check_common(world: World, scenario: Scenario, at: str) -> list[dict[str, Any]]:
    rows = await rows_of(world)
    assert world.model.problems == [], at
    sent = Counter((name, args.get("n")) for name, args in world.effects if name != READ)
    assert all(n <= 1 for n in sent.values()), (at, sent)
    children = [r for r in rows if r["parent_task_id"] is not None]
    assert len(children) <= scenario.children, (at, "children spawned twice")
    for parent in rows:
        own = [c for c in children if c["parent_task_id"] == parent["id"]]
        live = sum(c["status"] in ("queued", "running", "paused") for c in own)
        if parent["status"] == "paused":
            assert parent["pending_children"] == live, (at, "the barrier miscounts")
    for row in rows:
        log = await store.load_run_events(world.pool, run_id=str(row["id"]), user_id=world.user)
        kept = drop_superseded_events(log)
        open_step = False
        for event in kept:
            if event.kind == "step_start":
                assert not open_step, (at, "a step opened inside a step")
                open_step = True
            elif event.kind == "step_end":
                assert open_step, (at, "a step closed twice")
                open_step = False
        inputs = Counter(e.tool_call_id for e in kept if e.kind == "tool_input")
        assert all(n == 1 for n in inputs.values()), (at, inputs)
        outputs = Counter(e.tool_call_id for e in kept if e.kind == "tool_output")
        assert all(n == 1 for n in outputs.values()), (at, outputs)
        results = [e for e in kept if e.kind == "result"]
        assert len(results) <= 1, (at, "two results")
    return rows


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
async def test_a_worker_death_at_the_awaits(
    world: World, monkeypatch: pytest.MonkeyPatch, scenario: Scenario
) -> None:
    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", scenario.budget)

    async def die() -> None:
        raise Died

    for point in points(scenario):
        at = f"{scenario.name}: death at point {point}"
        root = await fresh(world, scenario)
        chaos = ChaosPool(world.pool, point, die)
        await drive(world, scenario, chaos)
        rows = await check_common(world, scenario, at)
        by_id = {r["id"]: r for r in rows}
        successor = {r["previous_run_id"]: r for r in rows if r["previous_run_id"]}
        tail = by_id[uuid.UUID(root)]
        while tail["id"] in successor:
            tail = successor[tail["id"]]
        assert tail["status"] == "done", (at, await world.error(str(tail["id"])))
        assert sum(r["parent_task_id"] is not None for r in rows) == scenario.children, at
        for row in rows:
            if row["parent_task_id"] is not None:
                assert row["status"] == "done", at
        for name, n in scenario.side_effects:
            ran = world.count(name, n=n)
            told = "interrupted" in str(tail["checkpoint"]) or any(
                "interrupted" in str(call["messages"]) for call in world.model.calls
            )
            assert ran == 1 or (ran == 0 and told), (at, name, n, "lost without a word")
        if not chaos.fired:
            assert point > 10, "the sweep never reached the worker"
            return
    raise AssertionError("more boundaries than the sweep allows")


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
async def test_a_database_error_at_the_awaits(
    world: World, monkeypatch: pytest.MonkeyPatch, scenario: Scenario
) -> None:
    """Whatever fails, answering again never repeats an effect, and
    nothing stays live with nobody to drive it."""
    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", scenario.budget)

    async def fail() -> None:
        raise OSError("connection reset")

    for point in points(scenario):
        at = f"{scenario.name}: error at point {point}"
        await fresh(world, scenario)
        chaos = ChaosPool(world.pool, point, fail)
        pool: Any = chaos
        for _ in range(4):
            # The poller's own claim / settle: its loop retries.
            with contextlib.suppress(OSError):
                await drive(world, scenario, pool)
            await world.expire_leases()
            if not await world.ready() and not waiting_on(await rows_of(world)):
                break
        rows = await check_common(world, scenario, at)
        jobs = {
            r["task_id"]
            for r in await world.sql(
                "SELECT task_id FROM public.task_jobs WHERE user_id = $1 "
                "AND status IN ('queued', 'running')",
                uuid.UUID(world.user),
            )
        }
        for row in rows:
            if row["status"] in ("queued", "running"):
                assert row["id"] in jobs, (at, "stranded", row["status"])
        if not chaos.fired:
            return
    raise AssertionError("more boundaries than the sweep allows")


@pytest.mark.parametrize("via", ["next", "runs"])
@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
async def test_a_cancel_at_the_awaits(
    world: World, monkeypatch: pytest.MonkeyPatch, scenario: Scenario, via: str
) -> None:
    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", scenario.budget)
    for point in points(scenario):
        at = f"{scenario.name}: cancel at point {point}"
        root = await fresh(world, scenario)
        before: dict[str, Any] = {}

        async def cancel() -> None:
            rows = await rows_of(world)
            before["live"] = [
                str(r["id"]) for r in rows if r["status"] in ("queued", "running", "paused")
            ]
            before["effects"] = len(world.effects)
            before["started"] = [
                call
                for r in rows
                for call in (r["checkpoint"] or {}).get("inflight_tools", {}).get("started", [])
            ]
            await (world.cancel(root) if via == "next" else world.cancel_run(root))
            for task in before["live"]:
                assert await world.status(task) == "cancelled", at

        chaos = ChaosPool(world.pool, point, cancel)
        await drive(world, scenario, chaos)
        rows = await check_common(world, scenario, at)
        if not chaos.fired:
            return
        if not before["live"]:
            continue  # it had already ended
        for row in rows:
            assert row["status"] not in ("queued", "running", "paused"), (at, row["status"])
            if str(row["id"]) in before["live"]:
                assert row["status"] == "cancelled", (at, "overwritten")
                run = await world.run(str(row["id"]))
                assert run["status"] == "cancelled" and run["openInterrupts"] == [], at
                results = await world.events(str(row["id"]), "result")
                assert results == [], (at, "a result after the cancel", results)
        late = [e for e in world.effects[before["effects"] :] if e[0] != READ]
        # Only a tool whose start was committed before the cancel still acts.
        assert len(late) <= len(before["started"]), (at, late)
    raise AssertionError("more boundaries than the sweep allows")


async def test_a_second_answer_at_the_awaits_loses(world: World) -> None:
    scenario = SCENARIOS[0]
    for path in ("respond", "resume"):
        for point in points():
            at = f"{path}: second answer at point {point}"
            task = await fresh(world, scenario)
            await worker(world, world.pool)
            if path == "respond":
                await world.respond(task, "q", approved=True)
            else:
                response, _ = await world.resume(task, {"q": {"approved": True}})
                assert response.status_code == 202

            async def second() -> None:
                again, _ = await world.resume(task, {"q": {"approved": True}})
                assert again.status_code == 409, (at, again.text)
                try:
                    await world.respond(task, "q", approved=True)
                except Exception as exc:
                    assert getattr(exc, "sqlstate", None) == "55000", at
                else:
                    raise AssertionError((at, "a second respond won"))

            chaos = ChaosPool(world.pool, point, second)
            await worker(world, chaos)
            await check_common(world, scenario, at)
            assert world.count(SEND) == 1, at
            if not chaos.fired:
                break


async def test_cancelling_a_child_at_the_awaits_wakes_the_parent_once(world: World) -> None:
    scenario = Scenario("child", {"Do it": [[spawn("s", "asks", "works")]]}, children=2)
    for point in points():
        at = f"child cancel at point {point}"
        root = await fresh(world, scenario)
        await world.tick()  # the parent spawns
        children = await world.children(root)

        async def skip() -> None:
            await world.cancel(children[0])

        chaos = ChaosPool(world.pool, point, skip)
        await worker(world, chaos)
        rows = await check_common(world, scenario, at)
        parent = next(r for r in rows if str(r["id"]) == root)
        assert parent["status"] == "done", at
        assert parent["pending_children"] == 0, at
        assert len(await world.jobs(root, "continue")) == 1, (at, "woken twice")
        assert len(await world.events(root, "result")) == 1, at
        if not chaos.fired:
            return
