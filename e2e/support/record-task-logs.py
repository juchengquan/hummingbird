"""Re-record `e2e/fixtures/task-logs.json`, the logs the tasks e2e specs serve.

The rows are the real executor's and provider's, written to a throwaway
Postgres with every migration applied; only the model client is scripted.

    bun run test:db -- --exec uv run --project services/agent-py \
        python e2e/support/record-task-logs.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import uuid
from pathlib import Path
from typing import Any

import asyncpg

from agent_py import executor, jobs
from agent_py.events import PlanEvent, PlanItem
from agent_py.settings import get_settings

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "task-logs.json"
MODEL = "anthropic/claude-haiku-4.5"

ASKS: dict[str, tuple[str, dict[str, Any]]] = {
    "approval": ("webSearch", {"query": "release notes for version 2"}),
    "choice": (
        "askUser",
        {
            "kind": "choice",
            "prompt": "Which colour should it be?",
            "options": [{"id": "red", "label": "Red"}, {"id": "blue", "label": "Blue"}],
        },
    ),
    "input": ("askUser", {"kind": "input", "prompt": "What should the title be?"}),
    "ui-part": (
        "renderUI",
        {"kind": "confirm", "props": {"prompt": "Publish the draft now?"}},
    ),
}
ANSWERS: dict[str, dict[str, Any]] = {
    "approval": {"approved": False},
    "choice": {"selection": ["blue"]},
    "input": {"value": "Version 2"},
    "ui-part": {"ui_answer": {"kind": "confirm", "confirmed": True}, "value": "Yes"},
}
KINDS = list(ASKS)
REPORT = "# Report\n\nThe release is ready [1].\n\n## Sources\n\n1. [Notes](https://example.com/notes)"


def _script(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """The next model reply, chosen from the goal and the calls made so far."""
    goal = str(messages[0]["content"])
    made = sum(
        1
        for m in messages
        if m["role"] == "assistant" and isinstance(m["content"], list)
        for b in m["content"]
        if isinstance(b, dict) and b.get("type") == "tool_use"
    )
    if goal == "Ask me four things":
        if made < len(KINDS):
            name, args = ASKS[KINDS[made]]
            call = {"type": "tool_use", "id": f"toolu_parent_{made}", "name": name, "input": args}
            return f"Checking {made + 1}. ", [call]
        return "All four questions are answered.", []
    if goal == "Delegate four checks":
        if not made:
            tasks = [{"personaSlug": f"{k}-helper", "subgoal": f"Check {k}"} for k in KINDS]
            call = {
                "type": "tool_use",
                "id": "toolu_spawn",
                "name": "spawnSubagent",
                "input": {"tasks": tasks},
            }
            return "Delegating. ", [call]
        return "Every helper has reported back.", []
    if goal.startswith("Check "):
        kind = goal.removeprefix("Check ")
        if not made:
            name, args = ASKS[kind]
            call = {"type": "tool_use", "id": f"toolu_child_{kind}", "name": name, "input": args}
            return f"Looking at {kind}. ", [call]
        return f"{kind} checked.", []
    return REPORT, []


class _Stream:
    def __init__(self, text: str, calls: list[dict[str, Any]]) -> None:
        self.text, self.calls = text, calls

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    @property
    def text_stream(self) -> Any:
        async def deltas() -> Any:
            for word in self.text.split(" "):
                yield f"{word} "

        return deltas()

    async def get_final_message(self) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": self.text}, *self.calls]}


class _Messages:
    def stream(self, **kwargs: Any) -> _Stream:
        return _Stream(*_script(kwargs["messages"]))


class _Client:
    messages = _Messages()


def _with_plan(make: Any) -> Any:
    # No agent-py tool produces a plan yet; emit the event through the real emitter.
    def factory(payload: Any, checkpoint: Any, messages: Any, *a: Any, **kw: Any) -> Any:
        step = make(payload, checkpoint, messages, *a, **kw)

        async def run(ctx: Any) -> Any:
            if ctx.step == 1 and not str(messages[0]["content"]).startswith("Check "):
                items = (
                    PlanItem(id="p1", text="Gather the facts", status="completed"),
                    PlanItem(id="p2", text="Write it up", status="in_progress"),
                )
                await ctx.emitter.emit(PlanEvent, items=items)
            return await step(ctx)

        return run

    return factory


async def _drain(pool: asyncpg.Pool) -> None:
    while job := await jobs.claim_next_job(pool):
        start = executor.StartActionPayload(run_id=job.task_id, user_id=job.user_id)
        if job.action == "start":
            await executor.execute_start(pool, start)
        elif job.action == "continue":
            await executor.execute_continue(pool, start)
        else:
            answer = executor.RespondActionPayload(
                run_id=job.task_id, user_id=job.user_id, request_id=job.payload["requestId"]
            )
            fields = {k: v for k, v in job.payload.items() if k != "requestId"}
            await executor.execute_respond(pool, dataclasses.replace(answer, **fields))
        await jobs.mark_job_done(pool, job.id)


class Recorder:
    def __init__(self, pool: asyncpg.Pool, user: uuid.UUID, conversation: uuid.UUID) -> None:
        self.pool, self.user, self.conversation = pool, user, conversation
        self.stages: dict[str, list[dict[str, Any]]] = {}

    async def start(self, goal: str) -> uuid.UUID:
        task = uuid.uuid4()
        config = {
            "model": MODEL,
            "maxSteps": 25,
            "skills": [{"id": "webSearch"}],
            "requireApprovalFor": ["webSearch"],
        }
        checkpoint = {
            "messages": [{"role": "user", "content": goal}],
            "step": 0,
            "seq": 1,
            "config": config,
        }
        async with self.pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
                "status, step, max_steps, checkpoint, started_at) "
                "VALUES ($1,$2,'background',$3,$3,$4,'queued',0,25,$5,now())",
                task,
                self.user,
                self.conversation,
                goal,
                json.dumps(checkpoint),
            )
            # What `POST /api/tasks` appends before it enqueues.
            await conn.execute(
                "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
                "VALUES ($1,$2,1,0,'status',$3)",
                task,
                self.user,
                json.dumps({"status": "queued", "maxSteps": 25}),
            )
            await conn.execute(
                "INSERT INTO public.task_jobs (task_id, user_id, action, payload) "
                "VALUES ($1,$2,'start','{}')",
                task,
                self.user,
            )
        return task

    async def answer(self, task: uuid.UUID, request: str, kind: str) -> None:
        payload = {"requestId": request, **ANSWERS[kind]}
        await self.pool.execute(
            "INSERT INTO public.task_jobs (task_id, user_id, action, payload) "
            "VALUES ($1,$2,'respond',$3)",
            task,
            self.user,
            json.dumps(payload),
        )
        await _drain(self.pool)

    async def stage(self, name: str, root: uuid.UUID) -> None:
        rows = await self.pool.fetch(
            "SELECT t.id, t.parent_task_id, t.status, t.goal, t.step, "
            "coalesce((SELECT max(seq) FROM public.task_events WHERE task_id = t.id), 0) AS seq "
            "FROM public.tasks t WHERE t.id = $1 OR t.parent_task_id = $1 "
            "ORDER BY t.parent_task_id NULLS FIRST, t.goal",
            root,
        )
        self.stages[name] = [
            {
                "id": str(r["id"]),
                "parent_task_id": str(r["parent_task_id"]) if r["parent_task_id"] else None,
                "status": r["status"],
                "goal": r["goal"],
                "step": r["step"],
                "seq": r["seq"],
            }
            for r in rows
        ]


async def main() -> None:
    url = os.environ["AGENT_PY_TEST_DB_URL"]
    os.environ.update(WORKER_CHUNK_BUDGET_S="0", TAVILY_API_KEY="", ANTHROPIC_API_KEY="")
    get_settings.cache_clear()
    executor._resolve_anthropic_client = lambda: _Client()  # type: ignore[assignment,return-value]
    executor._default_make_step_fn = _with_plan(executor._default_make_step_fn)

    pool = await asyncpg.create_pool(url, min_size=1, max_size=4)
    user, workspace, conversation = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await pool.execute(
        "INSERT INTO auth.users (id, aud, role, email) "
        "VALUES ($1,'authenticated','authenticated','fixture@e2e.test')",
        user,
    )
    await pool.execute(
        "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1,$2,'ws')", workspace, user
    )
    await pool.execute(
        "INSERT INTO public.conversations (id, user_id, workspace_id, title) "
        "VALUES ($1,$2,$3,'c')",
        conversation,
        user,
        workspace,
    )
    rec = Recorder(pool, user, conversation)

    plain = await rec.start("Write the report")
    await rec.stage("plain.queued", plain)
    await _drain(pool)
    await rec.stage("plain.done", plain)

    asks = await rec.start("Ask me four things")
    await rec.stage("questions.queued", asks)
    await _drain(pool)
    for i, kind in enumerate(KINDS):
        await rec.stage(f"questions.{kind}", asks)
        await rec.answer(asks, f"toolu_parent_{i}", kind)
    await rec.stage("questions.done", asks)

    fanout = await rec.start("Delegate four checks")
    job = await jobs.claim_next_job(pool)
    assert job is not None
    await executor.execute_start(pool, executor.StartActionPayload(str(fanout), str(user)))
    await jobs.mark_job_done(pool, job.id)
    await rec.stage("children.spawned", fanout)
    await _drain(pool)
    await rec.stage("children.asking", fanout)
    for kind in KINDS:
        child = await pool.fetchval(
            "SELECT id FROM public.tasks WHERE parent_task_id = $1 AND goal = $2",
            fanout,
            f"Check {kind}",
        )
        await rec.answer(child, f"toolu_child_{kind}", kind)
        await rec.stage(f"children.answered-{kind}", fanout)

    rows = await pool.fetch(
        "SELECT task_id, seq, step, kind, payload, created_at FROM public.task_events "
        "WHERE user_id = $1 ORDER BY task_id, seq",
        user,
    )
    events = [
        {
            "task_id": str(r["task_id"]),
            "seq": r["seq"],
            "step": r["step"],
            "kind": r["kind"],
            "payload": json.loads(r["payload"]) if isinstance(r["payload"], str) else r["payload"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]
    lines = ",\n".join(f"    {json.dumps(e)}" for e in events)
    stages = ",\n".join(f"    {json.dumps(k)}: {json.dumps(v)}" for k, v in rec.stages.items())
    OUT.write_text(f'{{\n  "stages": {{\n{stages}\n  }},\n  "events": [\n{lines}\n  ]\n}}\n')
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
