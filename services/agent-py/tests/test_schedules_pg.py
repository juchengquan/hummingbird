"""Schedules against a real Postgres with the Supabase migrations applied.

Opt-in: set `AGENT_PY_TEST_DB_URL` to a disposable database (e.g. the
local Supabase CLI stack: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`).
Skipped otherwise — CI has no database.

Covers what the fakes can't:
  - `PgScheduleStore` writes the same rows as the TS `fireSchedule`;
  - two dispatchers racing on the same due row fire it once (the guarded
    `next_run_at` claim under real row locks);
  - the CRUD routes really run as `authenticated`: RLS hides other users'
    rows, 0031's workspace-ownership policy answers 403, 0035's trigger
    answers 409 past 20 enabled schedules, and 0035's column grants keep
    `last_run_at` out of the caller's reach.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py import db as db_module
from agent_py import store
from agent_py.main import create_app
from agent_py.schedules import PgScheduleStore, dispatch_due_schedules

DB_URL = os.environ.get("AGENT_PY_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")

SECRET = "pg-test-secret-do-not-use-in-prod-32b!"


async def _seed_user(conn: asyncpg.Connection) -> tuple[uuid.UUID, uuid.UUID]:
    user, ws = uuid.uuid4(), uuid.uuid4()
    await conn.execute(
        "INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', "
        "'authenticated', $2)",
        user,
        f"{user}@schedules.test",
    )
    await conn.execute(
        "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1, $2, 'ws')", ws, user
    )
    return user, ws


async def _seed_schedule(
    conn: asyncpg.Connection, user: uuid.UUID, ws: uuid.UUID, **kw: Any
) -> uuid.UUID:
    sid = uuid.uuid4()
    cols: dict[str, Any] = {
        "id": sid,
        "user_id": user,
        "workspace_id": ws,
        "name": "Morning digest",
        "prompt": "Summarise the news",
        "cron": "0 8 * * *",
        "timezone": "UTC",
        "next_run_at": datetime.now(UTC) - timedelta(minutes=1),
        **kw,
    }
    names = ", ".join(cols)
    params = ", ".join(f"${i}" for i in range(1, len(cols) + 1))
    await conn.execute(
        f"INSERT INTO public.task_schedules ({names}) VALUES ({params})", *cols.values()
    )
    return sid


@pytest.fixture
async def pool() -> AsyncIterator[asyncpg.Pool]:
    p = await asyncpg.create_pool(DB_URL, min_size=1, max_size=6)
    try:
        yield p
    finally:
        await p.close()


@pytest.fixture
async def seeded(pool: asyncpg.Pool) -> AsyncIterator[tuple[uuid.UUID, uuid.UUID]]:
    async with pool.acquire() as conn:
        user, ws = await _seed_user(conn)
    try:
        yield user, ws
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", user)


async def _counts(conn: asyncpg.Connection, user: uuid.UUID) -> dict[str, int]:
    out = {}
    for table in ("conversations", "tasks", "task_events", "task_jobs"):
        out[table] = await conn.fetchval(
            f"SELECT count(*) FROM public.{table} WHERE user_id = $1", user
        )
    return out


async def test_dispatch_writes_what_fire_schedule_writes(
    pool: asyncpg.Pool, seeded: tuple[uuid.UUID, uuid.UUID]
) -> None:
    user, ws = seeded
    async with pool.acquire() as conn:
        sid = await _seed_schedule(conn, user, ws, max_steps=7, model="anthropic/x")
    # Only this user's row is due-and-picked here, but other test data may
    # exist; count this user's fires only.
    await dispatch_due_schedules(PgScheduleStore(pool))
    async with pool.acquire() as conn:
        assert await _counts(conn, user) == {
            "conversations": 1,
            "tasks": 1,
            "task_events": 1,
            "task_jobs": 1,
        }
        sched = await conn.fetchrow("SELECT * FROM public.task_schedules WHERE id = $1", sid)
        task = await conn.fetchrow("SELECT * FROM public.tasks WHERE user_id = $1", user)
        conv = await conn.fetchrow("SELECT * FROM public.conversations WHERE user_id = $1", user)
        event = await conn.fetchrow("SELECT * FROM public.task_events WHERE user_id = $1", user)
        job = await conn.fetchrow("SELECT * FROM public.task_jobs WHERE user_id = $1", user)

    assert sched["last_run_task_id"] == task["id"]
    assert sched["last_run_at"] is not None
    assert sched["next_run_at"] > datetime.now(UTC)
    assert sched["next_run_at"].hour == 8 and sched["next_run_at"].minute == 0

    assert conv["title"] == "Scheduled: Morning digest"
    assert conv["workspace_id"] == ws
    assert task["conversation_id"] == conv["id"]
    assert (task["status"], task["step"], task["max_steps"]) == ("queued", 0, 7)
    assert task["goal"] == "Summarise the news"
    assert task["started_at"] is not None
    assert json.loads(task["checkpoint"]) == {
        "messages": [{"role": "user", "content": "Summarise the news"}],
        "step": 0,
        "seq": 1,
        "config": {
            "model": "anthropic/x",
            "workspaceId": str(ws),
            "skills": [
                {"id": "webSearch"},
                {"id": "webFetch"},
                {"id": "searchFiles"},
                {"id": "imageGen"},
            ],
            "maxSteps": 7,
        },
    }
    assert (event["task_id"], event["seq"], event["step"], event["kind"]) == (
        task["id"],
        1,
        0,
        "status",
    )
    assert json.loads(event["payload"]) == {"status": "queued", "maxSteps": 7}
    assert (job["task_id"], job["action"], job["status"], job["attempts"]) == (
        task["id"],
        "start",
        "queued",
        0,
    )
    assert json.loads(job["payload"]) == {}


async def test_concurrent_dispatchers_fire_once(
    pool: asyncpg.Pool, seeded: tuple[uuid.UUID, uuid.UUID]
) -> None:
    user, ws = seeded
    async with pool.acquire() as conn:
        await _seed_schedule(conn, user, ws)
    results = await asyncio.gather(
        *(dispatch_due_schedules(PgScheduleStore(pool)) for _ in range(4))
    )
    assert sum(results) >= 1
    async with pool.acquire() as conn:
        assert (await _counts(conn, user))["tasks"] == 1
        assert (await _counts(conn, user))["task_jobs"] == 1


async def test_min_gap_defers_a_recent_fire(
    pool: asyncpg.Pool, seeded: tuple[uuid.UUID, uuid.UUID]
) -> None:
    user, ws = seeded
    last = datetime.now(UTC) - timedelta(minutes=1)
    async with pool.acquire() as conn:
        sid = await _seed_schedule(conn, user, ws, cron="*/5 * * * *", last_run_at=last)
    await dispatch_due_schedules(PgScheduleStore(pool))
    async with pool.acquire() as conn:
        assert (await _counts(conn, user))["tasks"] == 0
        nxt = await conn.fetchval("SELECT next_run_at FROM public.task_schedules WHERE id=$1", sid)
    assert abs((nxt - (last + timedelta(minutes=4))).total_seconds()) < 0.002


async def test_invalid_cron_row_is_disabled(
    pool: asyncpg.Pool, seeded: tuple[uuid.UUID, uuid.UUID]
) -> None:
    user, ws = seeded
    async with pool.acquire() as conn:
        sid = await _seed_schedule(conn, user, ws, cron="not a cron at all")
    await dispatch_due_schedules(PgScheduleStore(pool))
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval("SELECT enabled FROM public.task_schedules WHERE id=$1", sid)
            is False
        )


# --- CRUD routes as the caller ------------------------------------------------------


def _auth(user: uuid.UUID) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": str(user),
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def route_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    monkeypatch.setenv("SUPABASE_DB_URL", DB_URL)
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    monkeypatch.setenv("WORKER_DRY_RUN", "true")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "3600")
    yield
    db_module._pool = None


def test_crud_runs_as_the_caller(route_env: None) -> None:
    async def setup() -> tuple[uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID]:
        conn = await asyncpg.connect(DB_URL)
        try:
            a, ws_a = await _seed_user(conn)
            b, ws_b = await _seed_user(conn)
        finally:
            await conn.close()
        return a, ws_a, b, ws_b

    async def teardown(*users: uuid.UUID) -> None:
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", list(users))
        finally:
            await conn.close()

    a, ws_a, b, ws_b = asyncio.run(setup())
    try:
        with TestClient(create_app()) as client:
            body = {"workspaceId": str(ws_a), "name": "n", "prompt": "p", "cron": "0 8 * * *"}
            r = client.post("/v1/tasks/schedules", json=body, headers=_auth(a))
            assert r.status_code == 201, r.text
            created = r.json()
            assert created["nextRunAt"].endswith("+00:00")

            # RLS: B sees none of A's rows; B can't touch A's row.
            r = client.get("/v1/tasks/schedules", headers=_auth(b))
            assert r.json() == {"schedules": []}
            r = client.patch(
                f"/v1/tasks/schedules/{created['id']}", json={"name": "x"}, headers=_auth(b)
            )
            assert r.status_code == 404
            r = client.delete(f"/v1/tasks/schedules/{created['id']}", headers=_auth(b))
            assert r.status_code == 200
            assert len(client.get("/v1/tasks/schedules", headers=_auth(a)).json()["schedules"]) == 1

            # 0031: a workspace the caller doesn't own → 42501 → 403.
            r = client.post(
                "/v1/tasks/schedules", json={**body, "workspaceId": str(ws_b)}, headers=_auth(a)
            )
            assert r.status_code == 403, r.text

            # 0035's trigger (acts only for anon/authenticated): 20 enabled max.
            for i in range(19):
                r = client.post(
                    "/v1/tasks/schedules", json={**body, "name": f"s{i}"}, headers=_auth(a)
                )
                assert r.status_code == 201, r.text
            r = client.post("/v1/tasks/schedules", json=body, headers=_auth(a))
            assert r.status_code == 409, r.text
            err = r.json()
            err = err.get("detail", err)
            assert err["code"] == "limit_reached"

            # Disabled ones don't count; re-enabling past the cap is 409 too.
            r = client.post(
                "/v1/tasks/schedules", json={**body, "enabled": False}, headers=_auth(a)
            )
            assert r.status_code == 201
            r = client.patch(
                f"/v1/tasks/schedules/{r.json()['id']}", json={"enabled": True}, headers=_auth(a)
            )
            assert r.status_code == 409

            # PATCH recomputes next_run_at on a timezone change.
            r = client.patch(
                f"/v1/tasks/schedules/{created['id']}",
                json={"timezone": "Asia/Tokyo"},
                headers=_auth(a),
            )
            assert r.status_code == 200, r.text
            assert r.json()["nextRunAt"][11:16] == "23:00"
    finally:
        asyncio.run(teardown(a, b))


async def test_column_grants_keep_dispatcher_bookkeeping_from_the_caller(
    pool: asyncpg.Pool, seeded: tuple[uuid.UUID, uuid.UUID]
) -> None:
    user, ws = seeded
    async with pool.acquire() as conn:
        sid = await _seed_schedule(conn, user, ws)
    async with pool.acquire() as conn:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with conn.transaction():
                await store._set_user_context(conn, user_id=str(user))
                await conn.execute(
                    "UPDATE public.task_schedules SET last_run_at = now() WHERE id = $1", sid
                )
