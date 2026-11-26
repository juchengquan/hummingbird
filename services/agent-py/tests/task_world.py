"""A whole background-task world on a real Postgres (wave 5c).

Real poller, executor, Anthropic provider, SQL, RLS and `/v1/runs`
routes. Faked: the model (scripted, and it refuses a history the
Messages API would refuse) and the MCP discovery (three tools that
record each effect). Used by the `test_task_*_pg.py` modules.
"""

from __future__ import annotations

import copy
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import asyncpg
import httpx
import jwt
import pytest

from agent_py import db as db_module
from agent_py import executor, poller, store
from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.settings import Settings
from agent_py.tools.registry import ToolDescriptor, ToolInvocationResult

DB_URL = os.environ.get("AGENT_PY_TEST_DB_URL", "")
SECRET = "pg-test-secret-do-not-use-in-prod-32b!"
MODEL = "anthropic/claude-haiku-4.5"

SEND = "mcp__s1__send"
"""Side-effecting, gated by its server (`requires_approval`)."""
WRITE = "mcp__s1__write"
"""Side-effecting, not gated."""
READ = "mcp__s1__read"
"""Read-only, not gated (what a built-in skill tool is)."""

pg_only = pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")


def new_id() -> str:
    return str(uuid.uuid4())


def use(call_id: str, name: str, **args: Any) -> dict[str, Any]:
    return {"type": "tool_use", "id": call_id, "name": name, "input": args}


