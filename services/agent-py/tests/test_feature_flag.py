"""Tests for the per-user Python-executor feature flag.

The contract is sharp because misreading it would either (a) silently
let Python execute for unflagged users (a Phase 2 invariant
violation) or (b) silently keep flagged users on the TS path (the
flag is useless).

Every shape of the metadata column gets a test:
  - row missing → not flagged
  - metadata NULL → not flagged
  - metadata is JSON string → parsed, then checked
  - metadata is dict → checked directly
  - metadata is dict but field absent → not flagged
  - metadata is dict, field is the wrong value → not flagged
  - metadata is dict, field is exactly 'python' → FLAGGED
  - DB error → not flagged (safe fallback to TS path)
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_py.feature_flag import is_user_flagged_to_python


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
async def test_flagged_when_field_is_python() -> None:
    pool = _fake_pool({"raw_user_meta_data": {"agent_backend": "python"}})
    assert await is_user_flagged_to_python(pool, USER_ID) is True


@pytest.mark.asyncio
async def test_flagged_when_metadata_is_json_string() -> None:
    """asyncpg's jsonb codec may or may not be registered; tolerate
    both decoded dicts and the raw JSON string."""
    pool = _fake_pool({"raw_user_meta_data": '{"agent_backend":"python"}'})
    assert await is_user_flagged_to_python(pool, USER_ID) is True


@pytest.mark.asyncio
async def test_not_flagged_when_row_missing() -> None:
    pool = _fake_pool(None)
    assert await is_user_flagged_to_python(pool, USER_ID) is False


@pytest.mark.asyncio
async def test_not_flagged_when_metadata_null() -> None:
    pool = _fake_pool({"raw_user_meta_data": None})
    assert await is_user_flagged_to_python(pool, USER_ID) is False


@pytest.mark.asyncio
async def test_not_flagged_when_field_absent() -> None:
    pool = _fake_pool({"raw_user_meta_data": {"other": "value"}})
    assert await is_user_flagged_to_python(pool, USER_ID) is False


@pytest.mark.asyncio
async def test_not_flagged_when_field_is_other_value() -> None:
    pool = _fake_pool({"raw_user_meta_data": {"agent_backend": "ts"}})
    assert await is_user_flagged_to_python(pool, USER_ID) is False


@pytest.mark.asyncio
async def test_not_flagged_when_metadata_is_garbage_string() -> None:
    pool = _fake_pool({"raw_user_meta_data": "not json"})
    assert await is_user_flagged_to_python(pool, USER_ID) is False


@pytest.mark.asyncio
async def test_not_flagged_when_db_raises() -> None:
    """A flag-lookup failure must fall back to the TS worker; never
    let a DB blip silently switch a user TO Python."""
    pool = _fake_pool(raises=RuntimeError("connection refused"))
    assert await is_user_flagged_to_python(pool, USER_ID) is False
