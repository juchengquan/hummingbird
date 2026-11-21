"""`schedules.dispatch_due_schedules` — the port of `dispatchDueSchedules`.

Driven against an in-memory `ScheduleStore` whose guarded writes behave
like the SQL (`… WHERE next_run_at = <value read>`, applied atomically),
with an `await` between the read and every write so concurrent
dispatchers really interleave.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from agent_py import schedules
from agent_py.schedules import DueSchedule, build_checkpoint, dispatch_due_schedules, js_slice

NOW = datetime(2026, 11, 21, 8, 0, 30, 123456, tzinfo=UTC)
NOW_MS = datetime(2026, 11, 21, 8, 0, 30, 123000, tzinfo=UTC)


def _row(n: int = 1, *, user: str = "u1", cron: str = "0 8 * * *", **kw: Any) -> DueSchedule:
    base: dict[str, Any] = {
        "id": f"00000000-0000-4000-8000-{n:012d}",
        "user_id": user,
        "workspace_id": "w1",
        "name": f"sched {n}",
        "prompt": "do the thing",
        "cron": cron,
        "timezone": "UTC",
        "model": None,
        "system_prompt": None,
        "skills": None,
        "max_steps": None,
        "last_run_at": None,
        "next_run_at": NOW - timedelta(minutes=n),
    }
    base.update(kw)
    return DueSchedule(**base)


class FakeStore:
    def __init__(self, rows: list[DueSchedule]) -> None:
        self.rows = {r.id: dataclasses.replace(r) for r in rows}
        self.enabled = dict.fromkeys(self.rows, True)
        self.last_run_task: dict[str, str] = {}
        self.fired: list[tuple[str, str]] = []
        self.deferred: list[tuple[str, datetime]] = []
        self.disabled: list[str] = []
        self.fail_fire: set[str] = set()
        self.fail_last_run_task = False
        self.fetch_error: Exception | None = None
        self.fetch_limit: int | None = None
        self._lock = asyncio.Lock()

    async def fetch_due(self, now: datetime, limit: int) -> list[DueSchedule]:
        self.fetch_limit = limit
        if self.fetch_error:
            raise self.fetch_error
        await asyncio.sleep(0)
        due = [r for r in self.rows.values() if self.enabled[r.id] and r.next_run_at <= now]
        return sorted(due, key=lambda r: r.next_run_at)[:limit]

    async def _guarded(self, row: DueSchedule, **changes: Any) -> bool:
        await asyncio.sleep(0)
        async with self._lock:
            current = self.rows[row.id]
            if current.next_run_at != row.next_run_at:
                return False
            self.rows[row.id] = dataclasses.replace(current, **changes)
            return True

    async def defer(self, row: DueSchedule, *, next_run_at: datetime, now: datetime) -> None:
        if await self._guarded(row, next_run_at=next_run_at):
            self.deferred.append((row.id, next_run_at))

    async def disable(self, row: DueSchedule, *, now: datetime) -> None:
        self.enabled[row.id] = False
        self.disabled.append(row.id)

    async def claim(self, row: DueSchedule, *, next_run_at: datetime, now: datetime) -> bool:
        return await self._guarded(row, next_run_at=next_run_at, last_run_at=now)

    async def fire(self, row: DueSchedule, *, run_id: str, conversation_id: str) -> None:
        await asyncio.sleep(0)
        if row.id in self.fail_fire:
            raise RuntimeError("insert failed")
        self.fired.append((row.id, run_id))

    async def set_last_run_task(self, row: DueSchedule, *, run_id: str) -> None:
        if self.fail_last_run_task:
            raise RuntimeError("update failed")
        self.last_run_task[row.id] = run_id


async def test_fires_a_due_row_and_advances_it() -> None:
    store = FakeStore([_row(1, cron="0 8 * * *")])
    assert await dispatch_due_schedules(store, now=NOW) == 1
    row = store.rows[_row(1).id]
    # Next 08:00 UTC strictly after now; last_run_at = now (ms precision).
    assert row.next_run_at == datetime(2026, 11, 22, 8, 0, tzinfo=UTC)
    assert row.last_run_at == NOW_MS
    assert store.last_run_task[row.id] == store.fired[0][1]
    assert store.fetch_limit == schedules.DUE_FETCH_LIMIT


async def test_nothing_due_is_zero() -> None:
    store = FakeStore([_row(1, next_run_at=NOW + timedelta(minutes=1))])
    assert await dispatch_due_schedules(store, now=NOW) == 0
    assert store.fired == []


async def test_two_concurrent_dispatches_fire_an_occurrence_once() -> None:
    store = FakeStore([_row(i, user=f"u{i}") for i in range(1, 6)])
    a, b = await asyncio.gather(
        dispatch_due_schedules(store, now=NOW), dispatch_due_schedules(store, now=NOW)
    )
    assert a + b == 5
    assert sorted(rid for rid, _ in store.fired) == sorted(store.rows)


async def test_minimum_gap_defers_instead_of_firing() -> None:
    last = NOW - timedelta(minutes=2)
    store = FakeStore([_row(1, cron="*/5 * * * *", last_run_at=last)])
    assert await dispatch_due_schedules(store, now=NOW) == 0
    assert store.fired == []
    expected = schedules.truncate_to_ms(last) + timedelta(minutes=4)
    assert store.deferred == [(_row(1).id, expected)]
    assert store.rows[_row(1).id].next_run_at == expected


async def test_gap_elapsed_fires() -> None:
    store = FakeStore([_row(1, cron="*/5 * * * *", last_run_at=NOW - timedelta(minutes=4))])
    assert await dispatch_due_schedules(store, now=NOW) == 1


async def test_invalid_cron_disables_the_row() -> None:
    store = FakeStore([_row(1, cron="not a cron"), _row(2, timezone="Mars/Olympus")])
    assert await dispatch_due_schedules(store, now=NOW) == 0
    assert store.disabled == [_row(2).id, _row(1).id]  # earliest next_run_at first


async def test_lost_claim_skips_the_fire() -> None:
    store = FakeStore([_row(1)])
    stale = _row(1)  # someone else already moved next_run_at
    store.rows[stale.id] = dataclasses.replace(stale, next_run_at=NOW + timedelta(days=1))

    async def fetch_stale(now: datetime, limit: int) -> list[DueSchedule]:
        return [stale]

    store.fetch_due = fetch_stale  # type: ignore[method-assign]
    assert await dispatch_due_schedules(store, now=NOW) == 0
    assert store.fired == []


async def test_fire_failure_is_logged_and_skipped() -> None:
    store = FakeStore([_row(1), _row(2)])
    store.fail_fire = {_row(2).id}
    assert await dispatch_due_schedules(store, now=NOW) == 1
    # The failed row was still claimed (next_run_at moved), like the TS path.
    assert store.rows[_row(2).id].next_run_at > NOW
    assert _row(2).id not in store.last_run_task


async def test_last_run_task_failure_still_counts_the_fire() -> None:
    store = FakeStore([_row(1)])
    store.fail_last_run_task = True
    assert await dispatch_due_schedules(store, now=NOW) == 1


async def test_fetch_failure_raises() -> None:
    store = FakeStore([])
    store.fetch_error = RuntimeError("db down")
    with pytest.raises(RuntimeError):
        await dispatch_due_schedules(store, now=NOW)


async def test_fair_batch_caps_per_user_and_total() -> None:
    # The hog's 60 rows are the oldest; ten other users have 10 each.
    rows = [
        _row(i, user="hog", next_run_at=NOW - timedelta(hours=10, minutes=i)) for i in range(60)
    ]
    rows += [_row(100 + i, user=f"u{i % 10}") for i in range(100)]
    store = FakeStore(rows)
    fired = await dispatch_due_schedules(store, now=NOW)
    assert fired == schedules.TICK_MAX_FIRES
    hog = [rid for rid, _ in store.fired if store.rows[rid].user_id == "hog"]
    assert len(hog) == schedules.TICK_MAX_FIRES_PER_USER


def test_pick_fair_batch_matches_the_ts_examples() -> None:
    @dataclasses.dataclass
    class R:
        user_id: str
        n: int

    rows = [R("a", 1), R("a", 2), R("a", 3), R("b", 4), R("c", 5), R("b", 6)]
    picked = schedules.pick_fair_batch(rows, max_total=4, max_per_user=2)
    assert [r.n for r in picked] == [1, 4, 5, 2]
    picked = schedules.pick_fair_batch(rows, max_total=10, max_per_user=2)
    assert [r.n for r in picked] == [1, 4, 5, 2, 6]


def test_checkpoint_matches_fire_schedule() -> None:
    row = _row(1, model=None, system_prompt=None, skills=None)
    assert build_checkpoint(row, 25) == {
        "messages": [{"role": "user", "content": "do the thing"}],
        "step": 0,
        "seq": 1,
        "config": {"model": "", "workspaceId": "w1", "skills": [], "maxSteps": 25},
    }
    row = _row(1, model="anthropic/x", system_prompt="", skills=[{"id": "webSearch"}])
    cp = build_checkpoint(row, 7)
    assert cp["config"] == {
        "model": "anthropic/x",
        "workspaceSystemPrompt": "",
        "workspaceId": "w1",
        "skills": [{"id": "webSearch"}],
        "maxSteps": 7,
    }
    json.dumps(cp)


def test_js_slice_counts_utf16_units() -> None:
    assert js_slice("abc", 2) == "ab"
    assert js_slice("a" * 10, 2000) == "a" * 10
    s = "a" + "\U0001f600" * 3  # 1 + 2*3 = 7 UTF-16 units
    assert js_slice(s, 5) == "a\U0001f600\U0001f600"
    assert js_slice(s, 4) == "a\U0001f600"  # the split pair is dropped whole
