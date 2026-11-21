"""The `RunEventLog` contract as reusable checks, run against every
implementation (memory, Postgres)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import pytest

from agent_py.events import MessagesSnapshotEvent, StepStartEvent, TaskEvent, TokenEvent
from agent_py.runs.event_log import RunEventLog, SeqConflict

NewRun = Callable[[], Awaitable[str]]


def tok(run_id: str, seq: int, text: str = "x") -> TokenEvent:
    return TokenEvent(run_id=run_id, seq=seq, step=1, created_at="2026-11-21T00:00:00Z", text=text)


async def check_append_read_last_seq(log: RunEventLog, new_run: NewRun) -> None:
    run = await new_run()
    assert await log.read(run) == []
    assert await log.last_seq(run) == 0
    for s in (1, 2, 3):
        assert await log.append(tok(run, s, f"t{s}")) == s
    # Idempotent: the existing entry wins.
    assert await log.append(tok(run, 2, "other")) == 2
    got = await log.read(run)
    assert [(e.seq, e.text) for e in got if isinstance(e, TokenEvent)] == [
        (1, "t1"),
        (2, "t2"),
        (3, "t3"),
    ]
    assert all(e.run_id == run for e in got)
    assert [e.seq for e in await log.read(run, after_seq=1)] == [2, 3]
    assert [e.seq for e in await log.read(run, after_seq=1, limit=1)] == [2]
    assert await log.last_seq(run) == 3
    with pytest.raises(ValueError):
        await log.append(tok(run, 0))


async def check_subscribe_follows_and_stops_on_seal(log: RunEventLog, new_run: NewRun) -> None:
    run = await new_run()
    await log.append(tok(run, 1))
    seen: list[int] = []
    empties = 0

    async def follow() -> None:
        nonlocal empties
        async for batch in log.subscribe(run):
            if not batch:
                empties += 1
            seen.extend(e.seq for e in batch)

    task = asyncio.create_task(follow())
    await asyncio.sleep(0.4)  # idle: at least one empty batch
    await log.append(tok(run, 2))
    await log.append(tok(run, 3))
    await asyncio.sleep(0.05)
    await log.append(tok(run, 4))
    await log.seal(run)
    await asyncio.wait_for(task, 2)
    assert seen == [1, 2, 3, 4]
    assert empties >= 1
    with pytest.raises(RuntimeError):
        await log.append(tok(run, 5))


async def check_subscribe_after_and_early_stop(log: RunEventLog, new_run: NewRun) -> None:
    run = await new_run()
    for s in (1, 2, 3):
        await log.append(tok(run, s))
    sub = log.subscribe(run, after_seq=2)
    first = await sub.__anext__()
    assert [e.seq for e in first] == [3]
    await sub.aclose()  # type: ignore[attr-defined]


async def check_compact_and_purge(log: RunEventLog, new_run: NewRun) -> None:
    run = await new_run()
    for s in (1, 2, 3, 4):
        await log.append(tok(run, s))
    snap = MessagesSnapshotEvent(run_id=run, seq=3, step=1, created_at="", messages=({"id": "m"},))
    bad = MessagesSnapshotEvent(run_id=run, seq=9, step=1, created_at="", messages=())
    with pytest.raises(SeqConflict):
        await log.compact(run, bad)
    assert await log.compact(run, snap) is True
    got: list[TaskEvent] = await log.read(run)
    assert [(e.seq, e.kind) for e in got] == [(3, "messages_snapshot"), (4, "token")]
    assert isinstance(got[0], MessagesSnapshotEvent) and got[0].messages == ({"id": "m"},)
    assert await log.compact(run, snap) is False  # idempotent
    lower = MessagesSnapshotEvent(run_id=run, seq=1, step=1, created_at="", messages=())
    assert await log.compact(run, lower) is False  # already compacted past it
    assert await log.last_seq(run) == 4
    await log.purge(run)
    await log.purge(run)
    assert await log.read(run) == []
    assert await log.last_seq(run) == 0


async def check_every_kind_round_trips(
    log: RunEventLog, new_run: NewRun, entries: list[TaskEvent]
) -> None:
    """What `read` returns encodes the same as what was appended."""
    from dataclasses import replace

    run = await new_run()
    for e in entries:
        await log.append(replace(e, run_id=run))
    got = await log.read(run)
    assert [(e.seq, e.kind) for e in got] == [(e.seq, e.kind) for e in entries]
    for a, b in zip(entries, got, strict=True):
        assert replace(a, run_id=run, created_at="") == replace(b, created_at="")


async def check_step_start_seq(log: RunEventLog, new_run: NewRun) -> None:
    run = await new_run()
    await log.append(StepStartEvent(run_id=run, seq=1, step=1, created_at=""))
    assert await log.last_seq(run) == 1
