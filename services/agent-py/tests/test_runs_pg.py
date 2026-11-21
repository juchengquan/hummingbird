"""Runs against a real Postgres with the Supabase migrations (0001-0041).

Opt-in: set `AGENT_PY_TEST_DB_URL` to a disposable database (e.g. the
local Supabase CLI stack, or a `supabase/postgres` container with the
migrations applied). Skipped otherwise — CI has no database.

Covers what the fakes can't: `PgRunRepository` over `create_run` and the
0034 / 0041 grants, triggers and RLS (owner-scoped calls really run as
`authenticated`), the pre-0041 log fallback, the reaper's SQL, and the
`/v1/runs` routes with a database (background runs queued through
`enqueue_task_job`).
"""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from typing import Any

import asyncpg
import jwt
import pytest
from fastapi.testclient import TestClient

from agent_py.events import ApprovalEvent, ResultEvent, event_to_row_payload
from agent_py.main import create_app
from agent_py.runs import wiring
from agent_py.runs.model import (
    Cancelled,
    Interrupted,
    PendingInterrupt,
    RunOwner,
    RunResultData,
    Succeeded,
)
from agent_py.runs.repository import (
    InvalidPageToken,
    PreviousRunNotFound,
    RunFilter,
    RunIdConflict,
    RunSpec,
    ThreadNotFound,
)
from agent_py.runs.repository_pg import PgRunRepository, RunWriteError
from agent_py.settings import Settings

DB_URL = os.environ.get("AGENT_PY_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")

SECRET = "pg-test-secret-do-not-use-in-prod-32b!"
CHECKPOINT: dict[str, object] = {
    "messages": [{"role": "user", "content": "hi"}],
    "config": {"model": "m"},
}


def _id() -> str:
    return str(uuid.uuid4())


async def _seed_user(conn: asyncpg.Connection) -> tuple[str, str]:
    """A user + one synced conversation; returns (user_id, conversation_id)."""
    user, ws, conv = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await conn.execute(
        "INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', "
        "'authenticated', $2)",
        user,
        f"{user}@runs.test",
    )
    await conn.execute(
        "INSERT INTO public.workspaces (id, user_id, name) VALUES ($1, $2, 'ws')", ws, user
    )
    await conn.execute(
        "INSERT INTO public.conversations (id, user_id, workspace_id, title) "
        "VALUES ($1, $2, $3, 'c')",
        conv,
        user,
        ws,
    )
    return str(user), str(conv)


@pytest.fixture
async def pool() -> AsyncIterator[asyncpg.Pool]:
    p = await asyncpg.create_pool(DB_URL, min_size=1, max_size=6)
    try:
        yield p
    finally:
        await p.close()


@pytest.fixture
async def users(pool: asyncpg.Pool) -> AsyncIterator[tuple[tuple[str, str], tuple[str, str]]]:
    async with pool.acquire() as conn:
        a = await _seed_user(conn)
        b = await _seed_user(conn)
    try:
        yield a, b
    finally:
        async with pool.acquire() as conn:
            for user, _ in (a, b):
                await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))


def _interactive(thread: str, **kw: Any) -> RunSpec:
    return RunSpec(run_id=kw.pop("run_id", _id()), thread_id=thread, mode="interactive", **kw)


def _background(thread: str, **kw: Any) -> RunSpec:
    return RunSpec(
        run_id=kw.pop("run_id", _id()),
        thread_id=thread,
        mode="background",
        goal="Goal",
        max_steps=3,
        checkpoint=CHECKPOINT,
        **kw,
    )


async def _row(pool: asyncpg.Pool, run_id: str) -> asyncpg.Record:
    async with pool.acquire() as conn:
        return await conn.fetchrow(
            "SELECT status, outcome::text AS outcome, lease_expires_at, checkpoint::text AS "
            "checkpoint, conversation_id, mode FROM public.tasks WHERE id = $1",
            uuid.UUID(run_id),
        )


# --- create ----------------------------------------------------------------------------


