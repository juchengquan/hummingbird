"""What reading runs costs the database (wave 6-A; survey bugs 7, 8, 9,
18), measured on a real Postgres (`bun run test:db`).

* A `listRuns` page is one pool acquisition and a fixed number of
  statements, whatever its size: no `last_seq` query per row (bug 9).
* Reading a run never decompresses its checkpoint (bug 8, Q66): the same
  list over rows whose checkpoints are 1 MB reads as many buffers as over
  rows whose checkpoints are tiny (`EXPLAIN (ANALYZE, BUFFERS)` of the
  statement the repository ran).
* A finished row with an `outcome`, and a parent waiting on its sub-agent
  runs, are read without scanning their logs (bug 7: the fallback is for
  rows written before `outcome`).
* An idle stream polls the database about twice a second at most, not
  eight times (bug 18), and still closes promptly after a cancel; the
  pool is sized by a setting.

Counting: the pool's `setup` hook runs once per `acquire()`, and a query
logger on every connection records each statement.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import asyncpg
import httpx
import jwt
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from agent_py import db as db_module
from agent_py.main import create_app
from agent_py.routers.runs import _event_stream
from agent_py.runs import wiring
from agent_py.runs.model import RunOwner
from agent_py.settings import Settings

from .task_world import DB_URL, pg_only, seed_user

pytestmark = [pg_only]

SECRET = "pg-test-secret-do-not-use-in-prod-32b!"


@dataclass
class Counter:
    acquired: int = 0
    queries: list[tuple[str, tuple[Any, ...]]] = field(default_factory=list)

    async def setup(self, _conn: asyncpg.Connection) -> None:
        self.acquired += 1

    async def init(self, conn: asyncpg.Connection) -> None:
        conn.add_query_logger(lambda q: self.queries.append((q.query, tuple(q.args or ()))))

    def reset(self) -> None:
        self.acquired = 0
        self.queries.clear()


@dataclass
class Env:
    pool: asyncpg.Pool
    counter: Counter
    http: httpx.AsyncClient
    services: wiring.RunServices
    users: list[tuple[str, str]] = field(default_factory=list)

    def headers(self, user: str) -> dict[str, str]:
        claims = {
            "sub": user,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        }
        return {"Authorization": f"Bearer {jwt.encode(claims, SECRET, algorithm='HS256')}"}

    async def user(self) -> tuple[str, str]:
        async with self.pool.acquire() as conn:
            user, _, thread = await seed_user(conn)
        self.users.append((user, thread))
        return user, thread


@pytest_asyncio.fixture
async def env(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Env]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    counter = Counter()
    pool = await asyncpg.create_pool(
        DB_URL, min_size=1, max_size=8, setup=counter.setup, init=counter.init
    )
    settings = Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True)
    services = wiring.build_run_services(settings, pool)
    app = create_app(enable_poller=False)
    app.dependency_overrides[wiring.get_run_services] = lambda: services
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://agent")
    e = Env(pool, counter, http, services)
    try:
        yield e
    finally:
        await http.aclose()
        async with pool.acquire() as conn:
            for user, _ in e.users:
                await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
        await pool.close()


def _noise(size: int) -> str:
    """Incompressible text: TOAST keeps all of it out of line."""
    return base64.b64encode(os.urandom(size * 3 // 4)).decode()


OUTCOMES: dict[str, dict[str, Any] | None] = {
    "done": {"type": "success", "result": {"text": "ok"}},
    "failed": {"type": "error", "code": "provider", "message": "boom"},
    "asking": {"type": "interrupt", "interrupts": [{"id": "q", "reason": "approval"}]},
    "waiting": None,
    "running": None,
    "queued": None,
}
STATUS = {"asking": "paused", "waiting": "paused"}


async def seed_tasks(
    env: Env, user: str, thread: str, *, rows: int, checkpoint_bytes: int, events: int = 0
) -> list[str]:
    """`rows` background runs cycling through every shape a list shows,
    each with `events` log entries and a checkpoint of about
    `checkpoint_bytes`."""
    shapes = list(OUTCOMES)
    made: list[str] = []
    async with env.pool.acquire() as conn:
        for i in range(rows):
            shape = shapes[i % len(shapes)]
            cp: dict[str, Any] = {
                "messages": [{"role": "user", "content": _noise(checkpoint_bytes)}],
                "config": {},
            }
            if shape == "waiting":
                cp["awaiting_children"] = {"tool_call_id": "s", "children": []}
            task = uuid.uuid4()
            outcome = OUTCOMES[shape]
            await conn.execute(
                "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
                "status, checkpoint, outcome, created_at, finished_at) VALUES ($1, $2, "
                "'background', $3, $3, 'g', $4, $5::jsonb, $6::jsonb, "
                "now() - make_interval(secs => $7), "
                "CASE WHEN $4 IN ('done', 'failed', 'paused') THEN now() END)",
                task,
                uuid.UUID(user),
                uuid.UUID(thread),
                STATUS.get(shape, shape),
                json.dumps(cp),
                None if outcome is None else json.dumps(outcome),
                float(i),
            )
            if events:
                await conn.execute(
                    "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
                    "SELECT $1, $2, g, 0, 'status', '{\"status\": \"running\"}'::jsonb "
                    "FROM generate_series(1, $3) g",
                    task,
                    uuid.UUID(user),
                    events,
                )
            made.append(str(task))
    return made


def _list_select(counter: Counter) -> tuple[str, tuple[Any, ...]]:
    [found] = [
        (q, a)
        for q, a in counter.queries
        if "FROM public.tasks t" in q and q.lstrip().upper().startswith("SELECT")
    ]
    return found


async def _buffers(env: Env, user: str, query: str, args: tuple[Any, ...]) -> int:
    """Shared buffers `query` touches, run as `user` (EXPLAIN ANALYZE), on
    one connection, measured the second time so catalog lookups of a cold
    connection don't count."""
    from agent_py import store

    async with env.pool.acquire() as conn:
        for _ in range(2):
            async with conn.transaction():
                await store._set_user_context(conn, user_id=user)
                raw = await conn.fetchval(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}", *args)
    plan = (json.loads(raw) if isinstance(raw, str) else raw)[0]["Plan"]
    return int(plan["Shared Hit Blocks"]) + int(plan["Shared Read Blocks"])


