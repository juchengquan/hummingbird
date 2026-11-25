"""Migration 0050 (wave 7) on a real Postgres (`bun run test:db`).

* Q88: the two 54000 refusals a task write can meet carry a hint, so a
  caller tells them apart without reading the message: `task_cap` (5
  active tasks: `create_run`, `create_task_run`) and `job_queue` (20
  queued jobs: `enqueue_task_job`).
* Q90: `private.task_waits_on` and the worker's per-job read of a task
  (`jobs._JOB_TASK_STATE_SQL`) read 0048's `awaiting_children` column,
  not the checkpoint: their cost doesn't grow with it.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from agent_py import jobs, store

from .task_world import pg_only
from .test_migration_0047_pg import INTERRUPT, Db, _cp, open_db


@pytest_asyncio.fixture
async def db() -> AsyncIterator[Db]:
    async with open_db() as opened:
        yield opened


pytestmark = [pg_only, pytest.mark.asyncio]


async def _refusal(db: Db, sql: str, *args: Any) -> tuple[str | None, str | None]:
    """(SQLSTATE, hint) of `sql` run as the user, undone; (None, None) when accepted."""
    attempt = db.conn.transaction()
    await attempt.start()
    try:
        await store._set_user_context(db.conn, user_id=db.user)
        await db.conn.fetchval(sql, *args)
    except asyncpg.PostgresError as exc:
        return str(exc.sqlstate), getattr(exc, "hint", None)
    finally:
        await attempt.rollback()
    return None, None


# --- Q88 ------------------------------------------------------------------------------


async def test_the_task_cap_is_hinted_task_cap_on_both_create_paths(db: Db) -> None:
    for _ in range(5):
        await db.task("queued")
    started = await _refusal(
        db,
        "SELECT status FROM public.create_run($1, $2, 'background', 'g', NULL, 5, $3::jsonb)",
        uuid.uuid4(),
        uuid.UUID(db.thread),
        json.dumps(_cp()),
    )
    assert started == ("54000", "task_cap")
    old = await _refusal(
        db,
        "SELECT public.create_task_run($1, $2, 'g', 5, $3::jsonb)",
        uuid.uuid4(),
        uuid.UUID(db.thread),
        json.dumps(_cp()),
    )
    assert old == ("54000", "task_cap")


async def test_a_full_job_queue_is_hinted_job_queue(db: Db) -> None:
    task = await db.task("queued")
    for _ in range(20):
        await db.conn.execute(
            "INSERT INTO public.task_jobs (task_id, user_id, action, payload, status) "
            "VALUES ($1, $2, 'continue', '{}'::jsonb, 'queued')",
            uuid.UUID(task),
            uuid.UUID(db.user),
        )
    refused = await _refusal(db, "SELECT public.enqueue_task_job($1, 'start')", uuid.UUID(task))
    assert refused == ("54000", "job_queue")


# --- Q90 ------------------------------------------------------------------------------


def _big_checkpoint() -> dict[str, Any]:
    # Random hex: TOAST compresses it only about in half (~60+ pages).
    return {**_cp(), "pad": os.urandom(500_000).hex()}


async def _buffers(db: Db, query: str, *args: Any) -> int:
    """Shared buffers `query` touches (EXPLAIN ANALYZE, functions it calls
    included), measured the second time so a cold catalog doesn't count."""
    raw: Any = None
    for _ in range(2):
        raw = await db.conn.fetchval(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}", *args)
    plan = (json.loads(raw) if isinstance(raw, str) else raw)[0]["Plan"]
    return int(plan["Shared Hit Blocks"]) + int(plan["Shared Read Blocks"])


async def _paused(db: Db, checkpoint: dict[str, Any]) -> str:
    task = await db.task("paused", checkpoint=checkpoint)
    await db.conn.execute(
        "UPDATE public.tasks SET outcome = $2::jsonb WHERE id = $1",
        uuid.UUID(task),
        json.dumps(INTERRUPT),
    )
    return task


async def test_task_waits_on_does_not_read_the_checkpoint(db: Db) -> None:
    small = await _paused(db, _cp())
    big = await _paused(db, _big_checkpoint())
    query = "SELECT private.task_waits_on($1, 'q')"
    assert await db.conn.fetchval(query, uuid.UUID(big)) is True
    cost_small = await _buffers(db, query, uuid.UUID(small))
    cost_big = await _buffers(db, query, uuid.UUID(big))
    assert cost_big - cost_small < 10, (cost_small, cost_big)


async def test_the_workers_job_read_does_not_read_the_checkpoint(db: Db) -> None:
    small = await _paused(db, {**_cp(), "awaiting_children": {}})
    big = await _paused(db, {**_big_checkpoint(), "awaiting_children": {}})
    sql = jobs._JOB_TASK_STATE_SQL.strip().rstrip(";")
    args = (uuid.UUID(db.user), None)
    row = await db.conn.fetchrow(sql, uuid.UUID(big), *args)
    assert row is not None and row["awaiting_children"] is True
    cost_small = await _buffers(db, sql, uuid.UUID(small), *args)
    cost_big = await _buffers(db, sql, uuid.UUID(big), *args)
    assert cost_big - cost_small < 10, (cost_small, cost_big)