async def test_create_interactive_is_idempotent_and_conflicts(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, _), (bob, _) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    thread = _id()  # an interactive thread need not be synced
    spec = _interactive(thread, lease_seconds=30)
    first = await repo.create(me, spec)
    assert first.created
    run = first.run
    assert (run.id, run.thread_id, run.mode, run.internal_status) == (
        spec.run_id,
        thread,
        "interactive",
        "running",
    )
    assert run.lease_expires_at is not None and run.started_at is not None
    row = await _row(pool, spec.run_id)
    assert row["conversation_id"] is None

    again = await repo.create(me, _interactive(thread, run_id=spec.run_id, goal="ignored"))
    assert not again.created and again.run.id == spec.run_id

    for owner, other in (
        (RunOwner.user(bob), _interactive(thread, run_id=spec.run_id)),
        (me, _interactive(_id(), run_id=spec.run_id)),
        (me, _background(thread, run_id=spec.run_id)),
    ):
        with pytest.raises(RunIdConflict):
            await repo.create(owner, other)
    assert await repo.exists(spec.run_id)
    assert not await repo.exists(_id())


async def test_create_background_needs_an_owned_conversation(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, conv), (bob, bob_conv) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    with pytest.raises(ThreadNotFound):
        await repo.create(me, _background(bob_conv))
    with pytest.raises(ThreadNotFound):
        await repo.create(me, _background(_id()))
    with pytest.raises(ValueError):
        await repo.create(me, RunSpec(run_id=_id(), thread_id=conv, mode="background"))
    created = await repo.create(me, _background(conv))
    assert created.created and created.run.internal_status == "queued"
    assert created.run.status == "queued" and created.run.goal == "Goal"
    checkpoint = json.loads((await _row(pool, created.run.id))["checkpoint"])
    assert (checkpoint["step"], checkpoint["seq"], checkpoint["config"]["maxSteps"]) == (0, 1, 3)

    await repo.enqueue_start(me, created.run.id)
    async with pool.acquire() as conn:
        jobs = await conn.fetch(
            "SELECT action, status FROM public.task_jobs WHERE task_id = $1",
            uuid.UUID(created.run.id),
        )
    assert [(j["action"], j["status"]) for j in jobs] == [("start", "queued")]
    with pytest.raises(RunWriteError) as exc:
        await repo.enqueue_start(me, created.run.id)
    assert exc.value.sqlstate == "55000" and exc.value.status == 409
    with pytest.raises(RunWriteError) as foreign:
        await repo.enqueue_start(RunOwner.user(bob), created.run.id)
    assert foreign.value.status == 404


async def test_previous_run_must_be_mine_on_the_thread(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, _), (bob, _) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    thread = _id()
    prev = (await repo.create(me, _interactive(thread))).run
    with pytest.raises(PreviousRunNotFound):
        await repo.create(me, _interactive(_id(), previous_run_id=prev.id))
    with pytest.raises(PreviousRunNotFound):
        await repo.create(RunOwner.user(bob), _interactive(thread, previous_run_id=prev.id))
    nxt = (await repo.create(me, _interactive(thread, previous_run_id=prev.id))).run
    assert nxt.previous_run_id == prev.id


# --- read / settle / cancel ------------------------------------------------------------------


async def test_get_is_owner_scoped_and_settle_writes_the_outcome(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, _), (bob, _) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    run = (await repo.create(me, _interactive(_id()))).run
    assert await repo.get(RunOwner.user(bob), run.id) is None
    assert await repo.get(RunOwner.anonymous("x" * 32), run.id) is None
    assert await repo.heartbeat(run.id, lease_seconds=60)
    assert not await repo.mark_running(run.id)  # already running
    assert await repo.settle(run.id, Succeeded(RunResultData(text="hi", memory_tainted=True)))
    assert not await repo.settle(run.id, Cancelled())
    assert not await repo.heartbeat(run.id)
    done = await repo.get(me, run.id)
    assert done is not None and done.status == "succeeded"
    assert done.result == {"text": "hi", "memoryTainted": True}
    assert done.finished_at is not None and done.lease_expires_at is None
    assert json.loads((await _row(pool, run.id))["outcome"])["type"] == "success"