# --- listRuns ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_list_page_is_one_acquisition_and_a_fixed_number_of_statements(env: Env) -> None:
    user, thread = await env.user()
    await seed_tasks(env, user, thread, rows=24, checkpoint_bytes=200, events=5)

    costs: list[tuple[int, int]] = []
    for size in (5, 20):
        env.counter.reset()
        response = await env.http.get(f"/v1/runs?pageSize={size}", headers=env.headers(user))
        assert response.status_code == 200, response.text
        assert len(response.json()["runs"]) == size
        costs.append((env.counter.acquired, len(env.counter.queries)))
    # BEGIN, SET ROLE, set_config, SELECT, COMMIT, and the pool's reset on
    # release — the same for 5 and 20.
    assert costs[0] == costs[1], costs
    acquired, statements = costs[1]
    assert acquired == 1, f"{acquired} pool acquisitions for one page"
    assert statements <= 6, env.counter.queries
    # `lastSeq` came with the rows.
    assert all(r["lastSeq"] == 5 for r in response.json()["runs"])

    # And for one run.
    env.counter.reset()
    one = response.json()["runs"][0]["id"]
    got = await env.http.get(f"/v1/runs/{one}", headers=env.headers(user))
    assert got.status_code == 200 and got.json()["lastSeq"] == 5
    assert env.counter.acquired == 1 and len(env.counter.queries) <= 6, env.counter.queries


@pytest.mark.asyncio
async def test_reading_runs_never_reads_their_checkpoints(env: Env) -> None:
    big_user, big_thread = await env.user()
    small_user, small_thread = await env.user()
    await seed_tasks(env, big_user, big_thread, rows=12, checkpoint_bytes=1_000_000)
    await seed_tasks(env, small_user, small_thread, rows=12, checkpoint_bytes=200)

    blocks: dict[str, int] = {}
    for name, user in (("big", big_user), ("small", small_user)):
        env.counter.reset()
        response = await env.http.get("/v1/runs?pageSize=20", headers=env.headers(user))
        assert response.status_code == 200, response.text
        assert len(response.json()["runs"]) == 12
        # Every shape read right: a parent waiting on sub-agents is running.
        statuses = sorted(r["status"] for r in response.json()["runs"])
        assert statuses == sorted(
            ["succeeded", "failed", "interrupted", "running", "running", "queued"] * 2
        )
        query, args = _list_select(env.counter)
        blocks[name] = await _buffers(env, user, query, args)
    # 12 MB of checkpoints would be ~1,500 pages of TOAST.
    assert blocks["big"] - blocks["small"] < 40, blocks


