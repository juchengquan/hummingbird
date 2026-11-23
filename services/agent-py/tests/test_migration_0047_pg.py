"""Migration 0047 (wave 6): a task's identity, delivery mark and cap, on a
real Postgres (`bun run test:db`).

* Upgrade: rows of every shape the code before 0047 wrote — chains,
  children, a broken chain, interactive runs, a second user's rows,
  schedules — with 0047 undone inside a transaction (its header's
  rollback plus its columns), then applied twice (it is idempotent).
* The rules on a database already at 0047: the current run (Q75), the cap
  (Q72, Q79) under two concurrent connections and a second user, schedule
  fires at the cap, the delivery mark (Q77), a background answer that was
  applied (`tasks_answer_applied`), the sub-agent count.

Every test either rolls back its transaction or deletes the users it made.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from agent_py import store
from agent_py.runs.model import RunOwner
from agent_py.runs.repository import RunSpec
from agent_py.runs.repository_pg import PgRunRepository, RunWriteError

from .task_world import DB_URL, pg_only, seed_user

pytestmark = [pg_only, pytest.mark.asyncio]

M0047 = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "0047_task_identity_and_caps.sql"
)

# The header's rollback, plus the columns (which it lets stay) — so the
# database is what 0046 left.
UNDO_0047 = """
drop trigger if exists tasks_identity on public.tasks;
drop function if exists public.create_scheduled_task(uuid, uuid, uuid, text, integer, jsonb);
drop function if exists public.mark_task_delivered(uuid);
drop index if exists public.tasks_user_root_idx;
alter table public.tasks
  drop column if exists root_run_id,
  drop column if exists research,
  drop column if exists result_delivered_at;
