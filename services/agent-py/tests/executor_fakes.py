"""The executor's atomic commits, faked for the hermetic tests.

A pause, a spawn and a settle write their log entries in the row's own
transaction (wave 5c), not through the sink; these fakes land them in
the list a test's sink fills, as the commit would.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

from agent_py.barrier import SettleResult
from agent_py.events import TaskEvent


def fake_settle(collected: list[TaskEvent], *, transitioned: bool = True) -> AsyncMock:
    async def settle(*_a: Any, event: TaskEvent | None = None, **_kw: Any) -> SettleResult:
        if transitioned and event is not None:
            collected.append(event)
        return SettleResult(transitioned, None)

    return AsyncMock(side_effect=settle)


def fake_pause(collected: list[TaskEvent]) -> AsyncMock:
    async def pause(*_a: Any, pause_events: list[TaskEvent], **_kw: Any) -> bool:
        collected.extend(pause_events)
        return True

    return AsyncMock(side_effect=pause)


__all__ = ["fake_pause", "fake_settle"]
