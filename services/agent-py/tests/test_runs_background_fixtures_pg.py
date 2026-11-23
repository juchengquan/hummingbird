"""Recorded background-run streams for the client's tasks reducer
(wave 6-C, `lib/client/runs/fixtures/agent-py/background/`).

Each scenario drives a real background task — the poller, the executor,
the Anthropic provider over a scripted model (`task_world`), the SQL of
every migration — through `/v1/runs`, then records what `GET
/v1/runs/{id}/events` sends for each of its runs: agent-py's real
encoder and stream over the rows the executor wrote.

| scenario | runs |
|---|---|
| `spawn` | a parent spawning two sub-agents; one asks (`askUser`), is answered in place (a `respond` job — what `answerRun` queues) and finishes; the parent then answers |
| `approval` | a gated tool: `hummingbird.interrupt_pending`, then the interrupt outcome |
| `plan` | the agent's todo list (`hummingbird.plan`), updated, then the answer |
| `step-error` | a tool that fails (`hummingbird.step_error`), the model recovers |
| `rewind` | the worker dies inside a side-effecting tool; another reclaims the run (`hummingbird.rewind`, the "not run again" step error) |
| `chain` | P0 asks, is answered by a resume R1 through `/v1/runs` (Q24), R1 succeeds |

Every event is checked against the pinned AG-UI schema. With
`RUNS_BG_FIXTURES_DIR` set, each scenario writes `<scenario>/<role>.sse`
and a `manifest.json` (role → run id, parent / previous role, status)
there; `scripts/record-runs-fixtures.sh --background` sets it and runs
this module on `bun run test:db`. Run ids are fresh on each recording.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

from agent_py import executor
from agent_py.events import PlanEvent, PlanItem
from agent_py.runner import RunStepContext, RunStepFn, RunStepOutcome

from .runs_support import assert_valid
from .task_world import (
    MODEL,
    SEND,
    WRITE,
    World,
    ask,
    open_world,
    pg_only,
    say,
    spawn,
    use,
)

pytestmark = [pg_only, pytest.mark.asyncio]

FIXTURES_DIR = os.environ.get("RUNS_BG_FIXTURES_DIR", "")
START = {"mode": "background", "model": MODEL, "goal": "Do it"}


@pytest_asyncio.fixture
async def world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    async with open_world(monkeypatch) as w:
        yield w


def _frames(body: str) -> list[tuple[str | None, dict[str, Any]]]:
    out: list[tuple[str | None, dict[str, Any]]] = []
    for block in body.strip().split("\n\n"):
        event_id = None
        data = None
        for line in block.split("\n"):
            if line.startswith("id: "):
                event_id = line[4:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if data is not None:
            out.append((event_id, data))
    return out


class Recording:
    def __init__(self, world: World, scenario: str) -> None:
        self.world = world
        self.scenario = scenario
        self.runs: dict[str, dict[str, Any]] = {}

    async def take(
        self,
        role: str,
        run_id: str,
        *,
        parent: str | None = None,
        previous: str | None = None,
    ) -> list[dict[str, Any]]:
        """The run's whole stream (it must have ended or paused)."""
        response = await self.world.http.get(
            f"/v1/runs/{run_id}/events", headers=self.world.headers()
        )
        assert response.status_code == 200, response.text
        body = response.text
        frames = _frames(body)
        events = [event for _, event in frames]
        for event in events:
            assert_valid(event)
        assert events[0]["type"] == "RUN_STARTED"
        assert events[-1]["type"] in ("RUN_FINISHED", "RUN_ERROR")
        run = await self.world.run(run_id)
        self.runs[role] = {
            "runId": run_id,
            "parentRole": parent,
            "previousRole": previous,
            "status": run["status"],
        }
        if FIXTURES_DIR:
            out = Path(FIXTURES_DIR) / self.scenario
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{role}.sse").write_text(body)
        return events

    def save(self) -> None:
        if FIXTURES_DIR:
            out = Path(FIXTURES_DIR) / self.scenario
            out.mkdir(parents=True, exist_ok=True)
            manifest = {"scenario": self.scenario, "runs": self.runs}
            (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def _names(events: list[dict[str, Any]]) -> list[str]:
    return [str(e.get("name") or e["type"]) for e in events]


async def _start(world: World) -> str:
    # The workspace is where the MCP servers come from.
    response, run_id = await world.post_run({**START, "workspaceId": world.workspace})
    assert response.status_code == 202, response.text
    return run_id


async def test_spawn_with_a_child_that_asks(world: World) -> None:
    world.model.script("Do it", [spawn("s", "asks", "works")], [say("Both sub-agents are done.")])
    world.model.script("asks", [ask("q", "Which colour?")], [say("Blue it is.")])
    parent = await _start(world)
    await world.work()
    asks, works = await world.children(parent)
    assert await world.status(asks) == "paused"
    rec = Recording(world, "spawn")
    paused = await rec.take("child-asks-paused", asks, parent="parent")
    assert "hummingbird.interrupt_pending" in _names(paused)
    assert paused[-1]["outcome"]["type"] == "interrupt"
    # What `answerRun` queues (RUN_EVENTS.md § 4.4): a respond job.
    await world.respond(asks, "q", value="blue")
    await world.work()
    assert await world.status(parent) == "done"
    events = await rec.take("parent", parent)
    assert [e["type"] for e in events].count("SUBAGENT_STARTED") == 2
    assert events[-1]["type"] == "RUN_FINISHED" and events[-1]["outcome"]["type"] == "success"
    answered = await rec.take("child-asks", asks, parent="parent")
    assert "hummingbird.interrupt_resolved" in _names(answered)
    await rec.take("child-works", works, parent="parent")
    rec.save()


async def test_approval_pending(world: World) -> None:
    world.model.script("Do it", [use("send-1", SEND, to="team")])
    run = await _start(world)
    await world.work()
    rec = Recording(world, "approval")
    events = await rec.take("run", run)
    names = _names(events)
    assert names.index("hummingbird.interrupt_pending") < names.index("RUN_FINISHED")
    [interrupt] = events[-1]["outcome"]["interrupts"]
    assert interrupt["reason"] == "approval" and interrupt["toolCallId"] == "send-1"
    rec.save()


def _plan_step(_p: Any, _c: Any, _messages: list[Any], _ctx: Any = None) -> RunStepFn:
    async def step(ctx: RunStepContext) -> RunStepOutcome:
        # No agent-py tool writes a plan today; the old TS worker did. The
        # entry goes through the real emitter and store all the same.
        await ctx.emitter.emit(
            PlanEvent,
            items=(
                PlanItem(id="1", text="Search", status="in_progress"),
                PlanItem(id="2", text="Write", status="pending"),
            ),
        )
        await ctx.emitter.emit(
            PlanEvent,
            items=(
                PlanItem(id="1", text="Search", status="completed"),
                PlanItem(id="2", text="Write", status="completed"),
            ),
        )
        await ctx.emitter.token("Written.")
        return RunStepOutcome(done=True)

    return step


async def test_plan(world: World) -> None:
    run = await _start(world)
    payload = executor.StartActionPayload(run_id=run, user_id=world.user)
    out = await executor.execute_start(world.pool, payload, make_step_fn=_plan_step)
    assert out.settled
    rec = Recording(world, "plan")
    events = await rec.take("run", run)
    plans = [e for e in events if e.get("activityType") == "hummingbird.plan"]
    assert len(plans) == 2 and plans[-1]["content"]["items"][0]["status"] == "completed"
    rec.save()


async def test_step_error(world: World) -> None:
    async def fail(name: str) -> None:
        if name == WRITE:
            raise RuntimeError("disk full")

    world.on_effect = fail
    world.model.script("Do it", [use("w", WRITE, n=1)], [say("Recovered without it.")])
    run = await _start(world)
    await world.work()
    assert await world.status(run) == "done"
    rec = Recording(world, "step-error")
    events = await rec.take("run", run)
    [error] = [e for e in events if e.get("name") == "hummingbird.step_error"]
    assert error["value"]["willRetry"] is True
    rec.save()


class Died(BaseException):
    """The worker process is gone."""


async def test_rewind_after_a_reclaim(world: World) -> None:
    died = False

    async def die(name: str) -> None:
        nonlocal died
        if name == WRITE and not died:
            died = True
            raise Died

    world.on_effect = die
    world.model.script("Do it", [use("w", WRITE, n=1)], [say("Done, carefully.")])
    run = await _start(world)
    with pytest.raises(Died):
        await world.tick()
    await world.expire_leases()
    await world.work()
    assert await world.status(run) == "done"
    rec = Recording(world, "rewind")
    events = await rec.take("run", run)
    names = _names(events)
    assert "hummingbird.rewind" in names
    assert any(
        e.get("name") == "hummingbird.step_error" and "not run again" in e["value"]["message"]
        for e in events
    )
    assert world.count(WRITE) == 1, "the side effect ran once"
    rec.save()


async def test_chain_pause_resume_done(world: World) -> None:
    world.model.script("Do it", [ask("q", "Which colour?")], [say("Painted it blue.")])
    p0 = await _start(world)
    await world.work()
    assert (await world.run(p0))["status"] == "interrupted"
    response, r1 = await world.resume(p0, {"q": {"value": "blue"}})
    assert response.status_code == 202, response.text
    await world.work()
    assert (await world.run(r1))["status"] == "succeeded"
    rec = Recording(world, "chain")
    first = await rec.take("p0", p0)
    assert first[-1]["outcome"]["type"] == "interrupt"
    second = await rec.take("r1", r1, previous="p0")
    results = [e for e in second if e["type"] == "TOOL_CALL_RESULT"]
    assert results and results[0]["toolCallId"] == "q"
    assert second[-1]["outcome"]["type"] == "success"
    rec.save()
