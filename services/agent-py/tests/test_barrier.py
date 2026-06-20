"""Tests for the subagent join barrier (mocked pool, no real Postgres).

These prove the control flow + which SQL each branch issues. True
transactional atomicity is verified live against a real Postgres
(deferred manual smoke), per the spec's caveat.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.barrier import SettleResult, settle_task_terminal

TASK_ID = "11111111-1111-1111-1111-111111111111"
PARENT_ID = "99999999-9999-9999-9999-999999999999"
USER_ID = "33333333-3333-3333-3333-333333333333"


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


@pytest.mark.asyncio
async def test_transition_decrement_and_reenqueue_at_zero() -> None:
    pool, conn = _fake_pool(
        [
            {"parent_task_id": uuid.UUID(PARENT_ID)},
            {"pending_children": 0, "status": "running"},
        ]
    )
    result = await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="done")
    assert result == SettleResult(
        transitioned=True,
        parent_task_id=PARENT_ID,
        parent_remaining=0,
        reenqueued_parent=True,
    )
    conn.execute.assert_awaited_once()  # the continue-job INSERT


@pytest.mark.asyncio
async def test_decrement_but_not_reenqueue_when_children_remain() -> None:
    pool, conn = _fake_pool(
        [
            {"parent_task_id": uuid.UUID(PARENT_ID)},
            {"pending_children": 2, "status": "running"},
        ]
    )
    result = await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="failed")
    assert result.transitioned is True
    assert result.parent_remaining == 2
    assert result.reenqueued_parent is False
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_already_terminal_is_noop() -> None:
    pool, conn = _fake_pool([None])
    result = await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="done")
    assert result == SettleResult(
        transitioned=False,
        parent_task_id=None,
        parent_remaining=None,
        reenqueued_parent=False,
    )
    assert conn.fetchrow.await_count == 1  # only the transition probe
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_parent_transitions_only() -> None:
    pool, conn = _fake_pool([{"parent_task_id": None}])
    result = await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="done")
    assert result == SettleResult(
        transitioned=True,
        parent_task_id=None,
        parent_remaining=None,
        reenqueued_parent=False,
    )
    assert conn.fetchrow.await_count == 1  # no decrement
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_zero_counter_but_parent_cancelled_does_not_reenqueue() -> None:
    pool, conn = _fake_pool(
        [
            {"parent_task_id": uuid.UUID(PARENT_ID)},
            {"pending_children": 0, "status": "cancelled"},
        ]
    )
    result = await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="done")
    assert result.transitioned is True
    assert result.parent_remaining == 0
    assert result.reenqueued_parent is False
    conn.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_terminal_status_rejected() -> None:
    pool, _conn = _fake_pool([])
    with pytest.raises(ValueError):
        await settle_task_terminal(pool, task_id=TASK_ID, user_id=USER_ID, status="running")
    pool.acquire.assert_not_called()  # rejected before touching the DB