"""

TURN = [
    {"role": "user", "content": "Do it"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "q", "name": "send"}]},
]
INTERRUPT = {"type": "interrupt", "interrupts": [{"id": "q", "reason": "approval"}]}
LIMIT = ("54000", None)


def _cp(**config: Any) -> dict[str, Any]:
    return {"messages": TURN, "config": dict(config)}


def _answers(question: str = "q") -> dict[str, Any]:
    return {
        **_cp(),
        "resume": {"answers": [{"interruptId": question, "status": "cancelled"}]},
    }


@dataclass
class Db:
    conn: asyncpg.Connection
    user: str
    thread: str
    workspace: str
    others: list[str] = field(default_factory=list)

    # -- seeding (as the DSN role, like the workers) ----------------------------

    async def task(
        self,
        status: str,
        *,
        previous: str | None = None,
        parent: str | None = None,
        mode: str = "background",
        applied: bool = False,
        checkpoint: dict[str, Any] | None = None,
        user: str | None = None,
        thread: str | None = None,
        answered: list[str] | None = None,
        minutes_ago: int = 5,
    ) -> str:
        task = uuid.uuid4()
        owner = uuid.UUID(user or self.user)
        thread_id = uuid.UUID(thread or self.thread)
        cp = checkpoint if checkpoint is not None else _cp()
        asks = status == "paused" and parent is None and "awaiting_children" not in cp
        outcome = INTERRUPT if asks else None
        await self.conn.execute(
            "INSERT INTO public.tasks (id, user_id, mode, thread_id, conversation_id, goal, "
            "status, checkpoint, outcome, previous_run_id, parent_task_id, answers_applied_at, "
            "answered_question_ids, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'g', $6, "
            "$7::jsonb, $8::jsonb, $9, $10, CASE WHEN $11 THEN now() END, $12, "
            "now() - make_interval(mins => $13), now() - make_interval(mins => $13))",
            task,
            owner,
            mode,
            thread_id,
            thread_id if mode == "background" else None,
            status,
            json.dumps(cp),
            None if outcome is None else json.dumps(outcome),
            uuid.UUID(previous) if previous else None,
            uuid.UUID(parent) if parent else None,
            applied,
            answered,
            minutes_ago,
        )
        return str(task)

    async def row(self, task: str) -> dict[str, Any]:
        found = await self.conn.fetchrow(
            "SELECT * FROM public.tasks WHERE id = $1", uuid.UUID(task)
        )
        assert found is not None
        return dict(found)

    async def root(self, task: str) -> str:
        return str((await self.row(task))["root_run_id"])

    async def current(self, task: str) -> str:
        return str(
            await self.conn.fetchval(
                "SELECT public.task_current_run_id(t) FROM public.tasks t WHERE t.id = $1",
                uuid.UUID(task),
            )
        )

    async def is_current(self, task: str) -> bool:
        return bool(
            await self.conn.fetchval(
                "SELECT public.task_run_is_current(t) FROM public.tasks t WHERE t.id = $1",
                uuid.UUID(task),
            )
        )

    async def active(self, user: str | None = None) -> int:
        return int(
            await self.conn.fetchval(
                "SELECT private.active_task_count($1)", uuid.UUID(user or self.user)
            )
        )

    # -- as the user, undone ------------------------------------------------------

    async def as_user(self, sql: str, *args: Any, user: str | None = None) -> tuple[Any, ...]:
        """(SQLSTATE, constraint) of `sql` run as the user, undone; (None,
        None, value) when accepted."""
        attempt = self.conn.transaction()
        await attempt.start()
        try:
            await store._set_user_context(self.conn, user_id=user or self.user)
            value = await self.conn.fetchval(sql, *args)
        except asyncpg.PostgresError as exc:
            return str(exc.sqlstate), getattr(exc, "constraint_name", None)
        finally:
            await attempt.rollback()
        return None, None, value

    async def keep_as_user(self, sql: str, *args: Any) -> Any:
        """`sql` run as the user, kept (in the test's transaction)."""
        await store._set_user_context(self.conn, user_id=self.user)
        try:
            return await self.conn.fetchval(sql, *args)
        finally:
            await self.conn.execute("RESET ROLE")

    async def start(self, *, user: str | None = None, thread: str | None = None) -> tuple[Any, ...]:
        return await self.as_user(
            "SELECT status FROM public.create_run($1, $2, 'background', 'g', NULL, 5, $3::jsonb)",
            uuid.uuid4(),
            uuid.UUID(thread or self.thread),
            json.dumps(_cp()),
            user=user,
        )

    async def start_old(self) -> tuple[Any, ...]:
        return await self.as_user(
            "SELECT public.create_task_run($1, $2, 'g', 5, $3::jsonb)",
            uuid.uuid4(),
            uuid.UUID(self.thread),
            json.dumps(_cp()),
        )

    async def resume(self, previous: str, question: str = "q") -> tuple[Any, ...]:
        return await self.as_user(
            "SELECT status FROM public.create_run($1, $2, 'background', 'g', $3, 5, $4::jsonb)",
            uuid.uuid4(),
            uuid.UUID(self.thread),
            uuid.UUID(previous),
            json.dumps(_answers(question)),
        )

    async def deliver(self, task: str, *, user: str | None = None) -> tuple[Any, ...]:
        return await self.as_user(
            "SELECT public.mark_task_delivered($1)", uuid.UUID(task), user=user
        )


@pytest_asyncio.fixture
async def db() -> AsyncIterator[Db]:
    conn = await asyncpg.connect(DB_URL, statement_cache_size=0)  # the schema changes
    tx = conn.transaction()
    await tx.start()
    try:
        user, workspace, thread = await seed_user(conn)
        yield Db(conn, user, thread, workspace)
    finally:
        await tx.rollback()
        await conn.close()


# --- Upgrade -----------------------------------------------------------------------


async def _schedule(db: Db, *, enabled: bool, model: str | None) -> str:
    schedule = uuid.uuid4()
    await db.conn.execute(
        "INSERT INTO public.task_schedules (id, user_id, workspace_id, name, prompt, cron, "
        "enabled, model, next_run_at) VALUES ($1, $2, $3, 's', 'p', '0 8 * * *', $4, $5, now())",
        schedule,
        uuid.UUID(db.user),
        uuid.UUID(db.workspace),
        enabled,
        model,
    )
    return str(schedule)


async def _enabled(db: Db, schedule: str) -> bool:
    return bool(
        await db.conn.fetchval(
            "SELECT enabled FROM public.task_schedules WHERE id = $1", uuid.UUID(schedule)
        )
    )


async def _snapshot(db: Db) -> list[tuple[Any, ...]]:
    rows = await db.conn.fetch(
        "SELECT id, status, outcome::text, checkpoint::text, updated_at, root_run_id, research, "
        "result_delivered_at FROM public.tasks ORDER BY id"
    )
    return [tuple(r) for r in rows]


async def test_upgrade_from_0046_fills_every_shape_and_is_idempotent(db: Db) -> None:
    await db.conn.execute(UNDO_0047)
    other_user, _, other_thread = await seed_user(db.conn)

    research = await db.task("done", checkpoint=_cp(mode="research"))
    p0 = await db.task("paused", minutes_ago=50)
    r1 = await db.task("paused", previous=p0, applied=True, minutes_ago=40)
    child = await db.task("done", parent=r1, minutes_ago=35)
    grandchild = await db.task("done", parent=child, minutes_ago=34)
    r2 = await db.task("done", previous=r1, applied=True, minutes_ago=30)
    dead = await db.task("failed", previous=p0, minutes_ago=45)
    # A chain whose middle run was deleted (previous_run_id → NULL).
    x0 = await db.task("paused", minutes_ago=20)
    x1 = await db.task("failed", previous=x0, minutes_ago=19)
    x2 = await db.task("done", previous=x1, minutes_ago=18)
    await db.conn.execute("DELETE FROM public.tasks WHERE id = $1", uuid.UUID(x1))
    interactive = await db.task("paused", mode="interactive")
    interactive_resume = await db.task("running", mode="interactive", previous=interactive)
    # A link into another user's run is never followed.
    theirs = await db.task("paused", user=other_user, thread=other_thread)
    crossed = await db.task("failed", previous=theirs)

    null_model = await _schedule(db, enabled=True, model=None)
    with_model = await _schedule(db, enabled=True, model="anthropic/claude-haiku-4.5")
    off = await _schedule(db, enabled=False, model=None)

    updated_before = {t: (await db.row(t))["updated_at"] for t in (p0, r2, child)}
    await db.conn.execute(M0047.read_text())

    assert await db.root(research) == research
    for row in (p0, r1, child, grandchild, r2, dead):
        assert await db.root(row) == p0, row
    assert await db.root(x0) == x0
    assert await db.root(x2) == x2, "a broken chain roots at its earliest reachable row"
    assert await db.root(interactive_resume) == interactive
    assert await db.root(crossed) == crossed
    assert await db.root(theirs) == theirs
    assert (await db.row(research))["research"] is True
    assert (await db.row(p0))["research"] is False
    # Tasks that ended before 0047 count as delivered (their results were
    # written by the old path), so the first browser after wave 6 writes
    # nothing old. Only roots of background tasks whose current run ended.
    for task in (research, p0, x2, crossed):
        assert (await db.row(task))["result_delivered_at"] is not None, task
    for task in (r1, r2, child, dead, x0, interactive, theirs):
        assert (await db.row(task))["result_delivered_at"] is None, task
    for task, updated in updated_before.items():
        assert (await db.row(task))["updated_at"] == updated, "backfill leaves updated_at"

    assert not await _enabled(db, null_model), "Q73: a schedule without a model is paused"
    assert await _enabled(db, with_model)
    assert not await _enabled(db, off)

    # Idempotent; the pause runs once: a schedule its owner re-enabled stays on.
    first = await _snapshot(db)
    await db.conn.execute(
        "UPDATE public.task_schedules SET enabled = true WHERE id = $1", uuid.UUID(null_model)
    )
    # A task that ends after 0047 is delivered by a browser, never by a re-run.
    later = await db.task("done", minutes_ago=1)
    await db.conn.execute("UPDATE public.tasks SET root_run_id = id WHERE id = $1", uuid.UUID(later))
    first = await _snapshot(db)
    await db.conn.execute(M0047.read_text())
    assert await _snapshot(db) == first
    assert await _enabled(db, null_model)
    assert (await db.row(later))["result_delivered_at"] is None


# --- Identity at insert ---------------------------------------------------------------


async def test_inserts_get_their_root_and_research(db: Db) -> None:
    root = str(
        await db.keep_as_user(
            "SELECT id FROM public.create_run($1, $2, 'background', 'g', NULL, 5, $3::jsonb)",
            uuid.uuid4(),
            uuid.UUID(db.thread),
            json.dumps(_cp(mode="research")),
        )
    )
    assert await db.root(root) == root
    assert (await db.row(root))["research"] is True
    old = str(
        await db.keep_as_user(
            "SELECT id FROM public.create_run($1, $2, 'background', 'g', NULL, 5, $3::jsonb)",
            uuid.uuid4(),
            uuid.UUID(db.thread),
            json.dumps(_cp()),
        )
    )
    assert await db.root(old) == old and (await db.row(old))["research"] is False
    await db.conn.execute(
        "UPDATE public.tasks SET status = 'paused', outcome = $2::jsonb WHERE id = $1",
        uuid.UUID(root),
        json.dumps(INTERRUPT),
    )
    resume = str(
        await db.keep_as_user(
            "SELECT id FROM public.create_run($1, $2, 'background', 'g', $3, 5, $4::jsonb)",
            uuid.uuid4(),
            uuid.UUID(db.thread),
            uuid.UUID(root),
            json.dumps(_answers()),  # a checkpoint without the mode
        )
    )
    assert await db.root(resume) == root
    assert (await db.row(resume))["research"] is True, "a resume inherits research"
    # The Next task route.
    via_next = uuid.uuid4()
    await db.keep_as_user(
        "SELECT public.create_task_run($1, $2, 'g', 5, $3::jsonb)",
        via_next,
        uuid.UUID(db.thread),
        json.dumps(_cp(mode="research")),
    )
    assert await db.root(str(via_next)) == str(via_next)
    assert (await db.row(str(via_next)))["research"] is True
    # The worker's spawn insert (store._SPAWN_CHILD_SQL) names no root.
    child = uuid.uuid4()
    await db.conn.execute(
        "INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, parent_task_id, "
        "checkpoint) VALUES ($1, $2, $3, 'sub', 'queued', $4, '{}'::jsonb)",
        child,
        uuid.UUID(db.user),
        uuid.UUID(db.thread),
        uuid.UUID(resume),
    )
    assert await db.root(str(child)) == root
    assert (await db.row(str(child)))["research"] is False


# --- Current run (Q75) ---------------------------------------------------------------


async def test_the_current_run_is_the_newest_that_holds_the_question(db: Db) -> None:
    alone = await db.task("paused")
    assert await db.current(alone) == alone

    queued_of = await db.task("paused", minutes_ago=10)
    queued = await db.task("queued", previous=queued_of)
    assert await db.current(queued_of) == queued
    assert not await db.is_current(queued_of) and await db.is_current(queued)

    # A resume that failed before applying is a dead branch: the question shows again.
    dead_of = await db.task("paused", minutes_ago=10)
    dead = await db.task("failed", previous=dead_of)
    assert await db.current(dead_of) == dead_of
    assert await db.current(dead) == dead_of
    assert not await db.is_current(dead)

    # One that failed after applying holds it: the task has failed.
    applied_of = await db.task("paused", minutes_ago=10)
    applied = await db.task("failed", previous=applied_of, applied=True)
    assert await db.current(applied_of) == applied

    # Down a chain, past a dead branch.
    p0 = await db.task("paused", minutes_ago=30)
    await db.task("cancelled", previous=p0, minutes_ago=25)
    r1 = await db.task("paused", previous=p0, applied=True, minutes_ago=20)
    r2 = await db.task("done", previous=r1, applied=True, minutes_ago=10)
    child = await db.task("paused", parent=r1)
    for run in (p0, r1, r2):
        assert await db.current(run) == r2
    assert await db.current(child) == child, "a sub-agent run is answered in place"
    assert await db.is_current(child)


# --- The cap (Q72, Q79) ---------------------------------------------------------------


async def test_five_active_tasks_then_both_create_paths_refuse(db: Db) -> None:
    waiting = await db.task("paused")  # on a question
    await db.task("paused", checkpoint={**_cp(), "awaiting_children": {}})
    await db.task("running")
    await db.task("queued")
    # Not active: ended, answered (its resume is current), children, interactive.
    await db.task("done")
    answered = await db.task("paused", minutes_ago=10)
    await db.task("done", previous=answered, applied=True)
    await db.task("running", parent=waiting)
    await db.task("running", mode="interactive")
    assert await db.active() == 4

    assert (await db.start())[:2] == (None, None), "the fifth"
    await db.task("queued")
    assert await db.active() == 5
    assert await db.start() == LIMIT
    assert await db.start_old() == LIMIT
    # Answers are exempt.
    assert (await db.resume(waiting))[:2] == (None, None)
    # Interactive runs are not tasks.
    accepted = await db.as_user(
        "SELECT status FROM public.create_run($1, $2, 'interactive')",
        uuid.uuid4(),
        uuid.UUID(db.thread),
    )
    assert accepted == (None, None, "running")
    # Another user is not affected.
    other, _, other_thread = await seed_user(db.conn)
    assert (await db.start(user=other, thread=other_thread))[:2] == (None, None)
    # An idempotent retry of a run created before the cap filled still answers.
    retry_id = uuid.UUID(answered)
    retried = await db.as_user(
        "SELECT created FROM public.create_run($1, $2, 'background', 'g', NULL, 5, $3::jsonb)",
        retry_id,
        uuid.UUID(db.thread),
        json.dumps(_cp()),
    )
    assert retried == (None, None, False)


async def test_ending_a_task_frees_its_slot(db: Db) -> None:
    tasks = [await db.task("running") for _ in range(5)]
    assert await db.start() == LIMIT
    await db.conn.execute(
        "UPDATE public.tasks SET status = 'done' WHERE id = $1", uuid.UUID(tasks[0])
    )
    assert (await db.start())[:2] == (None, None)


async def test_a_schedule_fire_at_the_cap_is_created_failed(db: Db) -> None:
    async def fire() -> tuple[str, str]:
        task = uuid.uuid4()
        status = await db.conn.fetchval(
            "SELECT public.create_scheduled_task($1, $2, $3, 'Daily', 7, $4::jsonb)",
            task,
            uuid.UUID(db.user),
            uuid.UUID(db.thread),
            json.dumps(_cp(model="anthropic/claude-haiku-4.5")),
        )
        return str(task), str(status)

    for _ in range(4):
        await db.task("running")
    queued, status = await fire()
    assert status == "queued"
    row = await db.row(queued)
    assert (row["status"], row["root_run_id"], row["max_steps"]) == ("queued", row["id"], 7)
    assert json.loads(row["checkpoint"])["config"]["maxSteps"] == 7
    jobs = await db.conn.fetch(
        "SELECT action, status FROM public.task_jobs WHERE task_id = $1", uuid.UUID(queued)
    )
    assert [tuple(j) for j in jobs] == [("start", "queued")]

    skipped, status = await fire()
    assert status == "failed"
    row = await db.row(skipped)
    outcome = json.loads(row["outcome"])
    assert row["status"] == "failed" and row["finished_at"] is not None
    assert outcome["type"] == "error" and outcome["code"] == "limit_reached"
    assert not await db.conn.fetch(
        "SELECT 1 FROM public.task_jobs WHERE task_id = $1", uuid.UUID(skipped)
    )
    events = await db.conn.fetch(
        "SELECT seq, kind, payload::text AS payload FROM public.task_events "
        "WHERE task_id = $1 ORDER BY seq",
        uuid.UUID(skipped),
    )
    assert [(e["seq"], e["kind"]) for e in events] == [(1, "status"), (2, "result")]
    result = json.loads(events[1]["payload"])
    assert result["status"] == "failed" and result["errorCode"] == "limit_reached"
    # Users can't call it.
    assert (
        await db.as_user(
            "SELECT public.create_scheduled_task($1, $2, $3, 'x', 5, $4::jsonb)",
            uuid.uuid4(),
            uuid.UUID(db.user),
            uuid.UUID(db.thread),
            json.dumps(_cp()),
        )
    )[0] == "42501"


async def test_the_repository_maps_the_cap_to_limit_reached() -> None:
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=2)
    async with pool.acquire() as conn:
        user, _, thread = await seed_user(conn)
    try:
        repo = PgRunRepository(pool)
        owner = RunOwner.user(user)

        def spec() -> RunSpec:
            return RunSpec(
                run_id=str(uuid.uuid4()),
                thread_id=thread,
                mode="background",
                goal="g",
                max_steps=3,
                checkpoint=_cp(),
            )

        for _ in range(5):
            await repo.create(owner, spec())
        with pytest.raises(RunWriteError) as refused:
            await repo.create(owner, spec())
        assert (refused.value.status, refused.value.code) == (409, "limit_reached")
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
        await pool.close()