@pytest.mark.asyncio
async def test_a_finished_or_waiting_run_is_read_without_its_log(env: Env) -> None:
    long_user, long_thread = await env.user()
    short_user, short_thread = await env.user()
    long = await seed_tasks(env, long_user, long_thread, rows=6, checkpoint_bytes=200, events=3000)
    short = await seed_tasks(env, short_user, short_thread, rows=6, checkpoint_bytes=200, events=1)
    # Planner statistics, as autovacuum keeps them in a deployment.
    async with env.pool.acquire() as conn:
        await conn.execute("ANALYZE public.tasks")
        await conn.execute("ANALYZE public.task_events")
    for (task, user), (twin, twin_user) in zip(
        ((t, long_user) for t in long), ((t, short_user) for t in short), strict=True
    ):
        env.counter.reset()
        got = await env.http.get(f"/v1/runs/{task}", headers=env.headers(user))
        assert got.status_code == 200
        assert got.json()["lastSeq"] == 3000
        log_reads = [
            q
            for q, _ in env.counter.queries
            if "task_events" in q and "FROM public.tasks t" not in q
        ]
        assert log_reads == [], (got.json()["status"], log_reads)
        query, args = _list_select(env.counter)
        env.counter.reset()
        assert (await env.http.get(f"/v1/runs/{twin}", headers=env.headers(twin_user))).json()[
            "lastSeq"
        ] == 1
        twin_query, twin_args = _list_select(env.counter)
        # The index answers `lastSeq`: 3,000 entries (~100 pages) cost
        # what one does.
        long_blocks = await _buffers(env, user, query, args)
        short_blocks = await _buffers(env, twin_user, twin_query, twin_args)
        assert long_blocks - short_blocks < 10, (got.json()["status"], long_blocks, short_blocks)


# --- streams -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_idle_stream_polls_gently_and_still_closes_on_cancel(env: Env) -> None:
    user, thread = await env.user()
    task = uuid.uuid4()
    async with env.pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
            "status, checkpoint) VALUES ($1, $2, 'background', $3, $3, 'g', 'running', "
            '\'{"messages": [], "config": {}}\'::jsonb)',
            task,
            uuid.UUID(user),
            uuid.UUID(thread),
        )
        await conn.execute(
            "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
            "VALUES ($1, $2, 1, 0, 'status', '{\"status\": \"queued\"}'::jsonb)",
            task,
            uuid.UUID(user),
        )
    owner = RunOwner.user(user)
    run = await env.services.repo_for(owner).get(owner, str(task))
    assert run is not None
    frames: list[str] = []
    closed = asyncio.Event()

    async def consume() -> None:
        async for frame in _event_stream(env.services, owner, run, None):
            frames.append(frame)
        closed.set()

    reader = asyncio.create_task(consume())
    try:
        await asyncio.sleep(2.0)  # past the first, quick polls
        env.counter.reset()
        await asyncio.sleep(4.0)
        idle = env.counter.acquired
        # Before: a log read and a row read every 250 ms — 32 in 4 s.
        assert idle <= 10, f"{idle} pool acquisitions in 4 s of an idle stream"

        async with env.pool.acquire() as conn:
            await conn.execute(
                "UPDATE public.tasks SET status = 'cancelled', finished_at = now() WHERE id = $1",
                task,
            )
        started = time.monotonic()
        await asyncio.wait_for(closed.wait(), timeout=3.0)
        assert time.monotonic() - started < 2.0
        assert '"type":"RUN_FINISHED"' in frames[-1] and "cancelled" in frames[-1]
    finally:
        reader.cancel()


def test_the_pool_is_sized_by_a_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_DB_URL", DB_URL)
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "3600")
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    monkeypatch.setenv("RUNS_RECONCILE_ENABLED", "false")
    from agent_py import settings as settings_module

    for raw, expected in ((None, 10), ("7", 7)):
        if raw is None:
            monkeypatch.delenv("DB_POOL_MAX_SIZE", raising=False)
        else:
            monkeypatch.setenv("DB_POOL_MAX_SIZE", raw)
        settings_module.get_settings.cache_clear()
        with TestClient(create_app()):
            assert db_module.get_pool().get_max_size() == expected
        db_module._pool = None
