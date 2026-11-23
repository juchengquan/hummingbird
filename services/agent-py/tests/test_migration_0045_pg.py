"""Migration 0045 applied by hand to a database that already holds
tasks, jobs, half-answered questions and waiting parents (wave 5c).

Each test rolls 0045 back inside a transaction (the migration header's
rollback + 0043), seeds what the old code left, applies 0045 (twice: it
is idempotent) and rolls everything back.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from agent_py import store

from .task_world import DB_URL, pg_only, seed_user

pytestmark = [pg_only, pytest.mark.asyncio]

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
M0043 = MIGRATIONS / "0043_answer_once.sql"
M0045 = MIGRATIONS / "0045_background_tasks_correct.sql"

ROLLBACK = """
drop trigger if exists tasks_terminal_is_final on public.tasks;
drop trigger if exists tasks_ended on public.tasks;
drop trigger if exists tasks_deleted on public.tasks;
drop trigger if exists tasks_lock_caller on public.tasks;
drop function if exists public.cancel_task(uuid);
alter table public.tasks
  drop column if exists answered_question_ids,
  drop column if exists answers_applied_at;
"""

TURN = [
    {"role": "user", "content": "Do it"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "q", "name": "send"}]},
]


@dataclass
class Old:
    conn: asyncpg.Connection
    user: str
    thread: str

    async def task(
        self,
        status: str,
        *,
        checkpoint: dict[str, Any] | None = None,
        outcome: dict[str, Any] | None = None,
        previous: str | None = None,
        parent: str | None = None,
        pending: int = 0,
        mode: str = "background",
        age: timedelta = timedelta(minutes=5),
    ) -> str:
        task = uuid.uuid4()
        await self.conn.execute(
            "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
            "status, checkpoint, outcome, previous_run_id, parent_task_id, pending_children, "
            "created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'old', $6, $7::jsonb, "
            "$8::jsonb, $9, $10, $11, now() - $12::interval, now() - $12::interval)",
            task,
            uuid.UUID(self.user),
            mode,
            uuid.UUID(self.thread),
            uuid.UUID(self.thread) if mode == "background" else None,
            status,
            json.dumps(checkpoint if checkpoint is not None else {"messages": TURN, "config": {}}),
            None if outcome is None else json.dumps(outcome),
            uuid.UUID(previous) if previous else None,
            uuid.UUID(parent) if parent else None,
            pending,
            age,
        )
        return str(task)

    async def approval(
        self, task: str, seq: int, question: str, phase: str = "request", minutes_ago: int = 10
    ) -> None:
        await self.conn.execute(
            "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload, "
            "created_at) VALUES ($1, $2, $3, 1, 'approval', $4::jsonb, "
            "now() - make_interval(mins => $5))",
            uuid.UUID(task),
            uuid.UUID(self.user),
            seq,
            json.dumps({"approvalId": question, "phase": phase, "requestKind": "approval"}),
            minutes_ago,
        )

    async def job(
        self, task: str, action: str, status: str, payload: dict[str, Any] | None = None
    ) -> None:
        await self.conn.execute(
            "INSERT INTO public.task_jobs (task_id, user_id, action, payload, status) "
            "VALUES ($1, $2, $3, $4::jsonb, $5)",
            uuid.UUID(task),
            uuid.UUID(self.user),
            action,
            json.dumps(payload or {}),
            status,
        )

    async def migrate(self) -> None:
        await self.conn.execute(M0045.read_text())
        first = await self.snapshot()
        await self.conn.execute(M0045.read_text())
        assert await self.snapshot() == first, "0045 is not idempotent"

    async def snapshot(self) -> tuple[list[tuple[Any, ...]], int]:
        rows = await self.conn.fetch(
            "SELECT id, status, outcome::text, pending_children, finished_at, "
            "answered_question_ids, answers_applied_at FROM public.tasks "
            "WHERE user_id = $1 ORDER BY id",
            uuid.UUID(self.user),
        )
        count = await self.conn.fetchval(
            "SELECT count(*) FROM public.task_jobs WHERE user_id = $1", uuid.UUID(self.user)
        )
        return [tuple(r) for r in rows], count

    async def row(self, task: str) -> dict[str, Any]:
        found = await self.conn.fetchrow(
            "SELECT * FROM public.tasks WHERE id = $1", uuid.UUID(task)
        )
        return dict(found)

    async def status(self, task: str) -> str:
        return str((await self.row(task))["status"])

    async def _as_user(self, sql: str, *args: Any) -> str | None:
        """SQLSTATE of `sql` run as the user, undone; None: accepted."""
        attempt = self.conn.transaction()
        await attempt.start()
        try:
            await store._set_user_context(self.conn, user_id=self.user)
            await self.conn.execute(sql, *args)
        except asyncpg.PostgresError as exc:
            return str(exc.sqlstate)
        finally:
            await attempt.rollback()
        return None

    async def respond(self, task: str, question: str) -> str | None:
        return await self._as_user(
            "SELECT public.enqueue_task_job($1, 'respond', $2::jsonb)",
            uuid.UUID(task),
            json.dumps({"requestId": question, "approved": True}),
        )

    async def resume(self, task: str, question: str) -> str | None:
        answers = {"answers": [{"interruptId": question, "status": "cancelled"}]}
        return await self._as_user(
            "SELECT * FROM public.create_run($1, $2, 'background', 'g', $3, 5, $4::jsonb)",
            uuid.uuid4(),
            uuid.UUID(self.thread),
            uuid.UUID(task),
            json.dumps({"messages": TURN, "config": {}, "resume": answers}),
        )


@pytest_asyncio.fixture
async def old() -> AsyncIterator[Old]:
    conn = await asyncpg.connect(DB_URL, statement_cache_size=0)  # the schema changes
    tx = conn.transaction()
    await tx.start()
    try:
        await conn.execute(ROLLBACK)
        await conn.execute(M0043.read_text())
        user, _, thread = await seed_user(conn)
        yield Old(conn, user, thread)
    finally:
        await tx.rollback()
        await conn.close()


def resume_checkpoint(question: str = "q") -> dict[str, Any]:
    answers = [{"interruptId": question, "status": "resolved", "payload": {"approved": True}}]
    return {"messages": TURN, "config": {}, "resume": {"answers": answers}}


async def test_a_paused_question_stays_answerable_and_gets_finished_at(old: Old) -> None:
    task = await old.task("paused")
    await old.approval(task, 2, "q")
    await old.migrate()
    row = await old.row(task)
    assert row["status"] == "paused" and row["finished_at"] == row["updated_at"]
    assert await old.respond(task, "q") is None
    assert await old.resume(task, "q") is None
    assert await old.respond(task, "another") == "55000"


async def test_a_task_stuck_by_the_per_task_marker_can_answer_its_second_question(old: Old) -> None:
    task = await old.task("paused")
    await old.approval(task, 2, "q1", minutes_ago=30)
    await old.job(task, "respond", "done", {"requestId": "q1", "approved": True})
    await old.approval(task, 3, "q1", "response", minutes_ago=29)
    await old.approval(task, 4, "q2")
    assert await old.resume(task, "q2") == "55000", "0043's marker"
    await old.migrate()
    assert await old.resume(task, "q2") is None
    assert await old.respond(task, "q2") is None
    assert await old.respond(task, "q1") == "55000"


async def test_a_failed_respond_job_does_not_poison_and_a_queued_one_holds(old: Old) -> None:
    failed, queued = await old.task("paused"), await old.task("paused")
    for task, status in ((failed, "failed"), (queued, "queued")):
        await old.approval(task, 2, "q")
        await old.job(task, "respond", status, {"requestId": "q"})
    await old.migrate()
    assert await old.resume(failed, "q") is None
    assert await old.respond(failed, "q") is None
    assert await old.resume(queued, "q") == "55000"
    assert await old.respond(queued, "q") == "55000"


@pytest.mark.parametrize("status", ["failed", "cancelled"])
async def test_an_old_resume_reopens_only_when_it_never_applied(old: Old, status: str) -> None:
    unapplied_of, applied_of = await old.task("paused"), await old.task("paused")
    for task in (unapplied_of, applied_of):
        await old.approval(task, 2, "q")
    unapplied = await old.task(
        status, previous=unapplied_of, checkpoint=resume_checkpoint(), age=timedelta(minutes=1)
    )
    applied = await old.task(status, previous=applied_of, age=timedelta(minutes=1))
    await old.migrate()
    assert (await old.row(unapplied))["answers_applied_at"] is None
    assert (await old.row(applied))["answers_applied_at"] is not None
    for resume in (unapplied, applied):
        assert (await old.row(resume))["answered_question_ids"] == ["q"]
    assert await old.resume(unapplied_of, "q") is None
    assert await old.respond(unapplied_of, "q") is None
    assert await old.resume(applied_of, "q") == "23505"
    assert await old.respond(applied_of, "q") == "55000"


async def test_an_applied_resume_holds_only_its_own_question(old: Old) -> None:
    task = await old.task("paused")
    await old.approval(task, 2, "q1", minutes_ago=30)
    await old.task("failed", previous=task, age=timedelta(minutes=20))  # 0043 then freed q1
    await old.approval(task, 3, "q1", "response", minutes_ago=15)
    await old.approval(task, 4, "q2", minutes_ago=10)
    await old.migrate()
    assert await old.respond(task, "q2") is None
    assert await old.resume(task, "q2") is None


async def test_a_cross_mode_resume_from_before_counts_as_applied(old: Old) -> None:
    task = await old.task("paused")
    await old.approval(task, 2, "q")
    await old.task("failed", previous=task, mode="interactive", age=timedelta(minutes=1))
    await old.migrate()
    assert await old.respond(task, "q") == "55000"


async def test_a_superseded_question_is_not_live(old: Old) -> None:
    task = await old.task("paused")
    await old.approval(task, 2, "dead", minutes_ago=20)
    await old.approval(task, 5, "live")
    await old.migrate()
    assert await old.respond(task, "dead") == "55000"
    assert await old.respond(task, "live") is None


async def test_a_cancel_that_a_pause_overwrote_is_cancelled_again(old: Old) -> None:
    task = await old.task("paused", outcome={"type": "cancelled"})
    await old.approval(task, 2, "q")
    resume = await old.task("queued", previous=task, checkpoint=resume_checkpoint())
    await old.job(resume, "start", "queued")
    child = await old.task("running", parent=task)
    await old.migrate()
    for row in (task, resume, child):
        assert await old.status(row) == "cancelled"
    assert await old.respond(task, "q") == "55000"


async def test_what_an_ended_run_left_live_is_cancelled(old: Old) -> None:
    cancelled, failed = await old.task("cancelled"), await old.task("failed")
    resume = await old.task("queued", previous=cancelled, checkpoint=resume_checkpoint())
    await old.job(resume, "start", "queued")
    child = await old.task("paused", parent=failed)
    await old.migrate()
    assert await old.status(resume) == "cancelled"
    assert await old.status(child) == "cancelled"
    assert await old.status(failed) == "failed"


async def test_queued_rows(old: Old) -> None:
    orphan = await old.task("queued", age=timedelta(hours=2))
    recent = await old.task("queued")
    waiting = await old.task("queued", age=timedelta(hours=2))
    await old.job(waiting, "start", "queued")
    executing = await old.task("queued", age=timedelta(hours=2))
    await old.job(executing, "start", "done")
    await old.job(executing, "continue", "queued")
    await old.migrate()
    assert await old.status(orphan) == "failed"
    assert "never queued" in (await old.row(orphan))["outcome"]
    assert await old.status(recent) == "queued"
    assert await old.status(waiting) == "queued"
    assert await old.status(executing) == "running"


def waiting_parent() -> dict[str, Any]:
    awaiting = {"tool_call_id": "q", "children": []}
    return {"messages": TURN, "config": {}, "awaiting_children": awaiting}


async def test_waiting_parents(old: Old) -> None:
    working = await old.task("paused", checkpoint=waiting_parent(), pending=3)
    for status in ("running", "paused", "cancelled"):
        await old.task(status, parent=working)
    recent = await old.task("paused", checkpoint=waiting_parent(), pending=1)
    await old.task("cancelled", parent=recent)
    stale = await old.task("paused", checkpoint=waiting_parent(), pending=1, age=timedelta(days=9))
    await old.task("cancelled", parent=stale, age=timedelta(days=9))
    resuming = await old.task("paused", checkpoint=waiting_parent(), age=timedelta(days=9))
    await old.job(resuming, "continue", "queued")
    await old.migrate()

    async def jobs(task: str) -> list[str]:
        rows = await old.conn.fetch(
            "SELECT action FROM public.task_jobs WHERE task_id = $1", uuid.UUID(task)
        )
        return [r["action"] for r in rows]

    row = await old.row(working)
    assert (row["status"], row["pending_children"], row["finished_at"]) == ("paused", 2, None)
    assert await jobs(working) == []
    # Q62: migrating never starts a model call, however recently it moved.
    row = await old.row(recent)
    assert (row["status"], row["pending_children"]) == ("failed", 0)
    assert await jobs(recent) == []
    assert await old.status(stale) == "failed" and await jobs(stale) == []
    assert await old.status(resuming) == "paused" and await jobs(resuming) == ["continue"]


async def test_ended_rows_are_left_alone(old: Old) -> None:
    done = await old.task("done", outcome={"type": "success", "result": {"text": "x"}})
    before = await old.row(done)
    await old.migrate()
    after = await old.row(done)
    assert {k: after[k] for k in before} == before