@pytest_asyncio.fixture
async def committed() -> AsyncIterator[tuple[str, str]]:
    """A user with 4 active tasks, committed (other connections see them)."""
    conn = await asyncpg.connect(DB_URL)
    try:
        user, _, thread = await seed_user(conn)
        for _ in range(4):
            await conn.execute(
                "INSERT INTO public.tasks (id, user_id, conversation_id, goal, status) "
                "VALUES ($1, $2, $3, 'g', 'running')",
                uuid.uuid4(),
                uuid.UUID(user),
                uuid.UUID(thread),
            )
        yield user, thread
    finally:
        await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
        await conn.close()


CREATE_RUN = "SELECT status FROM public.create_run($1, $2, 'background', 'g', NULL, 5, $3::jsonb)"
CREATE_TASK_RUN = "SELECT public.create_task_run($1, $2, 'g', 5, $3::jsonb)"


@pytest.mark.parametrize("second", [CREATE_RUN, CREATE_TASK_RUN])
async def test_two_concurrent_starts_at_four_admit_one(
    committed: tuple[str, str], second: str
) -> None:
    user, thread = committed
    first_conn = await asyncpg.connect(DB_URL)
    second_conn = await asyncpg.connect(DB_URL)
    try:
        first_tx = first_conn.transaction()
        await first_tx.start()
        await store._set_user_context(first_conn, user_id=user)
        await first_conn.fetchval(CREATE_RUN, uuid.uuid4(), uuid.UUID(thread), json.dumps(_cp()))

        async def other() -> str | None:
            async with second_conn.transaction():
                await store._set_user_context(second_conn, user_id=user)
                try:
                    await second_conn.fetchval(
                        second, uuid.uuid4(), uuid.UUID(thread), json.dumps(_cp())
                    )
                except asyncpg.PostgresError as exc:
                    return str(exc.sqlstate)
            return None

        racing = asyncio.create_task(other())
        await asyncio.sleep(0.3)
        assert not racing.done(), "the second start waits for the user's task lock"
        await first_tx.commit()
        assert await asyncio.wait_for(racing, 10) == "54000"
        count = await first_conn.fetchval("SELECT private.active_task_count($1)", uuid.UUID(user))
        assert count == 5
    finally:
        await first_conn.close()
        await second_conn.close()


