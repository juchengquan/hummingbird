"""Phase 3f-2 tests — MCP tool wiring (`mcp_tools` module).

Hermetic:
  - DB fakes via a stand-in `_FakePool` so RLS impersonation + SQL
    issuance can be asserted without a live Postgres.
  - `mcp_client.call_tool` is patched at the module boundary so we
    test the bridge contract (descriptor name format, schema
    fallback, error mapping) without touching the MCP SDK.

Covered:
  - `mcp_tool_name` formats the stable id.
  - `_tools_from_capabilities` parses cached jsonb defensively.
  - `load_workspace_cloud_servers` issues SET ROLE + set_config in
    order, then the SELECT; empty list on DB error.
  - `build_mcp_tool` returns a ToolDescriptor with prefixed name,
    fallback schema, fallback description; execute calls
    `mcp_call_tool` and turns is_error into ToolError.
  - `discover_mcp_tools_for_workspace` end-to-end happy path +
    per-server skip on missing credentials.
  - `extend_registry_with_mcp` merges discovered tools in place.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_py import mcp_tools as mcp_tools_mod
from agent_py.mcp_client import (
    McpEndpoint,
    McpToolResult,
)
from agent_py.mcp_client import (
    McpToolDescriptor as McpToolDescriptorIR,
)
from agent_py.mcp_tools import (
    _tools_from_capabilities,
    build_mcp_tool,
    discover_mcp_tools_for_workspace,
    extend_registry_with_mcp,
    load_workspace_cloud_servers,
    mcp_tool_name,
)
from agent_py.tools.registry import ToolDescriptor, ToolError

USER_ID = "11111111-1111-1111-1111-111111111111"
WORKSPACE_ID = "22222222-2222-2222-2222-222222222222"
SERVER_ID = "33333333-3333-3333-3333-333333333333"


# --- DB fakes ----------------------------------------------------------


class _FakeConnection:
    def __init__(
        self, rows: list[dict[str, Any]] | None = None, raises: Exception | None = None
    ) -> None:
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self.fetched: list[tuple[str, tuple[Any, ...]]] = []
        self._rows = rows or []
        self._raises = raises

    async def execute(self, sql: str, *args: Any) -> None:
        self.executed.append((sql, args))

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.fetched.append((sql, args))
        if self._raises is not None:
            raise self._raises
        return self._rows

    def transaction(self):
        return _FakeTransaction()


class _FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *args: Any) -> None:
        return None


def _fake_pool(conn: _FakeConnection) -> Any:
    pool = MagicMock()

    class _Acquire:
        async def __aenter__(self) -> _FakeConnection:
            return conn

        async def __aexit__(self, *args: Any) -> None:
            return None

    pool.acquire = MagicMock(return_value=_Acquire())
    return pool


# --- mcp_tool_name ----------------------------------------------------


def test_mcp_tool_name_format() -> None:
    assert mcp_tool_name("srv-a", "greet") == "mcp__srv-a__greet"


# --- _tools_from_capabilities ----------------------------------------


def test_tools_from_capabilities_none_returns_empty() -> None:
    assert _tools_from_capabilities(None) == []
    assert _tools_from_capabilities({}) == []
    assert _tools_from_capabilities({"other": []}) == []


def test_tools_from_capabilities_filters_invalid_entries() -> None:
    out = _tools_from_capabilities(
        {
            "tools": [
                {"name": "ok", "description": "d", "inputSchema": {"type": "object"}},
                "not a dict",
                {"name": ""},
                {"name": None},
                {"description": "no name"},
                {"name": "minimal"},  # no description / schema
            ]
        }
    )
    assert len(out) == 2
    assert out[0].name == "ok"
    assert out[0].description == "d"
    assert out[0].input_schema == {"type": "object"}
    assert out[1].name == "minimal"
    assert out[1].description is None
    assert out[1].input_schema is None


# --- load_workspace_cloud_servers ------------------------------------


@pytest.mark.asyncio
async def test_load_servers_issues_rls_set_role_then_select() -> None:
    row = {
        "id": SERVER_ID,
        "name": "Test MCP",
        "url": "https://mcp.test/sse",
        "capabilities": json.dumps({"tools": [{"name": "greet"}]}),
    }
    conn = _FakeConnection(rows=[row])
    out = await load_workspace_cloud_servers(
        _fake_pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID
    )
    assert len(out) == 1
    assert out[0].id == SERVER_ID
    assert out[0].name == "Test MCP"
    assert out[0].capabilities == {"tools": [{"name": "greet"}]}
    # RLS impersonation: SET LOCAL ROLE + set_config issued before the SELECT.
    assert len(conn.executed) == 2
    assert "SET LOCAL ROLE authenticated" in conn.executed[0][0]
    assert "set_config" in conn.executed[1][0]
    # SELECT filters by workspace_id.
    assert len(conn.fetched) == 1
    assert conn.fetched[0][1][0] == WORKSPACE_ID


@pytest.mark.asyncio
async def test_load_servers_dict_capabilities_passthrough() -> None:
    """If asyncpg's jsonb codec is registered, capabilities arrive as
    a dict — no decode step needed."""
    row = {
        "id": SERVER_ID,
        "name": "n",
        "url": "https://x",
        "capabilities": {"tools": [{"name": "t"}]},
    }
    conn = _FakeConnection(rows=[row])
    out = await load_workspace_cloud_servers(
        _fake_pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID
    )
    assert out[0].capabilities == {"tools": [{"name": "t"}]}


@pytest.mark.asyncio
async def test_load_servers_db_error_returns_empty() -> None:
    conn = _FakeConnection(raises=RuntimeError("conn lost"))
    out = await load_workspace_cloud_servers(
        _fake_pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID
    )
    assert out == []


@pytest.mark.asyncio
async def test_load_servers_invalid_capabilities_jsonb_becomes_none() -> None:
    row = {
        "id": SERVER_ID,
        "name": "n",
        "url": "https://x",
        "capabilities": "not-json",
    }
    conn = _FakeConnection(rows=[row])
    out = await load_workspace_cloud_servers(
        _fake_pool(conn), user_id=USER_ID, workspace_id=WORKSPACE_ID
    )
    assert out[0].capabilities is None


# --- build_mcp_tool ---------------------------------------------------


def _endpoint() -> McpEndpoint:
    return McpEndpoint(id="srv-1", name="My MCP", url="https://m.test/sse")


def test_build_mcp_tool_descriptor_shape() -> None:
    desc = McpToolDescriptorIR(
        name="greet",
        description="say hi",
        input_schema={"type": "object", "required": ["name"]},
    )
    tool = build_mcp_tool(endpoint=_endpoint(), credentials=None, descriptor=desc)
    assert tool.name == "mcp__srv-1__greet"
    assert tool.description == "say hi"
    assert tool.input_schema == {"type": "object", "required": ["name"]}


def test_build_mcp_tool_falls_back_to_default_schema() -> None:
    """Parameter-less tools may omit inputSchema entirely. The Anthropic
    SDK refuses tools without a schema, so we substitute an empty-object
    one. Mirrors the TS path."""
    desc = McpToolDescriptorIR(name="ping", description=None, input_schema=None)
    tool = build_mcp_tool(endpoint=_endpoint(), credentials=None, descriptor=desc)
    assert tool.input_schema == {"type": "object", "properties": {}}
    # Fallback description includes the server name so the model has
    # provenance even when the upstream tool didn't bother.
    assert "My MCP" in tool.description


@pytest.mark.asyncio
async def test_build_mcp_tool_execute_returns_text() -> None:
    desc = McpToolDescriptorIR(name="hello", description="d")
    tool = build_mcp_tool(endpoint=_endpoint(), credentials={"headers": {}}, descriptor=desc)
    with patch.object(
        mcp_tools_mod,
        "mcp_call_tool",
        new=AsyncMock(return_value=McpToolResult(text="hi there", is_error=False)),
    ):
        out = await tool.execute({"name": "world"})
    assert out.text == "hi there"
    assert out.summary == "My MCP · hello"


@pytest.mark.asyncio
async def test_build_mcp_tool_is_error_raises_tool_error() -> None:
    desc = McpToolDescriptorIR(name="boom")
    tool = build_mcp_tool(endpoint=_endpoint(), credentials=None, descriptor=desc)
    with (
        patch.object(
            mcp_tools_mod,
            "mcp_call_tool",
            new=AsyncMock(return_value=McpToolResult(text="upstream said no", is_error=True)),
        ),
        pytest.raises(ToolError, match="upstream said no"),
    ):
        await tool.execute({})


@pytest.mark.asyncio
async def test_build_mcp_tool_upstream_exception_wrapped() -> None:
    desc = McpToolDescriptorIR(name="net")
    tool = build_mcp_tool(endpoint=_endpoint(), credentials=None, descriptor=desc)
    with (
        patch.object(
            mcp_tools_mod,
            "mcp_call_tool",
            new=AsyncMock(side_effect=RuntimeError("conn refused")),
        ),
        pytest.raises(ToolError, match="upstream error"),
    ):
        await tool.execute({})


# --- discover_mcp_tools_for_workspace --------------------------------


@pytest.mark.asyncio
async def test_discover_end_to_end_happy_path() -> None:
    """Workspace has one cloud server with two cached tools; both
    register under the prefixed name. Cred decryption returns a dict;
    discovery doesn't open a network connection (build_mcp_tool only
    builds descriptors)."""
    row = {
        "id": SERVER_ID,
        "name": "Demo",
        "url": "https://mcp.test/sse",
        "capabilities": json.dumps(
            {"tools": [{"name": "alpha"}, {"name": "beta", "description": "b"}]}
        ),
    }
    conn = _FakeConnection(rows=[row])
    with patch.object(
        mcp_tools_mod,
        "fetch_decrypted_credentials",
        new=AsyncMock(return_value={"headers": {"X-API-Key": "k"}}),
    ):
        out = await discover_mcp_tools_for_workspace(
            _fake_pool(conn),
            user_id=USER_ID,
            workspace_id=WORKSPACE_ID,
            encryption_key="k" * 32,
        )
    assert set(out.keys()) == {
        f"mcp__{SERVER_ID}__alpha",
        f"mcp__{SERVER_ID}__beta",
    }
    assert out[f"mcp__{SERVER_ID}__beta"].description == "b"


@pytest.mark.asyncio
async def test_discover_skips_servers_without_credentials() -> None:
    """A server whose credentials don't decrypt (or aren't configured)
    drops out of the registry. Other servers still load."""
    rows = [
        {
            "id": "aaa",
            "name": "A",
            "url": "https://a/sse",
            "capabilities": json.dumps({"tools": [{"name": "ta"}]}),
        },
        {
            "id": "bbb",
            "name": "B",
            "url": "https://b/sse",
            "capabilities": json.dumps({"tools": [{"name": "tb"}]}),
        },
    ]
    conn = _FakeConnection(rows=rows)

    call_count = {"n": 0}

    async def fake_fetch(*args: Any, **kwargs: Any) -> Any:
        call_count["n"] += 1
        # First server: bad key. Second: good.
        return None if call_count["n"] == 1 else {"headers": {}}

    with patch.object(mcp_tools_mod, "fetch_decrypted_credentials", new=fake_fetch):
        out = await discover_mcp_tools_for_workspace(
            _fake_pool(conn),
            user_id=USER_ID,
            workspace_id=WORKSPACE_ID,
            encryption_key="k" * 32,
        )
    # Only one of the two servers contributed.
    assert len(out) == 1


@pytest.mark.asyncio
async def test_discover_no_servers_returns_empty() -> None:
    """Workspace has no MCP servers → empty registry, no fetch calls."""
    conn = _FakeConnection(rows=[])
    fetch_mock = AsyncMock()
    with patch.object(mcp_tools_mod, "fetch_decrypted_credentials", new=fetch_mock):
        out = await discover_mcp_tools_for_workspace(
            _fake_pool(conn),
            user_id=USER_ID,
            workspace_id=WORKSPACE_ID,
            encryption_key="k" * 32,
        )
    assert out == {}
    fetch_mock.assert_not_awaited()


# --- extend_registry_with_mcp ----------------------------------------


@pytest.mark.asyncio
async def test_extend_registry_with_mcp_merges() -> None:
    registry: dict[str, ToolDescriptor] = {
        "webFetch": ToolDescriptor(
            name="webFetch",
            description="d",
            input_schema={"type": "object"},
            execute=AsyncMock(),
        )
    }
    conn = _FakeConnection(
        rows=[
            {
                "id": SERVER_ID,
                "name": "n",
                "url": "https://x/sse",
                "capabilities": json.dumps({"tools": [{"name": "t"}]}),
            }
        ]
    )
    with patch.object(
        mcp_tools_mod,
        "fetch_decrypted_credentials",
        new=AsyncMock(return_value={"headers": {}}),
    ):
        out = await extend_registry_with_mcp(
            registry,
            pool=_fake_pool(conn),
            user_id=USER_ID,
            workspace_id=WORKSPACE_ID,
            encryption_key="k" * 32,
        )
    # Same dict, mutated in place.
    assert out is registry
    assert "webFetch" in registry
    assert f"mcp__{SERVER_ID}__t" in registry


# --- gated_tool_names_for --------------------------------------------


from agent_py.mcp_tools import (  # noqa: E402
    CloudMcpServerRow,
    gated_tool_names_for,
)


def _server(id: str, *, requires_approval: bool, tools: list[str]) -> CloudMcpServerRow:
    return CloudMcpServerRow(
        id=id,
        name=id,
        url="https://x",
        capabilities={"tools": [{"name": t} for t in tools]},
        requires_approval=requires_approval,
    )


def test_gated_tool_names_for_flagged_server() -> None:
    servers = [_server("s1", requires_approval=True, tools=["write", "read"])]
    assert gated_tool_names_for(servers) == {
        mcp_tool_name("s1", "write"),
        mcp_tool_name("s1", "read"),
    }


def test_gated_tool_names_for_skips_unflagged() -> None:
    servers = [_server("s1", requires_approval=False, tools=["write"])]
    assert gated_tool_names_for(servers) == set()


def test_gated_tool_names_for_flagged_no_tools() -> None:
    servers = [
        CloudMcpServerRow(
            id="s1", name="s1", url="https://x", capabilities=None, requires_approval=True
        ),
    ]
    assert gated_tool_names_for(servers) == set()


def test_gated_tool_names_for_mixed() -> None:
    servers = [
        _server("s1", requires_approval=True, tools=["danger"]),
        _server("s2", requires_approval=False, tools=["safe"]),
    ]
    assert gated_tool_names_for(servers) == {mcp_tool_name("s1", "danger")}
