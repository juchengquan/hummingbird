"""Migration 0046 (Q63) applied by hand to a database that already holds
interactive resumes written by the code before it (no stamp).

Each test seeds rows inside a transaction, applies 0046 twice (it is
idempotent) and rolls everything back.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from agent_py import store

from .task_world import DB_URL, pg_only, seed_user

pytestmark = [pg_only, pytest.mark.asyncio]

M0046 = (
    Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0046_chat_answer_once.sql"
)
INTERRUPT = {"type": "interrupt", "interrupts": [{"id": "q", "reason": "approval"}]}


@dataclass
class Db:
    conn: asyncpg.Connection
    user: str
    thread: str

    async def run(
        self,
        status: str,
        *,
        previous: str | None = None,
        mode: str = "interactive",
        applied: bool = False,
        events: tuple[str, ...] = (),
    ) -> str:
        run_id = uuid.uuid4()
        await self.conn.execute(
            "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
            "status, outcome, previous_run_id, answers_applied_at, finished_at) "
            "VALUES ($1, $2, $3, $4, $5, 'g', $6, $7::jsonb, $8, "
            "CASE WHEN $9 THEN now() - interval '1 hour' END, "
            "CASE WHEN $6 IN ('running', 'queued') THEN NULL ELSE now() END)",
            run_id,
            uuid.UUID(self.user),
            mode,
            uuid.UUID(self.thread),
            uuid.UUID(self.thread) if mode == "background" else None,
            status,
            json.dumps(INTERRUPT) if status == "paused" else None,
            uuid.UUID(previous) if previous else None,
            applied,
        )
        for seq, kind in enumerate(events, start=1):
            await self.conn.execute(
                "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
                "VALUES ($1, $2, $3, 1, $4, '{}'::jsonb)",
                run_id,
                uuid.UUID(self.user),
                seq,
                kind,
            )
        return str(run_id)

    async def applied_at(self, run_id: str) -> Any:
        return await self.conn.fetchval(
            "SELECT answers_applied_at FROM public.tasks WHERE id = $1", uuid.UUID(run_id)
        )

    async def status(self, run_id: str) -> str:
        return str(
            await self.conn.fetchval(
                "SELECT status FROM public.tasks WHERE id = $1", uuid.UUID(run_id)
            )
        )

    async def migrate(self) -> None:
        await self.conn.execute(M0046.read_text())
        first = await self.snapshot()
        await self.conn.execute(M0046.read_text())
        assert await self.snapshot() == first, "0046 is not idempotent"

    async def snapshot(self) -> list[tuple[Any, ...]]:
        rows = await self.conn.fetch(
            "SELECT id, status, outcome::text, finished_at, updated_at, answers_applied_at, "
            "answered_question_ids FROM public.tasks WHERE user_id = $1 ORDER BY id",
            uuid.UUID(self.user),
        )
        return [tuple(r) for r in rows]

    async def resume(self, previous: str) -> tuple[str | None, str | None]:
        """`create_run` of an interactive resume as the user, undone:
        (SQLSTATE, constraint), (None, None) when accepted."""
        attempt = self.conn.transaction()
        await attempt.start()
        try:
            await store._set_user_context(self.conn, user_id=self.user)
            await self.conn.execute(
                "SELECT * FROM public.create_run($1, $2, 'interactive', NULL, $3)",
                uuid.uuid4(),
                uuid.UUID(self.thread),
                uuid.UUID(previous),
            )
        except asyncpg.PostgresError as exc:
            return str(exc.sqlstate), getattr(exc, "constraint_name", None)
        finally:
            await attempt.rollback()
        return None, None


@pytest_asyncio.fixture
async def db() -> AsyncIterator[Db]:
    conn = await asyncpg.connect(DB_URL)
    tx = conn.transaction()
    await tx.start()
    try:
        user, _workspace, thread = await seed_user(conn)
        yield Db(conn, user, thread)
    finally:
        await tx.rollback()
        await conn.close()


APPLIED = ("23505", "tasks_answer_applied")
LIVE = ("23505", "tasks_one_live_resume")


async def test_old_interactive_resumes_count_as_applied_unless_their_harness_never_started(
    db: Db,
) -> None:
    ran = await db.run("paused")
    ran_resume = await db.run(
        "failed", previous=ran, events=("step_start", "tool_output", "result")
    )
    refused = await db.run("paused")
    refused_resume = await db.run("failed", previous=refused, events=("result",))
    stopped = await db.run("paused")
    stopped_resume = await db.run("cancelled", previous=stopped, events=("status",))
    purged = await db.run("paused")
    purged_resume = await db.run("cancelled", previous=purged)
    dying = await db.run("paused")
    dying_resume = await db.run("running", previous=dying, events=("step_start",))
    over = await db.run("done")
    over_resume = await db.run("failed", previous=over, events=("step_start", "result"))

    await db.migrate()

    assert await db.applied_at(ran_resume) is not None
    assert await db.applied_at(refused_resume) is None
    assert await db.applied_at(stopped_resume) is None
    assert await db.applied_at(purged_resume) is not None, "a purged log is doubtful"
    assert await db.applied_at(dying_resume) is not None
    assert await db.applied_at(over_resume) is None, "its run no longer waits: untouched"

    assert await db.resume(ran) == APPLIED
    assert await db.resume(purged) == APPLIED
    assert await db.resume(refused) == (None, None)
    assert await db.resume(stopped) == (None, None)
    assert await db.resume(dying) == LIVE
    for paused in (ran, refused, stopped, purged, dying):
        assert await db.status(paused) == "paused", "the paused run stays as it is (Q64)"


async def test_an_applied_resume_refuses_by_its_status(db: Db) -> None:
    for status, expected in [
        ("failed", APPLIED),
        ("cancelled", APPLIED),
        ("running", LIVE),
        ("done", LIVE),
    ]:
        paused = await db.run("paused")
        await db.run(status, previous=paused, applied=True)
        assert await db.resume(paused) == expected, status


async def test_a_resume_that_never_applied_frees_the_question(db: Db) -> None:
    paused = await db.run("paused")
    await db.run("failed", previous=paused)
    await db.run("cancelled", previous=paused)
    assert await db.resume(paused) == (None, None)


async def test_deleting_an_applied_resume_ends_the_paused_run(db: Db) -> None:
    paused = await db.run("paused")
    resume = await db.run("failed", previous=paused, applied=True)
    unapplied_paused = await db.run("paused")
    unapplied = await db.run("failed", previous=unapplied_paused)
    await db.conn.execute(
        "DELETE FROM public.tasks WHERE id = ANY($1::uuid[])",
        [uuid.UUID(resume), uuid.UUID(unapplied)],
    )
    assert await db.status(paused) == "failed"
    assert await db.resume(paused) == ("55000", None)
    assert await db.status(unapplied_paused) == "paused"
    assert await db.resume(unapplied_paused) == (None, None)


async def test_background_rows_are_untouched(db: Db) -> None:
    paused = await db.run("paused", mode="background")
    resume = await db.run(
        "failed", previous=paused, mode="background", events=("step_start", "result")
    )
    before = await db.snapshot()
    await db.migrate()
    assert await db.snapshot() == before
    assert await db.applied_at(resume) is None
