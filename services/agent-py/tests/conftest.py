"""Shared pytest fixtures.

Forces a clean settings cache and a clean DB-pool singleton between
tests so a test that sets env vars or opens a pool doesn't leak into
the next.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from agent_py import db as db_module
from agent_py import settings as settings_module


@pytest.fixture(autouse=True)
def reset_module_state() -> Iterator[None]:
    """Clear the `get_settings` lru_cache + the `db` pool singleton
    before AND after each test.

    Without this, the first test's settings + pool state would persist
    process-wide and downstream tests would see stale config.
    """
    settings_module.get_settings.cache_clear()
    db_module._pool = None  # type: ignore[attr-defined]  # test-only reset
    yield
    settings_module.get_settings.cache_clear()
    db_module._pool = None  # type: ignore[attr-defined]  # test-only reset
