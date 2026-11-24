"""Migration 0048 (wave 6): `tasks.awaiting_children` and the current-run
functions by column, on a real Postgres (`bun run test:db`).

* Upgrade: rows written before it (a parent waiting on sub-agents, one
  that is not, one with no checkpoint) get the column from their
  checkpoint; applied twice (idempotent). All inside a rolled-back
  transaction.
* The column follows every later checkpoint write (spawn, fan-in) and
  can't be written.
* 0047's row functions and the new column ones agree on every run of a
  chain with a dead branch and a sub-agent run (Q75's rule unchanged).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import asyncpg
import pytest

from .task_world import DB_URL, pg_only, seed_user

pytestmark = [pg_only, pytest.mark.asyncio]

M0048 = Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0048_task_read_flags.sql"

UNDO_0048 = """
drop function if exists public.task_current_run_id_by(uuid, uuid, uuid, uuid) cascade;
drop function if exists public.task_run_is_current_by(uuid, uuid, uuid, text, timestamptz) cascade;
alter table public.tasks drop column if exists awaiting_children;
"""

AWAITING = {"messages": [], "config": {}, "awaiting_children": {"tool_call_id": "s"}}
PLAIN = {"messages": [], "config": {}}


async def _insert(
    conn: asyncpg.Connection,
    user: str,
    thread: str,
    *,
    status: str = "paused",
    checkpoint: dict[str, object] | None = None,
    previous: str | None = None,
    parent: str | None = None,
    applied: bool = False,
    minutes_ago: int = 5,
) -> str:
    task = uuid.uuid4()
    await conn.execute(
        "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, status, "
        "checkpoint, previous_run_id, parent_task_id, answers_applied_at, created_at) "
        "VALUES ($1, $2, 'background', $3, $3, 'g', $4, $5::jsonb, $6, $7, "
        "CASE WHEN $8 THEN now() END, now() - make_interval(mins => $9))",
        task,
        uuid.UUID(user),
        uuid.UUID(thread),
        status,
        None if checkpoint is None else json.dumps(checkpoint),
        None if previous is None else uuid.UUID(previous),
        None if parent is None else uuid.UUID(parent),
        applied,
        minutes_ago,
    )
    return str(task)


async def _flag(conn: asyncpg.Connection, task: str) -> object:
    return await conn.fetchval(
        "SELECT awaiting_children FROM public.tasks WHERE id = $1", uuid.UUID(task)
    )


async def test_upgrade_fills_the_column_and_is_idempotent() -> None:
    conn = await asyncpg.connect(DB_URL)
    tx = conn.transaction()
    await tx.start()
    try:
        await conn.execute(UNDO_0048)
        user, _, thread = await seed_user(conn)
        waiting = await _insert(conn, user, thread, checkpoint=AWAITING)
        asking = await _insert(conn, user, thread, checkpoint=PLAIN)
        bare = await _insert(conn, user, thread, status="queued", checkpoint=None)
        sql = M0048.read_text()
        await conn.execute(sql)
        await conn.execute(sql)
        assert [await _flag(conn, t) for t in (waiting, asking, bare)] == [True, False, False]
    finally:
        await tx.rollback()
        await conn.close()


async def test_the_column_follows_checkpoint_writes_and_cannot_be_written() -> None:
    conn = await asyncpg.connect(DB_URL)
    tx = conn.transaction()
    await tx.start()
    try:
        user, _, thread = await seed_user(conn)
        task = await _insert(conn, user, thread, status="running", checkpoint=PLAIN)
        assert await _flag(conn, task) is False
        # The worker's spawn write, then its fan-in write.
        await conn.execute(
            "UPDATE public.tasks SET status = 'paused', checkpoint = $2::jsonb WHERE id = $1",
            uuid.UUID(task),
            json.dumps(AWAITING),
        )
        assert await _flag(conn, task) is True
        await conn.execute(
            "UPDATE public.tasks SET status = 'running', checkpoint = $2::jsonb WHERE id = $1",
            uuid.UUID(task),
            json.dumps(PLAIN),
        )
        assert await _flag(conn, task) is False
        with pytest.raises(asyncpg.PostgresError):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE public.tasks SET awaiting_children = true WHERE id = $1",
                    uuid.UUID(task),
                )
    finally:
        await tx.rollback()
        await conn.close()


async def test_the_column_functions_agree_with_0047s_row_functions() -> None:
    conn = await asyncpg.connect(DB_URL)
    tx = conn.transaction()
    await tx.start()
    try:
        user, _, thread = await seed_user(conn)
        root = await _insert(conn, user, thread, checkpoint=PLAIN, minutes_ago=9)
        dead = await _insert(conn, user, thread, status="failed", previous=root, minutes_ago=8)
        held = await _insert(conn, user, thread, status="paused", previous=root, minutes_ago=7)
        applied = await _insert(
            conn, user, thread, status="failed", previous=held, applied=True, minutes_ago=6
        )
        child = await _insert(conn, user, thread, status="paused", parent=applied, minutes_ago=5)
        other_root = await _insert(conn, user, thread, status="done", minutes_ago=4)
        rows = await conn.fetch(
            "SELECT t.id, public.task_run_is_current(t) AS row_current, "
            "public.task_run_is_current_by(t.id, t.user_id, t.previous_run_id, t.status, "
            "t.answers_applied_at) AS col_current, "
            "public.task_current_run_id(t) AS row_id, "
            "public.task_current_run_id_by(t.id, t.user_id, t.parent_task_id, t.root_run_id) "
            "AS col_id FROM public.tasks t WHERE t.user_id = $1",
            uuid.UUID(user),
        )
        by_id = {str(r["id"]): r for r in rows}
        for r in rows:
            assert r["row_current"] == r["col_current"], dict(r)
            assert r["row_id"] == r["col_id"], dict(r)
        current = {t for t, r in by_id.items() if r["col_current"]}
        assert current == {applied, child, other_root}
        assert str(by_id[root]["col_id"]) == applied
        assert str(by_id[dead]["col_id"]) == applied
        assert str(by_id[child]["col_id"]) == child
        # The cap counts tasks by the same rule (`applied` failed: none active).
        assert await conn.fetchval("SELECT private.active_task_count($1)", uuid.UUID(user)) == 0
    finally:
        await tx.rollback()
        await conn.close()
