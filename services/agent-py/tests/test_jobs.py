"""Tests for the queue claim contract.

The SQL itself is exercised end-to-end by a real Postgres in Phase 1
verification (see services/agent-py/README.md). At unit-test level we
care about:

  1. `claim_next_job` returns None when the row-fetcher yields None.
  2. A real row maps to a `ClaimedJob` with field names mirroring the
     TS interface (`task_id` ↔ `taskId`, etc. — the wire is snake_case
     on the DB side, the dataclass is too, the JSON-on-the-log side
     stays snake_case so dashboards can union TS + Py logs).
  3. The payload column round-trips both as a dict (codec registered)
     and as a JSON string (no codec) — asyncpg behaviour varies.
  4. `release_job_to_queue` returns True iff the row was actually
     flipped.

Connection management is exercised in `test_poller.py`; here we drive
the functions with a fake pool to keep the assertions sharp.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.jobs import ClaimedJob, claim_next_job, release_job_to_queue

# --- helpers ---------------------------------------------------------------


def _fake_pool(fetchrow_result: Any = None, execute_result: str = "UPDATE 1") -> MagicMock:
    """Fake `asyncpg.Pool` that yields a connection whose `fetchrow`
    and `execute` are stubs returning the supplied values."""
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value=fetchrow_result)
    conn.execute = AsyncMock(return_value=execute_result)

    # `pool.acquire()` returns an async context manager. Mimic that
    # without dragging in the real asyncpg pool plumbing.
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


def _row(**overrides: Any) -> dict[str, Any]:
    """A representative task_jobs row, asyncpg.Record-shaped (just a
    dict — asyncpg Records support __getitem__ which dicts also do).
    """
    base = {
        "id": uuid.UUID("11111111-1111-1111-1111-111111111111"),
        "task_id": uuid.UUID("22222222-2222-2222-2222-222222222222"),
        "user_id": uuid.UUID("33333333-3333-3333-3333-333333333333"),
        "action": "continue",
        "payload": {"requestId": "abc"},
        "attempts": 1,
        "max_attempts": 3,
    }
    base.update(overrides)
    return base


# --- claim_next_job --------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_returns_none_when_queue_empty() -> None:
    pool = _fake_pool(fetchrow_result=None)
    assert await claim_next_job(pool) is None


@pytest.mark.asyncio
async def test_claim_maps_row_to_dataclass() -> None:
    pool = _fake_pool(fetchrow_result=_row())
    job = await claim_next_job(pool)
    assert job is not None
    assert job == ClaimedJob(
        id="11111111-1111-1111-1111-111111111111",
        task_id="22222222-2222-2222-2222-222222222222",
        user_id="33333333-3333-3333-3333-333333333333",
        action="continue",
        payload={"requestId": "abc"},
        attempts=1,
        max_attempts=3,
    )


@pytest.mark.asyncio
async def test_claim_handles_payload_as_json_string() -> None:
    """asyncpg without a jsonb codec returns the column as a string —
    the helper must tolerate that without crashing or losing fields."""
    pool = _fake_pool(fetchrow_result=_row(payload='{"requestId":"xyz"}'))
    job = await claim_next_job(pool)
    assert job is not None
    assert job.payload == {"requestId": "xyz"}


@pytest.mark.asyncio
async def test_claim_handles_non_dict_payload() -> None:
    """A jsonb that's not an object (rare — schema is `default '{}'` —
    but defensive) should coerce to {} rather than crash."""
    pool = _fake_pool(fetchrow_result=_row(payload="42"))
    job = await claim_next_job(pool)
    assert job is not None
    assert job.payload == {}


# --- release_job_to_queue ---------------------------------------------------


@pytest.mark.asyncio
async def test_release_returns_true_when_row_flipped() -> None:
    pool = _fake_pool(execute_result="UPDATE 1")
    assert await release_job_to_queue(pool, str(uuid.uuid4())) is True


@pytest.mark.asyncio
async def test_release_returns_false_when_no_row_matched() -> None:
    """Another worker finished the job between our claim + release —
    the predicate (`status = 'running'`) excludes it. Returning False
    lets the poller log accurately."""
    pool = _fake_pool(execute_result="UPDATE 0")
    assert await release_job_to_queue(pool, str(uuid.uuid4())) is False


@pytest.mark.asyncio
async def test_release_returns_false_on_unexpected_execute_output() -> None:
    """If asyncpg ever returns a non-`UPDATE n` string (it shouldn't —
    we sent an UPDATE), don't claim success."""
    pool = _fake_pool(execute_result="SOMETHING ELSE")
    assert await release_job_to_queue(pool, str(uuid.uuid4())) is False
