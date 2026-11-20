"""Tests for the per-user opt-out from the Python executor.

Python executes everyone's tasks by default; `agent_backend` in
`raw_app_meta_data` is an opt-out. The contract is sharp because
misreading it would either (a) strand a default user's task (nothing
else executes it) or (b) run an opted-out user's task anyway.

  - row missing / metadata NULL / not an object / unparseable → executes
  - field absent / NULL / exactly 'python' → executes
  - field any other value ('off', 'none', 'ts', …) → opted out
  - DB error → unknown (None): the poller releases and retries
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.feature_flag import python_executes_for_user


def _fake_pool(fetchrow_result: Any = None, raises: BaseException | None = None) -> MagicMock:
    conn = MagicMock()
    if raises is not None:
        conn.fetchrow = AsyncMock(side_effect=raises)
    else:
        conn.fetchrow = AsyncMock(return_value=fetchrow_result)
    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


USER_ID = str(uuid.uuid4())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "meta",
    [
        None,
        {},
        {"other": "value"},
        {"agent_backend": None},
        {"agent_backend": "python"},
        '{"agent_backend":"python"}',
        "not json",
        ["not", "a", "dict"],
    ],
)
async def test_executes_by_default(meta: Any) -> None:
    pool = _fake_pool({"raw_app_meta_data": meta})
    assert await python_executes_for_user(pool, USER_ID) is True


@pytest.mark.asyncio
async def test_executes_when_user_row_missing() -> None:
    pool = _fake_pool(None)
    assert await python_executes_for_user(pool, USER_ID) is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "meta",
    [
        {"agent_backend": "off"},
        {"agent_backend": "none"},
        {"agent_backend": "ts"},
        {"agent_backend": False},
        '{"agent_backend":"off"}',
    ],
)
async def test_opted_out_when_field_is_any_other_value(meta: Any) -> None:
    pool = _fake_pool({"raw_app_meta_data": meta})
    assert await python_executes_for_user(pool, USER_ID) is False


@pytest.mark.asyncio
async def test_unknown_when_db_raises() -> None:
    """A lookup failure is neither answer: executing would override an
    opt-out, so the poller releases and retries instead."""
    pool = _fake_pool(raises=RuntimeError("connection refused"))
    assert await python_executes_for_user(pool, USER_ID) is None


@pytest.mark.asyncio
async def test_reads_app_metadata_not_user_metadata() -> None:
    """The flag must come from `raw_app_meta_data` (service-role only).
    `raw_user_meta_data` is user-writable via `auth.updateUser({data})`,
    so a user can't opt themselves in or out."""
    pool = _fake_pool({"raw_app_meta_data": None})
    await python_executes_for_user(pool, USER_ID)
    conn = pool.acquire.return_value.__aenter__.return_value
    sql = conn.fetchrow.await_args.args[0]
    assert "raw_app_meta_data" in sql
    assert "raw_user_meta_data" not in sql
