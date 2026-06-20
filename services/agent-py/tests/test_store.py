"""Tests for the child-task DB helpers in store.py.

Covers:
  - create_child_task: INSERT with parent_task_id; returns the new id string.
  - set_pending_children: UPDATE with the pending count.
  - load_child_results: maps fetch rows → list[ChildResult] correctly,
    handling both done (with result text) and failed (no result) children.
"""

from __future__ import annotations

import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.store import ChildResult, create_child_task, load_child_results, set_pending_children

# --- helpers -----------------------------------------------------------------


def _fake_pool(
    fetchrow_result: Any = None,
    fetch_result: list[Any] | None = None,
    execute_result: str = "UPDATE 1",
) -> MagicMock:
    """Fake asyncpg.Pool with fetchrow / fetch / execute stubs.

    Mirrors the helper in test_jobs.py but also supports `conn.fetch`
    for load_child_results which fetches multiple rows.
    """
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value=fetchrow_result)
    conn.fetch = AsyncMock(return_value=fetch_result if fetch_result is not None else [])
    conn.execute = AsyncMock(return_value=execute_result)

    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


# Stable UUIDs used across tests
_PARENT_TASK_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
_USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
_CONV_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
_CHILD_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd"
_CHILD_ID_2 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"


# --- create_child_task -------------------------------------------------------


@pytest.mark.asyncio
async def test_create_child_task_issues_insert_and_returns_id() -> None:
    """create_child_task must INSERT a tasks row with parent_task_id set
    and return the new task's id as a plain string."""
    new_id = uuid.UUID(_CHILD_ID)
    pool = _fake_pool(fetchrow_result={"id": new_id})

    result = await create_child_task(
        pool,
        parent_task_id=_PARENT_TASK_ID,
        user_id=_USER_ID,
        conversation_id=_CONV_ID,
        goal="Write a section on climate policy",
        checkpoint={"subagent": {"personaSlug": "researcher", "subgoal": "climate policy"}},
    )

    # Must return the id as a string
    assert result == _CHILD_ID

    # fetchrow was called (INSERT … RETURNING id)
    conn = pool.acquire().__aenter__.return_value
    conn.fetchrow.assert_called_once()
    call_args = conn.fetchrow.call_args[0]
    sql: str = call_args[0]
    # SQL must mention parent_task_id and RETURNING id
    assert "parent_task_id" in sql.lower()
    assert "RETURNING id" in sql


# --- set_pending_children ----------------------------------------------------


@pytest.mark.asyncio
async def test_set_pending_children_issues_update_with_count() -> None:
    """set_pending_children must UPDATE the tasks row's pending_children
    column with the given count."""
    pool = _fake_pool(execute_result="UPDATE 1")

    await set_pending_children(pool, task_id=_PARENT_TASK_ID, user_id=_USER_ID, n=3)

    conn = pool.acquire().__aenter__.return_value
    conn.execute.assert_called_once()
    call_args = conn.execute.call_args[0]
    sql: str = call_args[0]
    assert "pending_children" in sql
    # The count must appear in the positional args
    args = list(call_args[1:])
    assert 3 in args


# --- load_child_results ------------------------------------------------------


def _make_child_row(
    child_id: str,
    status: str,
    checkpoint: dict[str, Any] | None,
    result_payload: dict[str, Any] | str | None,
) -> dict[str, Any]:
    """Build a fake asyncpg Record-shaped dict for load_child_results."""
    return {
        "id": uuid.UUID(child_id),
        "status": status,
        # asyncpg may return jsonb as a dict or as a JSON string
        "checkpoint": json.dumps(checkpoint) if checkpoint is not None else None,
        "result_payload": json.dumps(result_payload)
        if isinstance(result_payload, dict)
        else result_payload,
    }


@pytest.mark.asyncio
async def test_load_child_results_maps_rows_correctly() -> None:
    """load_child_results returns a ChildResult per child row.

    Row 1: status='done', checkpoint has subagent metadata, result_payload
           has finalText — should produce a ChildResult with persona_slug,
           subgoal, status, and final_text filled in.

    Row 2: status='failed', result_payload is None — final_text should be
           empty string; persona_slug/subgoal still come from checkpoint.
    """
    row1 = _make_child_row(
        child_id=_CHILD_ID,
        status="done",
        checkpoint={
            "subagent": {"personaSlug": "researcher", "subgoal": "climate policy"},
            "messages": [],
        },
        result_payload={"status": "done", "finalText": "The climate report summary."},
    )
    row2 = _make_child_row(
        child_id=_CHILD_ID_2,
        status="failed",
        checkpoint={
            "subagent": {"personaSlug": "analyst", "subgoal": "economic impact"},
            "messages": [],
        },
        result_payload=None,
    )

    pool = _fake_pool(fetch_result=[row1, row2])

    results = await load_child_results(pool, parent_task_id=_PARENT_TASK_ID, user_id=_USER_ID)

    assert len(results) == 2

    r1 = results[0]
    assert isinstance(r1, ChildResult)
    assert r1.persona_slug == "researcher"
    assert r1.subgoal == "climate policy"
    assert r1.status == "done"
    assert r1.final_text == "The climate report summary."

    r2 = results[1]
    assert isinstance(r2, ChildResult)
    assert r2.persona_slug == "analyst"
    assert r2.subgoal == "economic impact"
    assert r2.status == "failed"
    assert r2.final_text == ""


@pytest.mark.asyncio
async def test_load_child_results_empty_when_no_children() -> None:
    """load_child_results returns an empty list when the parent has no
    child tasks yet."""
    pool = _fake_pool(fetch_result=[])
    results = await load_child_results(pool, parent_task_id=_PARENT_TASK_ID, user_id=_USER_ID)
    assert results == []
