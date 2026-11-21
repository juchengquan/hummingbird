"""MemoryRunEventLog — the anonymous-run log: the contract, TTL, caps."""

from __future__ import annotations

import asyncio
import itertools

import pytest

from agent_py.runs.event_log_memory import ENTRY_OVERHEAD, MemoryRunEventLog, RunLogFull

from . import event_log_contract as contract
from .runs_support import Log

_ids = itertools.count(1)


async def _new_run() -> str:
    return f"anon-{next(_ids)}"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_contract_append_read_last_seq() -> None:
    await contract.check_append_read_last_seq(MemoryRunEventLog(), _new_run)


async def test_contract_subscribe() -> None:
    await contract.check_subscribe_follows_and_stops_on_seal(MemoryRunEventLog(), _new_run)
    await contract.check_subscribe_after_and_early_stop(MemoryRunEventLog(), _new_run)


async def test_contract_compact_and_purge() -> None:
    await contract.check_compact_and_purge(MemoryRunEventLog(), _new_run)


async def test_dropped_ttl_after_seal() -> None:
    clock = _Clock()
    log = MemoryRunEventLog(ttl=900, clock=clock)
    await log.append(contract.tok("r", 1))
    await log.seal("r")
    clock.now += 899
    assert await log.last_seq("r") == 1
    clock.now += 2
    assert await log.read("r") == []
    assert await log.last_seq("r") == 0
    assert log.total_bytes == 0


async def test_unsealed_runs_expire_when_idle() -> None:
    clock = _Clock()
    log = MemoryRunEventLog(idle_ttl=100, clock=clock)
    await log.append(contract.tok("r", 1))
    clock.now += 60
    await log.append(contract.tok("r", 2))  # touched: the idle clock restarts
    clock.now += 60
    assert await log.last_seq("r") == 2
    clock.now += 41
    assert log.sweep() == 1
    assert await log.last_seq("r") == 0


async def test_a_subscriber_stops_when_its_run_expires() -> None:
    clock = _Clock()
    log = MemoryRunEventLog(ttl=10, tick=0.01, clock=clock)
    await log.append(contract.tok("r", 1))
    seen: list[int] = []

    async def follow() -> None:
        async for batch in log.subscribe("r"):
            seen.extend(e.seq for e in batch)

    task = asyncio.create_task(follow())
    await asyncio.sleep(0.03)
    clock.now += 3 * 3600  # idle_ttl (2 h) passes without a seal
    await asyncio.wait_for(task, 1)
    assert seen == [1]


async def test_per_run_entry_cap_spares_closing_entries() -> None:
    log = MemoryRunEventLog(max_entries_per_run=3)
    b = Log("r")
    for _ in range(3):
        await log.append(b.text("x"))
    with pytest.raises(RunLogFull):
        await log.append(b.text("x"))
    # The run can still be ended: result / status / approval always fit.
    b.seq -= 1
    await log.append(b.result("failed", error="too long", error_code="limit"))
    await log.append(b.status("failed"))
    assert await log.last_seq("r") == 5


async def test_per_run_byte_cap() -> None:
    log = MemoryRunEventLog(max_bytes_per_run=ENTRY_OVERHEAD * 2 + 100)
    b = Log("r")
    await log.append(b.text("a"))
    with pytest.raises(RunLogFull):
        await log.append(b.text("y" * 200))


async def test_total_cap_evicts_sealed_runs_oldest_first() -> None:
    clock = _Clock()
    per_entry = ENTRY_OVERHEAD + 100
    log = MemoryRunEventLog(max_total_bytes=per_entry * 3, clock=clock)
    for run in ("old", "newer"):
        await log.append(Log(run).text("x" * 70))
        await log.seal(run)
        clock.now += 1
    live = Log("live")
    await log.append(live.text("x" * 70))
    # Full: the next append evicts "old" (sealed first), not the live run.
    await log.append(live.text("x" * 70))
    assert await log.last_seq("old") == 0
    assert await log.last_seq("newer") == 1
    await log.append(live.text("x" * 70))  # evicts "newer"
    assert await log.last_seq("newer") == 0
    with pytest.raises(RunLogFull):  # only the live run is left
        await log.append(live.text("x" * 70))
    assert log.total_bytes <= per_entry * 3


async def test_seal_without_entries_still_refuses_appends() -> None:
    log = MemoryRunEventLog()
    await log.seal("never")
    with pytest.raises(RuntimeError):
        await log.append(contract.tok("never", 1))
