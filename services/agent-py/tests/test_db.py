"""Tests for the Postgres pool lifecycle.

We can't open a real pool without a Postgres URL, so these tests
cover the boot-without-config path + the idempotency contract. The
real-pool integration check is exercised in CI's optional
postgres-against-services job (added in Phase 2 when there's
something to talk to).
"""

from __future__ import annotations

import pytest

from agent_py import db


@pytest.mark.asyncio
async def test_init_pool_with_empty_dsn_skips() -> None:
    """Boot without `SUPABASE_DB_URL` should be a no-op, not an
    error. `has_pool()` reports False so the poller knows to no-op."""
    await db.init_pool("")
    assert db.has_pool() is False


@pytest.mark.asyncio
async def test_init_pool_with_none_dsn_skips() -> None:
    await db.init_pool(None)
    assert db.has_pool() is False


@pytest.mark.asyncio
async def test_close_pool_when_not_open_is_noop() -> None:
    """Idempotent close — used by the lifespan finally branch, must
    not raise even if init never set a pool."""
    await db.close_pool()
    assert db.has_pool() is False


def test_get_pool_raises_when_not_initialised() -> None:
    """Production paths call `get_pool()`; raising here forces the
    caller to handle the "no DB" case explicitly rather than silently
    operating on None."""
    with pytest.raises(RuntimeError, match="not initialised"):
        db.get_pool()
