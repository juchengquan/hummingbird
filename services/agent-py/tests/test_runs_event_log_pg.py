"""PgRunEventLog, streams and the retention sweep against a real Postgres
with the Supabase migrations applied.

Opt-in: set `AGENT_PY_TEST_DB_URL` to a disposable database with
migrations 0001 to 0041 applied (e.g. the local Supabase CLI stack:
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`). Skipped
otherwise — CI has no database.

"Two processes" are two pools with one `PgRunEventLog` each: they share
nothing but the database, exactly like two API replicas.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from agent_py.events import TaskEvent
from agent_py.runs.agui_encoder import AgUiRunEncoder
from agent_py.runs.compaction import retention_sweep
from agent_py.runs.event_log_pg import PgRunEventLog, RunNotFound
from agent_py.runs.model import RunOwner, RunRecord
from agent_py.runs.stream import stream_run_events

from . import event_log_contract as contract
from .test_runs_agui_encoder import _one_of_every_kind
from .test_runs_stream import example_log

DB_URL = os.environ.get("AGENT_PY_TEST_DB_URL", "")
pytestmark = pytest.mark.skipif(not DB_URL, reason="AGENT_PY_TEST_DB_URL not set")


@pytest.fixture
async def pool() -> AsyncIterator[asyncpg.Pool]:
    p = await asyncpg.create_pool(DB_URL, min_size=1, max_size=6)
    try:
        yield p
    finally:
        await p.close()


@pytest.fixture
async def other_pool() -> AsyncIterator[asyncpg.Pool]:
    p = await asyncpg.create_pool(DB_URL, min_size=1, max_size=4)
    try:
        yield p
    finally:
        await p.close()


@pytest.fixture
async def user(pool: asyncpg.Pool) -> AsyncIterator[uuid.UUID]:
    uid = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', "
            "'authenticated', $2)",
            uid,
            f"{uid}@runs.test",
        )
    try:
        yield uid
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM auth.users WHERE id = $1", uid)


async def _interactive_run(
    pool: asyncpg.Pool,
    user: uuid.UUID,
    *,
    status: str = "running",
    finished_ago: timedelta | None = None,
) -> str:
    rid = uuid.uuid4()
    finished = None if finished_ago is None else datetime.now(UTC) - finished_ago
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO public.tasks (id, user_id, mode, thread_id, status, started_at, "
            "finished_at) VALUES ($1, $2, 'interactive', $3, $4, now(), $5)",
            rid,
            user,
            uuid.uuid4(),
            status,
            finished,
        )
    return str(rid)


async def _background_run(pool: asyncpg.Pool, user: uuid.UUID, *, finished_ago: timedelta) -> str:
    rid, ws, conv = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with pool.acquire() as conn:
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
        await conn.execute(
            "INSERT INTO public.tasks (id, user_id, conversation_id, goal, status, started_at, "
            "finished_at) VALUES ($1, $2, $3, 'g', 'done', now(), $4)",
            rid,
            user,
            conv,
            datetime.now(UTC) - finished_ago,
        )
    return str(rid)


def _new_run(pool: asyncpg.Pool, user: uuid.UUID) -> Callable[[], Awaitable[str]]:
    async def new() -> str:
        return await _interactive_run(pool, user)

    return new


def _with_run(entries: list[TaskEvent], run_id: str) -> list[TaskEvent]:
    return [replace(e, run_id=run_id) for e in entries]


# --- the contract --------------------------------------------------------------------


async def test_contract(pool: asyncpg.Pool, user: uuid.UUID) -> None:
    new = _new_run(pool, user)
    await contract.check_append_read_last_seq(PgRunEventLog(pool), new)
    await contract.check_subscribe_follows_and_stops_on_seal(PgRunEventLog(pool), new)
    await contract.check_subscribe_after_and_early_stop(PgRunEventLog(pool), new)
    await contract.check_compact_and_purge(PgRunEventLog(pool), new)


async def test_append_writes_the_runs_user_and_needs_a_row(
    pool: asyncpg.Pool, user: uuid.UUID
) -> None:
    log = PgRunEventLog(pool)
    run = await _interactive_run(pool, user)
    await log.append(contract.tok(run, 1))
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "SELECT user_id FROM public.task_events WHERE task_id = $1", uuid.UUID(run)
            )
            == user
        )
    with pytest.raises(RunNotFound):
        await log.append(contract.tok(str(uuid.uuid4()), 1))
    assert await log.read("not-a-uuid") == []


async def test_every_kind_reads_back_and_encodes_identically(
    pool: asyncpg.Pool, user: uuid.UUID
) -> None:
    log = PgRunEventLog(pool)
    run = await _interactive_run(pool, user)
    written = _with_run(_one_of_every_kind(), run)
    for e in written:
        await log.append(e)
    read = await log.read(run)
    assert [(e.seq, e.kind) for e in read] == [(e.seq, e.kind) for e in written]
    live, replayed = AgUiRunEncoder(run), AgUiRunEncoder(run)
    for a, b in zip(written, read, strict=True):
        assert live.encode(a) == replayed.encode(b), a.kind


# --- subscribe: in-process fast path and the cross-process poll (Q29) ----------------


async def test_in_process_appends_wake_subscribers_without_polling(
    pool: asyncpg.Pool, user: uuid.UUID
) -> None:
    log = PgRunEventLog(pool, poll_interval=5.0)  # a poll would take 5 s
    run = await _interactive_run(pool, user)
    sub = log.subscribe(run)
    got: asyncio.Queue[tuple[float, list[int]]] = asyncio.Queue()

    async def follow() -> None:
        async for batch in sub:
            await got.put((time.monotonic(), [e.seq for e in batch]))

    task = asyncio.create_task(follow())
    await asyncio.sleep(0.1)
    sent = time.monotonic()
    await log.append(contract.tok(run, 1))
    at, seqs = await asyncio.wait_for(got.get(), 2)
    assert seqs == [1]
    assert at - sent < 0.5
    await log.seal(run)
    await asyncio.wait_for(task, 2)
    assert log._waiters == {}  # released


async def test_readers_in_another_process_poll(
    pool: asyncpg.Pool, other_pool: asyncpg.Pool, user: uuid.UUID
) -> None:
    writer = PgRunEventLog(pool)
    reader = PgRunEventLog(other_pool, poll_interval=0.25)
    run = await _interactive_run(pool, user)
    await writer.append(contract.tok(run, 1))
    seen: list[int] = []
    latencies: list[float] = []
    stamps: dict[int, float] = {}

    sub = reader.subscribe(run)

    async def follow() -> None:
        async for batch in sub:
            for e in batch:
                seen.append(e.seq)
                if e.seq in stamps:
                    latencies.append(time.monotonic() - stamps[e.seq])
            if seen and seen[-1] == 4:
                return

    task = asyncio.create_task(follow())
    for seq in (2, 3, 4):
        await asyncio.sleep(0.3)
        stamps[seq] = time.monotonic()
        await writer.append(contract.tok(run, seq))
    # The writer's seal is invisible to the other process: the reader is
    # stopped by its consumer (here: after seq 4), not by the log.
    await writer.seal(run)
    await asyncio.wait_for(task, 3)
    await sub.aclose()  # type: ignore[attr-defined]
    assert seen == [1, 2, 3, 4]
    assert max(latencies) < 0.6
    assert reader._waiters == {}


async def test_a_stream_in_another_process_follows_and_closes_on_the_row(
    pool: asyncpg.Pool, other_pool: asyncpg.Pool, user: uuid.UUID
) -> None:
    writer = PgRunEventLog(pool)
    reader = PgRunEventLog(other_pool)
    run = await _interactive_run(pool, user)
    entries = _with_run(example_log().entries, run)

    async def load() -> RunRecord | None:
        async with other_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, thread_id, outcome::text AS outcome, created_at, updated_at "
                "FROM public.tasks WHERE id = $1",
                uuid.UUID(run),
            )
        if row is None:
            return None
        outcome = json.loads(row["outcome"]) if row["outcome"] else None
        return RunRecord(
            id=run,
            owner=RunOwner.user(str(user)),
            thread_id=str(row["thread_id"]),
            mode="interactive",
            internal_status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            result=outcome["result"] if outcome else None,
        )

    async def drive() -> None:
        for e in entries:
            await writer.append(e)
            await asyncio.sleep(0.02)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE public.tasks SET status = 'done', finished_at = now(), outcome = $2::jsonb "
                "WHERE id = $1",
                uuid.UUID(run),
                json.dumps({"type": "success", "result": {"text": "It is blue."}}),
            )
        await writer.seal(run)

    driver = asyncio.create_task(drive())
    live = await asyncio.wait_for(
        _frames(
            stream_run_events(
                run_id=run, after=None, log=reader, encoder=AgUiRunEncoder(run), load_run=load
            )
        ),
        10,
    )
    await driver
    replay = await _frames(
        stream_run_events(
            run_id=run, after=None, log=reader, encoder=AgUiRunEncoder(run), load_run=load
        )
    )
    assert live == replay
    assert json.loads(live[-1][6:])["result"] == {"text": "It is blue."}
    assert reader._waiters == {}


async def _frames(stream: AsyncIterator[str]) -> list[str]:
    return [f async for f in stream]


# --- compaction + retention sweep ------------------------------------------------------


async def test_retention_sweep(pool: asyncpg.Pool, user: uuid.UUID) -> None:
    log = PgRunEventLog(pool)
    old = await _interactive_run(pool, user, status="done", finished_ago=timedelta(days=2))
    fresh = await _interactive_run(pool, user, status="done", finished_ago=timedelta(hours=1))
    live = await _interactive_run(pool, user)
    background = await _background_run(pool, user, finished_ago=timedelta(days=2))
    for run in (old, fresh, live, background):
        for e in _with_run(example_log().entries, run):
            await log.append(e)

    # Scope the sweep to this test's rows: other runs in the database are
    # someone else's; `now` is real, so they may be swept too — harmless.
    result = await retention_sweep(pool, log)
    assert result.compacted >= 1
    assert [(e.seq, e.kind) for e in await log.read(old)] == [
        (10, "messages_snapshot"),
        (11, "result"),
    ]
    for untouched in (fresh, live, background):
        assert len(await log.read(untouched)) == 11, untouched
    # Idempotent.
    await retention_sweep(pool, log)
    assert len(await log.read(old)) == 2

    # 31 days later the interactive logs are purged; rows stay.
    later = datetime.now(UTC) + timedelta(days=31)
    result = await retention_sweep(pool, log, now=later)
    assert result.purged >= 2
    assert await log.read(old) == [] and await log.read(fresh) == []
    assert len(await log.read(live)) == 11  # never ended
    assert len(await log.read(background)) == 11  # background: kept with its row
    async with pool.acquire() as conn:
        assert (
            await conn.fetchval(
                "SELECT count(*) FROM public.tasks WHERE id = ANY($1::uuid[])",
                [uuid.UUID(old), uuid.UUID(fresh)],
            )
            == 2
        )


async def test_concurrent_compactions_do_not_conflict(
    pool: asyncpg.Pool, other_pool: asyncpg.Pool, user: uuid.UUID
) -> None:
    from agent_py.runs.compaction import compact_run

    a, b = PgRunEventLog(pool), PgRunEventLog(other_pool)
    run = await _interactive_run(pool, user, status="done", finished_ago=timedelta(days=2))
    for e in _with_run(example_log().entries, run):
        await a.append(e)
    results = await asyncio.gather(
        compact_run(a, run, mode="interactive"), compact_run(b, run, mode="interactive")
    )
    assert sorted(results) == [False, True]
    assert [e.kind for e in await a.read(run)] == ["messages_snapshot", "result"]