async def test_interrupt_then_cancel(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, _), (bob, _) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    run = (await repo.create(me, _interactive(_id()))).run
    interrupt = PendingInterrupt(id="i1", tool="send", args={"to": "x"})
    assert await repo.settle(run.id, Interrupted((interrupt,)))
    paused = await repo.get(me, run.id)
    assert paused is not None and paused.status == "interrupted"
    assert paused.open_interrupts == (interrupt.to_agui(),)

    assert await repo.cancel(RunOwner.user(bob), run.id) is None
    cancelled = await repo.cancel(me, run.id)
    assert cancelled is not None and cancelled.status == "cancelled"
    assert cancelled.open_interrupts == ()
    again = await repo.cancel(me, run.id)
    assert again == cancelled
    row = await _row(pool, run.id)
    assert json.loads(row["outcome"]) == {"type": "cancelled"} and row["lease_expires_at"] is None


async def test_an_interrupted_settle_stores_the_checkpoint_for_its_owner_only(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, _), (bob, _) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    run = (await repo.create(me, _interactive(_id()))).run
    assert await repo.load_checkpoint(me, run.id) is None
    state = {"harness": "loop-v1", "version": 1, "turn": [{"role": "assistant", "content": []}]}
    interrupt = PendingInterrupt(id="i1", tool="send", args={"to": "x"})
    assert await repo.settle(run.id, Interrupted((interrupt,)), checkpoint=state)
    assert json.loads((await _row(pool, run.id))["checkpoint"]) == state
    # Read as the owner (RLS): someone else, or an anonymous owner, sees none.
    assert await repo.load_checkpoint(me, run.id) == state
    assert await repo.load_checkpoint(RunOwner.user(bob), run.id) is None
    assert await repo.load_checkpoint(RunOwner.anonymous("x" * 32), run.id) is None
    # A settle without one leaves a stored checkpoint alone.
    other = (await repo.create(me, _interactive(_id(), checkpoint={"k": 1}))).run
    assert await repo.settle(other.id, Succeeded())
    assert await repo.load_checkpoint(me, other.id) == {"k": 1}


async def test_cancel_cascades_to_background_children(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, conv), _ = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    parent = (await repo.create(me, _background(conv))).run
    child = _id()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, parent_task_id) "
            "VALUES ($1, $2, $3, 'child', 'queued', $4)",
            uuid.UUID(child),
            uuid.UUID(alice),
            uuid.UUID(conv),
            uuid.UUID(parent.id),
        )
    cancelled = await repo.cancel(me, parent.id)
    assert cancelled is not None and cancelled.status == "cancelled"
    assert (await _row(pool, child))["status"] == "cancelled"
    children = await repo.list_runs(me, RunFilter(parent_run_id=parent.id))
    assert [r.id for r in children.runs] == [child]
    assert children.runs[0].parent_run_id == parent.id


async def test_reaper_fails_interactive_runs_with_a_lapsed_lease(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, conv), _ = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    stale = (await repo.create(me, _interactive(_id()))).run
    fresh = (await repo.create(me, _interactive(_id()))).run
    background = (await repo.create(me, _background(conv))).run
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE public.tasks SET lease_expires_at = now() - interval '1 minute' "
            "WHERE id = ANY($1::uuid[])",
            [uuid.UUID(stale.id), uuid.UUID(background.id)],
        )
    reaped = await repo.reap_expired(limit=500)
    assert stale.id in {r.id for r in reaped}
    assert fresh.id not in {r.id for r in reaped} and background.id not in {r.id for r in reaped}
    got = await repo.get(me, stale.id)
    assert got is not None and got.status == "failed"
    assert got.error == {
        "code": "worker_lost",
        "message": "The run's process stopped unexpectedly.",
    }


# --- list -------------------------------------------------------------------------------------