# --- Delivered (Q77) -------------------------------------------------------------------


async def test_only_an_ended_task_root_is_marked_delivered_once(db: Db) -> None:
    done = await db.task("done")
    marked = await db.keep_as_user("SELECT public.mark_task_delivered($1)", uuid.UUID(done))
    assert marked is not None
    assert (await db.row(done))["result_delivered_at"] == marked
    # Idempotent: a second call answers the first mark, it doesn't move it.
    await db.conn.execute(
        "UPDATE public.tasks SET result_delivered_at = now() - interval '1 hour' WHERE id = $1",
        uuid.UUID(done),
    )
    earlier = (await db.row(done))["result_delivered_at"]
    assert await db.deliver(done) == (None, None, earlier)

    p0 = await db.task("paused", minutes_ago=10)
    r1 = await db.task("done", previous=p0, applied=True)
    assert (await db.deliver(p0))[:2] == (None, None), "the root of an ended chain"
    assert await db.deliver(r1) == ("55000", None), "not the root"
    child = await db.task("done", parent=done)
    assert await db.deliver(child) == ("55000", None)
    waiting = await db.task("paused")
    assert await db.deliver(waiting) == ("55000", None), "still waiting on its question"
    running_of = await db.task("paused", minutes_ago=10)
    await db.task("running", previous=running_of)
    assert await db.deliver(running_of) == ("55000", None)
    failed = await db.task("failed")
    assert (await db.deliver(failed))[:2] == (None, None)
    interactive = await db.task("done", mode="interactive")
    assert await db.deliver(interactive) == ("55000", None)

    other, _, _ = await seed_user(db.conn)
    assert await db.deliver(done, user=other) == ("P0002", None)
    # Users can't write the column themselves.
    assert (
        await db.as_user(
            "UPDATE public.tasks SET result_delivered_at = now() WHERE id = $1", uuid.UUID(failed)
        )
    )[0] == "42501"