def say(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def spawn(call_id: str, *subgoals: str) -> dict[str, Any]:
    tasks = [{"personaSlug": "helper", "subgoal": g} for g in subgoals]
    return use(call_id, "spawnSubagent", tasks=tasks)


def ask(call_id: str, prompt: str = "Which?") -> dict[str, Any]:
    return use(call_id, "askUser", prompt=prompt)


def pairing_problem(messages: list[dict[str, Any]]) -> str | None:
    """Why the Messages API would refuse this history, or None."""

    def blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
        content = message.get("content")
        return content if isinstance(content, list) else [{"type": "text", "text": content}]

    if not messages or messages[0].get("role") != "user":
        return "must start with a user turn"
    if messages[-1].get("role") != "user":
        return "must end with a user turn"
    before: list[str] = []
    for i, message in enumerate(messages):
        role = message.get("role")
        if i and role == messages[i - 1].get("role"):
            return f"two {role} turns in a row at {i}"
        if role == "user":
            got = [b["tool_use_id"] for b in blocks(message) if b.get("type") == "tool_result"]
            if sorted(got) != sorted(before):
                return f"turn {i}: results {got} for calls {before}"
            before = []
        else:
            before = [b["id"] for b in blocks(message) if b.get("type") == "tool_use"]
            if len(set(before)) != len(before):
                return f"turn {i}: duplicate call ids"
    return None


def tool_results(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    last = messages[-1]["content"]
    if not isinstance(last, list):
        return []
    return [b for b in last if b.get("type") == "tool_result"]


def result_of(messages: list[dict[str, Any]], call_id: str) -> dict[str, Any]:
    [found] = [
        b
        for m in messages
        if isinstance(m["content"], list)
        for b in m["content"]
        if b.get("type") == "tool_result" and b.get("tool_use_id") == call_id
    ]
    return found


@dataclass
class Reply:
    blocks: list[dict[str, Any]]
    before: Callable[[], Awaitable[None]] | None = None
    stop_reason: str | None = None
    """The final message's `stop_reason` when set (e.g. `max_tokens`)."""


class _Stream:
    def __init__(self, reply: Reply) -> None:
        self._reply = reply

    async def __aenter__(self) -> _Stream:
        if self._reply.before is not None:
            await self._reply.before()
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    @property
    def text_stream(self) -> AsyncIterator[str]:
        async def deltas() -> AsyncIterator[str]:
            for block in self._reply.blocks:
                if block["type"] == "text":
                    yield block["text"]

        return deltas()

    async def get_final_message(self) -> dict[str, Any]:
        out: dict[str, Any] = {"content": copy.deepcopy(self._reply.blocks)}
        if self._reply.stop_reason is not None:
            out["stop_reason"] = self._reply.stop_reason
        return out


class ScriptedModel:
    """Replies by the conversation's first user text (a child's is its
    subgoal) and by how many assistant turns the history already holds,
    so a re-run after a crash gets the reply the dead attempt got."""

    def __init__(self) -> None:
        self.scripts: dict[str, list[Reply]] = {}
        self.calls: list[dict[str, Any]] = []
        self.problems: list[str] = []
        self.messages = self

    def script(self, first_text: str, *replies: Reply | list[dict[str, Any]]) -> None:
        self.scripts[first_text] = [r if isinstance(r, Reply) else Reply(r) for r in replies]

    def stream(self, **kwargs: Any) -> _Stream:
        messages = copy.deepcopy(kwargs["messages"])
        self.calls.append({**kwargs, "messages": messages})
        problem = pairing_problem(messages)
        if problem is not None:
            self.problems.append(problem)
            raise RuntimeError(f"400 invalid_request_error: {problem}")
        first = messages[0]["content"]
        key = (
            first
            if isinstance(first, str)
            else next((b["text"] for b in first if b.get("type") == "text"), "")
        )
        turns = sum(1 for m in messages if m["role"] == "assistant")
        script = self.scripts.get(key, [])
        return _Stream(script[turns] if turns < len(script) else Reply([say(f"done: {key}")]))

    def last(self) -> list[dict[str, Any]]:
        return self.calls[-1]["messages"]


@dataclass
class World:
    pool: Any
    user: str
    workspace: str
    thread: str
    http: httpx.AsyncClient
    settings: Settings
    model: ScriptedModel = field(default_factory=ScriptedModel)
    key: bool = True
    """False: no ANTHROPIC_API_KEY."""
    gated: set[str] = field(default_factory=lambda: {SEND})
    gone: set[str] = field(default_factory=set)
    effects: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    on_effect: Callable[[str], Awaitable[None]] | None = None

    # -- fakes ----------------------------------------------------------------

    async def discover(
        self,
        out: dict[str, ToolDescriptor],
        *,
        gated_out: set[str] | None = None,
        allowed_server_ids: Any = None,
        **_: Any,
    ) -> None:
        if allowed_server_ids is not None and "s1" not in allowed_server_ids:
            return
        for name in (SEND, WRITE, READ):
            if name in self.gone:
                continue

            async def execute(args: dict[str, Any], name: str = name) -> ToolInvocationResult:
                self.effects.append((name, dict(args)))
                if self.on_effect is not None:
                    await self.on_effect(name)
                return ToolInvocationResult(text=f"{name} ok {args}", summary="ok")

            out[name] = ToolDescriptor(
                name=name,
                description=name,
                input_schema={"type": "object"},
                execute=execute,
                side_effecting=name != READ,
            )
            if name in self.gated and gated_out is not None:
                gated_out.add(name)

    def count(self, name: str, **args: Any) -> int:
        return sum(1 for n, a in self.effects if n == name and (not args or a == args))

    # -- database -------------------------------------------------------------

    @asynccontextmanager
    async def as_user(self, user: str | None = None) -> AsyncIterator[asyncpg.Connection]:
        async with self.pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=user or self.user)
            yield conn

    async def sql(self, query: str, *args: Any) -> list[Any]:
        async with self.pool.acquire() as conn:
            return list(await conn.fetch(query, *args))

    async def task(self, task_id: str) -> dict[str, Any]:
        [row] = await self.sql("SELECT * FROM public.tasks WHERE id = $1", uuid.UUID(task_id))
        out = dict(row)
        for key in ("checkpoint", "outcome"):
            if isinstance(out.get(key), str):
                out[key] = json.loads(out[key])
        return out

    async def status(self, task_id: str) -> str:
        return str((await self.task(task_id))["status"])

    async def children(self, task_id: str) -> list[str]:
        rows = await self.sql(
            "SELECT id FROM public.tasks WHERE parent_task_id = $1 ORDER BY goal",
            uuid.UUID(task_id),
        )
        return [str(r["id"]) for r in rows]

    async def jobs(self, task_id: str, action: str | None = None) -> list[dict[str, Any]]:
        rows = await self.sql(
            "SELECT * FROM public.task_jobs WHERE task_id = $1 AND ($2::text IS NULL "
            "OR action = $2) ORDER BY created_at",
            uuid.UUID(task_id),
            action,
        )
        return [dict(r) for r in rows]

    async def events(self, task_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        rows = await self.sql(
            "SELECT seq, kind, payload::text AS payload FROM public.task_events "
            "WHERE task_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY seq",
            uuid.UUID(task_id),
            kind,
        )
        return [{**json.loads(r["payload"]), "seq": r["seq"], "kind": r["kind"]} for r in rows]

    async def error(self, task_id: str) -> str:
        results = await self.events(task_id, "result")
        return str(results[-1].get("error", "")) if results else ""

    # -- what the Next routes do ----------------------------------------------

    async def start(
        self,
        text: str = "Do it",
        *,
        messages: list[dict[str, Any]] | None = None,
        **config: Any,
    ) -> str:
        task_id = new_id()
        checkpoint = {
            "messages": [{"role": "user", "content": text}] if messages is None else messages,
            "step": 0,
            "seq": 1,
            "config": {"model": MODEL, "workspaceId": self.workspace, **config},
        }
        async with self.as_user() as conn:
            await conn.execute(
                "SELECT public.create_task_run($1, $2, 'goal', $3, $4::jsonb)",
                uuid.UUID(task_id),
                uuid.UUID(self.thread),
                int(config.get("maxSteps", 12)),
                json.dumps(checkpoint),
            )
            await conn.execute(
                "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
                "VALUES ($1, $2, 1, 0, 'status', '{\"status\": \"queued\"}')",
                uuid.UUID(task_id),
                uuid.UUID(self.user),
            )
            await conn.fetchval("SELECT public.enqueue_task_job($1, 'start')", uuid.UUID(task_id))
        return task_id

    async def respond(self, task_id: str, question: str, **answer: Any) -> None:
        async with self.as_user() as conn:
            await conn.fetchval(
                "SELECT public.enqueue_task_job($1, 'respond', $2::jsonb)",
                uuid.UUID(task_id),
                json.dumps({"requestId": question, **answer}),
            )

    async def cancel(self, task_id: str) -> None:
        """`POST /api/tasks/:id/cancel`."""
        async with self.as_user() as conn:
            if await conn.fetchval("SELECT to_regprocedure('public.cancel_task(uuid)') IS NULL"):
                await self._cancel_without_rpc(conn, task_id)
            else:
                await conn.execute("SELECT public.cancel_task($1)", uuid.UUID(task_id))

    async def cancel_old_next(self, task_id: str) -> None:
        """The cancel route as deployed before 0045."""
        async with self.as_user() as conn:
            await self._cancel_without_rpc(conn, task_id)

    async def _cancel_without_rpc(self, conn: asyncpg.Connection, task_id: str) -> None:
        status = await conn.fetchval(
            "SELECT status FROM public.tasks WHERE id = $1", uuid.UUID(task_id)
        )
        if status in ("done", "failed", "cancelled"):
            return
        await conn.execute(
            "UPDATE public.tasks SET status = 'cancelled', finished_at = now() WHERE id = $1",
            uuid.UUID(task_id),
        )
        await conn.execute(
            "UPDATE public.tasks SET status = 'cancelled', finished_at = now() "
            "WHERE parent_task_id = $1 AND status NOT IN ('done', 'failed', 'cancelled')",
            uuid.UUID(task_id),
        )

    # -- /v1/runs -------------------------------------------------------------

    def headers(self, user: str | None = None) -> dict[str, str]:
        claims = {
            "sub": user or self.user,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        }
        return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}

    async def post_run(self, props: dict[str, Any], **body: Any) -> tuple[httpx.Response, str]:
        run_id = new_id()
        payload = {
            "threadId": self.thread,
            "runId": run_id,
            "messages": [{"id": "m", "role": "user", "content": "Do it"}],
            "forwardedProps": props,
            **body,
        }
        return await self.http.post("/v1/runs", json=payload, headers=self.headers()), run_id

    async def resume(
        self,
        previous: str,
        answers: dict[str, dict[str, Any] | None],
        props: dict[str, Any] | None = None,
        **body: Any,
    ) -> tuple[httpx.Response, str]:
        resume = [
            {"interruptId": q, "status": "cancelled"}
            if payload is None
            else {"interruptId": q, "status": "resolved", "payload": payload}
            for q, payload in answers.items()
        ]
        forwarded = {"mode": "background"} if props is None else props
        return await self.post_run({**forwarded, "previousRunId": previous}, resume=resume, **body)

    async def run(self, run_id: str) -> dict[str, Any]:
        response = await self.http.get(f"/v1/runs/{run_id}", headers=self.headers())
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    async def cancel_run(self, run_id: str) -> dict[str, Any]:
        response = await self.http.post(f"/v1/runs/{run_id}/cancel", headers=self.headers())
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    # -- the worker -----------------------------------------------------------

    async def ready(self) -> bool:
        rows = await self.sql(
            "SELECT 1 FROM public.task_jobs WHERE user_id = $1 AND attempts < max_attempts AND "
            "((status = 'queued' AND scheduled_at <= now()) OR "
            " (status = 'running' AND lease_expires_at < now()))",
            uuid.UUID(self.user),
        )
        return bool(rows)

    async def tick(self, pool: Any = None) -> None:
        saved = db_module._pool
        db_module._pool = pool or self.pool
        try:
            await poller._tick(self.settings)
        finally:
            db_module._pool = saved

    async def work(self, limit: int = 60) -> None:
        for _ in range(limit):
            if not await self.ready():
                return
            await self.tick()
        raise AssertionError("the queue never drained")

    async def expire_leases(self) -> None:
        await self.sql(
            "UPDATE public.task_jobs SET lease_expires_at = now() - interval '1 second' "
            "WHERE user_id = $1 AND status = 'running'",
            uuid.UUID(self.user),
        )


async def seed_user(conn: asyncpg.Connection) -> tuple[str, str, str]:
    user, workspace, thread = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await conn.execute(
        "INSERT INTO auth.users (id, aud, role, email) "
        "VALUES ($1, 'authenticated', 'authenticated', $2)",
        user,
        f"{user}@tasks.test",
    )
    await conn.execute(
        "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1, $2, 'ws')", workspace, user
    )
    await conn.execute(
        "INSERT INTO public.conversations (id, user_id, workspace_id, title) "
        "VALUES ($1, $2, $3, 'c')",
        thread,
        user,
        workspace,
    )
    return str(user), str(workspace), str(thread)


@asynccontextmanager
async def open_world(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[World]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("WORKER_CHUNK_BUDGET_S", "0")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.delenv("WORKER_STUB_MODEL", raising=False)
    settings = Settings(
        SUPABASE_JWT_SECRET=SECRET,
        RUNS_STUB_HARNESS=True,
        WORKER_DRY_RUN=False,
        RUNS_RATE_PER_MINUTE=100_000,
    )
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=12)
    async with pool.acquire() as conn:
        user, workspace, thread = await seed_user(conn)
        # One test's abandoned job must not be another's: the claim is global.
        await conn.execute(
            "UPDATE public.task_jobs SET attempts = max_attempts, status = 'failed' "
            "WHERE status IN ('queued', 'running')"
        )
    db_module._pool = pool
    app = create_app(enable_poller=False)
    services = wiring.build_run_services(settings, pool)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent")
    world = World(pool, user, workspace, thread, http, settings)
    monkeypatch.setattr(executor, "extend_registry_with_mcp", world.discover)
    monkeypatch.setattr(
        executor, "_resolve_anthropic_client", lambda *_: world.model if world.key else None
    )
    try:
        yield world
    finally:
        await http.aclose()
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
        db_module._pool = None
        await pool.close()


async def sqlstate_of(aw: Awaitable[Any]) -> str | None:
    try:
        await aw
    except asyncpg.PostgresError as exc:
        return str(exc.sqlstate)
    return None


__all__ = [
    "DB_URL",
    "MODEL",
    "READ",
    "SEND",
    "WRITE",
    "Reply",
    "ScriptedModel",
    "World",
    "ask",
    "new_id",
    "open_world",
    "pairing_problem",
    "pg_only",
    "result_of",
    "say",
    "seed_user",
    "spawn",
    "sqlstate_of",
    "tool_results",
    "use",
]