async def test_list_filters_pages_and_rls(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, conv), (bob, _) = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    thread = _id()
    ids = []
    for _ in range(5):
        ids.append((await repo.create(me, _interactive(thread))).run.id)
    await repo.settle(ids[0], Succeeded())
    await repo.settle(ids[1], Interrupted((PendingInterrupt(id="i"),)))
    await repo.create(RunOwner.user(bob), _interactive(thread))  # same thread id, other user
    bg = (await repo.create(me, _background(conv))).run

    page = await repo.list_runs(me, RunFilter(thread_id=thread))
    assert [r.id for r in page.runs] == ids[::-1] and page.next_page_token is None

    walked: list[str] = []
    token = None
    while True:
        p = await repo.list_runs(me, RunFilter(thread_id=thread), page_size=2, page_token=token)
        walked += [r.id for r in p.runs]
        token = p.next_page_token
        if token is None:
            break
    assert walked == ids[::-1]

    def statuses(*s: str) -> RunFilter:
        return RunFilter(thread_id=thread, statuses=frozenset(s))  # type: ignore[arg-type]

    assert [r.id for r in (await repo.list_runs(me, statuses("interrupted"))).runs] == [ids[1]]
    assert [r.id for r in (await repo.list_runs(me, statuses("succeeded"))).runs] == [ids[0]]
    assert len((await repo.list_runs(me, statuses("running"))).runs) == 3
    assert [r.id for r in (await repo.list_runs(me, RunFilter(mode="background"))).runs] == [bg.id]
    assert (await repo.list_runs(RunOwner.anonymous("x" * 32), RunFilter())).runs == ()
    with pytest.raises(InvalidPageToken):
        await repo.list_runs(me, RunFilter(), page_token="garbage")
    first = await repo.list_runs(me, RunFilter(thread_id=thread), page_size=1)
    assert first.next_page_token is not None
    with pytest.raises(InvalidPageToken):
        await repo.list_runs(me, RunFilter(), page_token=first.next_page_token)


# --- rows written before 0041 -------------------------------------------------------------------


async def test_pre_0041_rows_fall_back_to_their_logs(
    pool: asyncpg.Pool, users: tuple[tuple[str, str], tuple[str, str]]
) -> None:
    (alice, conv), _ = users
    repo = PgRunRepository(pool)
    me = RunOwner.user(alice)
    done, failed, orphan, paused = (_id() for _ in range(4))
    now = datetime.now(UTC).isoformat()
    async with pool.acquire() as conn:
        for run_id, status in (
            (done, "done"),
            (failed, "failed"),
            (orphan, "failed"),
            (paused, "paused"),
        ):
            await conn.execute(
                "INSERT INTO public.tasks (id, user_id, conversation_id, goal, status) "
                "VALUES ($1, $2, $3, 'legacy', $4)",
                uuid.UUID(run_id),
                uuid.UUID(alice),
                uuid.UUID(conv),
                status,
            )
        events = [
            ResultEvent(run_id=done, seq=1, step=1, created_at=now, status="done", final_text="ok"),
            ResultEvent(
                run_id=failed,
                seq=1,
                step=1,
                created_at=now,
                status="failed",
                error="boom",
                error_code="provider",
            ),
            ApprovalEvent(
                run_id=paused,
                seq=1,
                step=1,
                created_at=now,
                approval_id="a1",
                phase="request",
                tool="send",
                args={},
            ),
            ApprovalEvent(
                run_id=paused,
                seq=2,
                step=1,
                created_at=now,
                approval_id="a0",
                phase="request",
                tool="old",
            ),
            ApprovalEvent(
                run_id=paused, seq=3, step=1, created_at=now, approval_id="a0", phase="response"
            ),
        ]
        for ev in events:
            await conn.execute(
                "INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload) "
                "VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
                uuid.UUID(ev.run_id),
                uuid.UUID(alice),
                ev.seq,
                ev.step,
                ev.kind,
                json.dumps(event_to_row_payload(ev)),
            )
    got = {r: await repo.get(me, r) for r in (done, failed, orphan, paused)}
    assert got[done] is not None and got[done].result == {"text": "ok"}  # type: ignore[union-attr]
    assert got[failed] is not None and got[failed].error == {"code": "provider", "message": "boom"}  # type: ignore[union-attr]
    assert got[orphan] is not None and got[orphan].error == {  # type: ignore[union-attr]
        "code": "no_worker",
        "message": "No task worker available.",
    }
    p = got[paused]
    assert p is not None and p.status == "interrupted"
    assert [i["id"] for i in p.open_interrupts] == ["a1"]


