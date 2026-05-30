"""Shared pytest fixtures.

Forces a clean settings cache between tests so a test that sets env
vars doesn't leak into the next. The `get_settings` lru_cache is otherwise
process-wide.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from agent_py import settings as settings_module


@pytest.fixture(autouse=True)
def reset_settings_cache() -> Iterator[None]:
    """Clear the `get_settings` cache before AND after each test.

    Tests typically mutate `monkeypatch.setenv(...)` before calling
    `get_settings()`. Without this fixture the first test wins forever
    because the `lru_cache` would freeze in whatever state it saw first.
    """
    settings_module.get_settings.cache_clear()
    yield
    settings_module.get_settings.cache_clear()
