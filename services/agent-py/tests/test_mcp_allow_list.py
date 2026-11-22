"""Q48 — `allowedMcpServerIds` on agent-py's cloud MCP loading.

Absent → every enabled server of the workspace; a list → only those;
`[]` → none (no query at all). Covers the loader
(`mcp_tools.load_workspace_cloud_servers`) and the interactive runs'
contributor (`harness_hooks.cloud_mcp_tools`); the background executor's
side is in `test_background_resume.py`.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py.mcp_tools import load_workspace_cloud_servers
from agent_py.runs.harness_hooks import cloud_mcp_tools
from agent_py.runs.hook_types import ToolsetDraft
from agent_py.runs.options import parse_run_options
from agent_py.tools import ToolContext

USER_ID = "11111111-1111-1111-1111-111111111111"
WORKSPACE_ID = "22222222-2222-2222-2222-222222222222"
ROWS = [
    {"id": "s1", "name": "One", "url": "https://one.test/mcp", "capabilities": None},
    {"id": "s2", "name": "Two", "url": "https://two.test/mcp", "capabilities": None},
]


class _Conn:
    def __init__(self) -> None:
        self.fetched = 0

    async def execute(self, *_a: Any) -> None:
        return None

    async def fetch(self, *_a: Any) -> list[dict[str, Any]]:
        self.fetched += 1
        return ROWS

    def transaction(self) -> Any:
        conn = self

        class _Tx:
            async def __aenter__(self) -> _Conn:
                return conn

            async def __aexit__(self, *_a: Any) -> None:
                return None

        return _Tx()


def _pool(conn: _Conn) -> Any:
    class _Acquire:
        async def __aenter__(self) -> _Conn:
            return conn

        async def __aexit__(self, *_a: Any) -> None:
            return None

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=_Acquire())
    return pool


@pytest.mark.asyncio
async def test_loader_absent_list_and_empty() -> None:
    conn = _Conn()
    every = await load_workspace_cloud_servers(
        _pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID
    )
    assert [s.id for s in every] == ["s1", "s2"]
    some = await load_workspace_cloud_servers(
        _pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID, allowed_server_ids=["s2"]
    )
    assert [s.id for s in some] == ["s2"]
    fetched = conn.fetched
    none = await load_workspace_cloud_servers(
        _pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID, allowed_server_ids=[]
    )
    assert none == [] and conn.fetched == fetched  # no query


def _ctx() -> Any:
    return SimpleNamespace(
        tool_context=ToolContext(pool=MagicMock(), user_id=USER_ID, workspace_id=WORKSPACE_ID)
    )


@pytest.mark.asyncio
async def test_interactive_runs_filter_cloud_mcp() -> None:
    ri: Any = SimpleNamespace(run_id="r1")
    for options, expected in (
        ({}, None),
        ({"allowedMcpServerIds": ["s1"]}, ("s1",)),
    ):
        extend = AsyncMock()
        with patch("agent_py.mcp_tools.extend_registry_with_mcp", new=extend):
            await cloud_mcp_tools(ri, parse_run_options(options), _ctx(), ToolsetDraft())
        assert extend.await_args.kwargs["allowed_server_ids"] == expected
    extend = AsyncMock()
    with patch("agent_py.mcp_tools.extend_registry_with_mcp", new=extend):
        await cloud_mcp_tools(
            ri, parse_run_options({"allowedMcpServerIds": []}), _ctx(), ToolsetDraft()
        )
    extend.assert_not_awaited()