# --- A background answer that was applied ------------------------------------------------


async def test_a_background_answer_applied_by_an_ended_resume_is_answer_applied(db: Db) -> None:
    for status, applied, expected in [
        ("failed", True, ("23505", "tasks_answer_applied")),
        ("cancelled", True, ("23505", "tasks_answer_applied")),
        ("running", True, ("23505", "tasks_one_live_resume")),
        ("done", False, ("23505", "tasks_one_live_resume")),
    ]:
        paused = await db.task("paused")
        await db.task(status, previous=paused, applied=applied, answered=["q"])
        assert await db.resume(paused) == expected, status
    # One that ended before applying frees the question.
    freed = await db.task("paused")
    await db.task("failed", previous=freed, answered=["q"])
    assert (await db.resume(freed))[:2] == (None, None)


# --- Sub-agents (Q72: 20 per task) ---------------------------------------------------------


async def test_the_child_count_covers_the_whole_task(db: Db) -> None:
    p0 = await db.task("paused", minutes_ago=10)
    r1 = await db.task("running", previous=p0, applied=True)
    first = await db.task("done", parent=p0)
    await db.task("done", parent=first)
    await db.task("queued", parent=r1)
    elsewhere = await db.task("running")
    await db.task("done", parent=elsewhere)

    async def count(task: str) -> int:
        return int(await db.conn.fetchval("SELECT private.task_child_count($1)", uuid.UUID(task)))

    assert await count(r1) == 3
    assert await count(p0) == 3
    assert await count(elsewhere) == 1
