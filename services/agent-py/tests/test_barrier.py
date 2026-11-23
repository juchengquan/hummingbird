"""Tests for the worker's half of the subagent join barrier (mocked
pool, no real Postgres): the transition + terminal event in one
transaction, and which SQL each branch issues.

The counting half is the database's since migration 0045 (it used to be
this module's decrement); it is pinned on a real Postgres in
`test_barrier_pg.py`.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.barrier import SettleResult, settle_task_terminal
from agent_py.events import ResultEvent

TASK_ID = "11111111-1111-1111-1111-111111111111"
PARENT_ID = "99999999-9999-9999-9999-999999999999"
USER_ID = "33333333-3333-3333-3333-333333333333"
EVENT = ResultEvent(run_id=TASK_ID, seq=7, step=2, created_at="t", status="done")


def _fake_pool(fetchrow_results: list[Any]) -> tuple[MagicMock, MagicMock]:
    """Fake `asyncpg.Pool` whose connection supports `transaction()` (an
    async CM) and returns the supplied `fetchrow` values in order."""
    conn = MagicMock()
    conn.fetchrow = AsyncMock(side_effect=fetchrow_results)
    conn.execute = AsyncMock(return_value="INSERT 0 1")

    txn = MagicMock()
    txn.__aenter__ = AsyncMock(return_value=None)
    txn.__aexit__ = AsyncMock(return_value=None)
    conn.transaction = MagicMock(return_value=txn)

    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool, conn


def _executed(conn: MagicMock) -> list[str]:
    return [c.args[0] for c in conn.execute.await_args_list]


@pytest.mark.asyncio
async def test_transition_writes_the_event_and_leaves_the_counter_to_the_database() -> None:
    pool, conn = _fake_pool([{"parent_task_id": uuid.UUID(PARENT_ID)}])
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="done", event=EVENT
    )
    assert result == SettleResult(transitioned=True, parent_task_id=PARENT_ID)
    assert conn.fetchrow.await_count == 1
    lock, event = _executed(conn)
    assert "private.lock_task_scope" in lock
    assert "INSERT INTO public.task_events" in event
    assert "pending_children" not in "".join([lock, event, conn.fetchrow.await_args.args[0]])
    conn.transaction.assert_called_once()


@pytest.mark.asyncio
async def test_already_terminal_is_noop() -> None:
    pool, conn = _fake_pool([None])
    result = await settle_task_terminal(
        pool, task_id=TASK_ID, user_id=USER_ID, status="done", event=EVENT
    )
    assert result == SettleResult(transitioned=False, parent_task_id=None)
    assert conn.fetchrow.await_count == 1  # only the transition probe
    assert not any("task_events" in sql for sql in _executed(conn))


@pytest.mark.asyncio
async def test_no_parent_transitions_only() -> None:
    pool, conn = _fake_pool([{"parent_task_id": None}])
    result = await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="done")
    assert result == SettleResult(transitioned=True, parent_task_id=None)
    assert conn.fetchrow.await_count == 1
    assert len(_executed(conn)) == 1  # the lock


@pytest.mark.asyncio
async def test_non_terminal_status_rejected() -> None:
    pool, _conn = _fake_pool([])
    with pytest.raises(ValueError):
        await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="running")
    pool.acquire.assert_not_called()  # rejected before touching the DB