# --- the routes, with a database -------------------------------------------------------------


def _auth(sub: str) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": sub,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 600,
        },
        SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def seeded_sync() -> Iterator[tuple[str, str]]:
    """A user + conversation, seeded from a throwaway loop (the TestClient
    runs the app on its own loop)."""
    import asyncio

    async def seed() -> tuple[str, str]:
        conn = await asyncpg.connect(DB_URL)
        try:
            return await _seed_user(conn)
        finally:
            await conn.close()

    async def drop(user: str) -> None:
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(user))
        finally:
            await conn.close()

    user, conv = asyncio.run(seed())
    try:
        yield user, conv
    finally:
        asyncio.run(drop(user))


def test_routes_with_a_database(
    monkeypatch: pytest.MonkeyPatch, seeded_sync: tuple[str, str]
) -> None:
    user, conv = seeded_sync
    monkeypatch.setenv("SUPABASE_JWT_SECRET", SECRET)
    app = create_app(enable_poller=False)
    with TestClient(app) as client:
        assert client.portal is not None
        pool = client.portal.call(lambda: asyncpg.create_pool(DB_URL, min_size=1, max_size=4))
        settings = Settings(SUPABASE_JWT_SECRET=SECRET, RUNS_STUB_HARNESS=True)
        services = wiring.build_run_services(settings, pool)
        app.dependency_overrides[wiring.get_run_services] = lambda: services
        try:
            headers = _auth(user)
            # interactive, signed in → Postgres row, streamed
            body = {
                "threadId": _id(),
                "runId": _id(),
                "messages": [{"id": "m", "role": "user", "content": "hi"}],
            }
            r = client.post("/v1/runs", json=body, headers=headers)
            assert r.status_code == 200 and "RUN_FINISHED" in r.text
            run = client.get(f"/v1/runs/{body['runId']}", headers=headers).json()
            assert run["status"] == "succeeded" and run["mode"] == "interactive"
            # an anonymous caller cannot take a Postgres run's id
            assert client.post("/v1/runs", json=body).status_code == 409

            # background: a thread that is not a conversation of mine → 404
            bg = {
                **body,
                "runId": _id(),
                "threadId": _id(),
                "forwardedProps": {"mode": "background", "maxSteps": 2},
            }
            missing = client.post("/v1/runs", json=bg, headers=headers)
            assert missing.status_code == 404 and missing.json()["code"] == "not_found"
            # …and on my conversation → 202, queued + start job, retry → 202
            bg["threadId"] = conv
            accepted = client.post("/v1/runs", json=bg, headers=headers)
            assert accepted.status_code == 202
            assert accepted.json() == {"runId": bg["runId"], "status": "queued"}
            assert client.post("/v1/runs", json=bg, headers=headers).status_code == 202

            async def jobs() -> list[str]:
                async with pool.acquire() as conn:
                    rows = await conn.fetch(
                        "SELECT action FROM public.task_jobs WHERE task_id = $1",
                        uuid.UUID(bg["runId"]),
                    )
                return [row["action"] for row in rows]

            assert client.portal.call(jobs) == ["start"]
            listed = client.get("/v1/runs", params={"mode": "background"}, headers=headers).json()
            assert [x["id"] for x in listed["runs"]] == [bg["runId"]]
            cancelled = client.post(f"/v1/runs/{bg['runId']}/cancel", headers=headers)
            assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
        finally:
            client.portal.call(pool.close)
