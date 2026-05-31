"""MCP tool wiring — bridges the MCP client + credential helpers
into the agent's `default_tool_registry`.

Phase 3f-2 of PLAN-agent-api. Mirrors `lib/server/mcp/load-servers.ts`
+ `lib/server/mcp/tools.ts` on the TS side.

Pipeline:
  1. `load_workspace_cloud_servers(pool, *, user_id, workspace_id)`
     reads enabled, non-tombstoned cloud-mode rows from
     `public.mcp_servers` under per-user RLS impersonation. Each row
     carries the cached `capabilities` jsonb so we know what tools
     the server claims before any network call.
  2. `discover_mcp_tools_for_workspace` walks the rows in parallel
     and turns each cached tool descriptor into a `ToolDescriptor`
     via `build_mcp_tool`. Per-server failures (decrypt, network)
     drop that server and let the rest still register.
  3. `extend_registry_with_mcp` mutates a registry dict in place,
     adding `mcp__<server_id>__<tool>` entries. Called by the
     executor after `default_tool_registry()` so the model sees the
     full tool set.

Local-mode MCP servers aren't ported — the Python service runs
background after the chat route enqueues, so it never sees the
client-supplied `bodyServers` array the TS `loadEffectiveMcpServers`
merges in. Cloud-mode covers the durable case.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import asyncpg
import structlog

from . import store
from .mcp_client import (
    McpEndpoint,
)
from .mcp_client import (
    McpToolDescriptor as McpToolDescriptorIR,
)
from .mcp_client import (
    call_tool as mcp_call_tool,
)
from .mcp_credentials import fetch_decrypted_credentials
from .tools.registry import ToolDescriptor, ToolError, ToolInvocationResult

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class CloudMcpServerRow:
    """Loaded subset of `public.mcp_servers` — what discovery needs
    to call `discover` / `call_tool`. The cached `capabilities` jsonb
    tells us what tools the server has without a fresh handshake on
    every registry build."""

    id: str
    name: str
    url: str
    capabilities: dict[str, Any] | None = None


def mcp_tool_name(server_id: str, tool_name: str) -> str:
    """Stable name for a tool exposed by an MCP server. Matches the TS
    `mcpToolName` so the same tool surfaces under the same name on both
    stacks — important once the projection reducer / agent metadata
    sees Python-emitted events."""
    return f"mcp__{server_id}__{tool_name}"


# --- DB reader -------------------------------------------------------------


_LOAD_SERVERS_SQL = """
SELECT id::text, name, url, capabilities
FROM public.mcp_servers
WHERE workspace_id = $1::uuid
  AND credential_mode = 'cloud'
  AND enabled = true
  AND deleted_at IS NULL;
"""


async def load_workspace_cloud_servers(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    workspace_id: str,
) -> list[CloudMcpServerRow]:
    """Fetch enabled cloud-mode MCP servers for `workspace_id`, scoped
    by per-user RLS via `SET LOCAL ROLE authenticated` +
    `request.jwt.claims` (same pattern as `searchFiles` Phase 3c-2).

    Returns an empty list on RLS reject / DB error rather than raising —
    callers treat MCP as best-effort so a transient blip doesn't tank
    the whole run.
    """
    try:
        async with pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=user_id)
            rows = await conn.fetch(_LOAD_SERVERS_SQL, workspace_id)
    except Exception as exc:
        logger.warning(
            "mcp_tools.load_servers_failed",
            workspace_id=workspace_id,
            error=str(exc),
        )
        return []

    out: list[CloudMcpServerRow] = []
    for row in rows:
        out.append(
            CloudMcpServerRow(
                id=row["id"],
                name=row["name"],
                url=row["url"],
                capabilities=_decode_jsonb(row["capabilities"]),
            )
        )
    return out


def _decode_jsonb(raw: Any) -> dict[str, Any] | None:
    """asyncpg returns jsonb as str unless a codec is registered. Tolerate
    both shapes and bail to `None` on anything weird."""
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
        except Exception:
            return None
        return decoded if isinstance(decoded, dict) else None
    if isinstance(raw, dict):
        return raw
    return None


# --- Tool bridge -----------------------------------------------------------


def build_mcp_tool(
    *,
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None,
    descriptor: McpToolDescriptorIR,
) -> ToolDescriptor:
    """Wrap a single MCP tool descriptor as a `ToolDescriptor` the
    agent's registry can hand to the Anthropic SDK. The execute
    closure opens a fresh MCP session per call (`call_tool` does this
    internally), forwards the args, and surfaces `is_error` as a
    `ToolError` so the model sees a structured failure.

    Input-schema fallback: MCP servers may omit `inputSchema` for
    parameter-less tools — substitute an empty-object schema so the
    Anthropic SDK doesn't reject the tool registration. Mirrors the
    TS `buildMcpTool` fallback."""
    schema: dict[str, Any] = (
        descriptor.input_schema
        if isinstance(descriptor.input_schema, dict) and descriptor.input_schema
        else {"type": "object", "properties": {}}
    )

    description = descriptor.description or (
        f'MCP tool from "{endpoint.name}" (no description provided).'
    )

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        try:
            result = await mcp_call_tool(endpoint, credentials, descriptor.name, args)
        except Exception as exc:
            logger.warning(
                "mcp_tools.call_failed",
                server=endpoint.id,
                tool=descriptor.name,
                error=str(exc),
            )
            raise ToolError(f'MCP "{descriptor.name}" upstream error: {exc}') from exc

        if result.is_error:
            raise ToolError(result.text or f'MCP tool "{descriptor.name}" returned an error')
        # MCP tools are free-text shaped; mirror webFetch's summary
        # style ("<server> · <tool>") so UI pills stay short.
        summary = f"{endpoint.name} · {descriptor.name}"
        return ToolInvocationResult(text=result.text, summary=summary)

    return ToolDescriptor(
        name=mcp_tool_name(endpoint.id, descriptor.name),
        description=description,
        input_schema=schema,
        execute=execute,
    )


# --- Discovery + registry integration --------------------------------------


def _tools_from_capabilities(caps: dict[str, Any] | None) -> list[McpToolDescriptorIR]:
    """Pull tool descriptors out of the cached `capabilities` jsonb. Returns
    [] when the row hadn't cached tools yet (the workspace settings UI
    is responsible for refreshing the cache on add / refresh). Mirrors
    the McpToolDescriptor shape on the TS side."""
    if not caps:
        return []
    raw = caps.get("tools")
    if not isinstance(raw, list):
        return []
    out: list[McpToolDescriptorIR] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        description_raw = entry.get("description")
        description = description_raw if isinstance(description_raw, str) else None
        schema_raw = entry.get("inputSchema")
        schema = schema_raw if isinstance(schema_raw, dict) else None
        out.append(
            McpToolDescriptorIR(
                name=name,
                description=description,
                input_schema=schema,
            )
        )
    return out


async def _discover_one_server(
    pool: asyncpg.Pool,
    *,
    server: CloudMcpServerRow,
    user_id: str,
    encryption_key: str | None,
) -> list[ToolDescriptor]:
    """Decrypt the server's credentials, then turn each cached tool
    descriptor into a registry-ready `ToolDescriptor`. Per-server
    failure (no cred, no cached tools) returns [] so the workspace
    keeps its other servers' tools."""
    credentials = await fetch_decrypted_credentials(
        pool,
        user_id=user_id,
        server_id=server.id,
        encryption_key=encryption_key,
    )
    if credentials is None:
        logger.info(
            "mcp_tools.no_credentials",
            server_id=server.id,
            workspace="cloud",
        )
        return []
    descriptors = _tools_from_capabilities(server.capabilities)
    if not descriptors:
        return []
    endpoint = McpEndpoint(id=server.id, name=server.name, url=server.url)
    return [
        build_mcp_tool(endpoint=endpoint, credentials=credentials, descriptor=d)
        for d in descriptors
    ]


async def discover_mcp_tools_for_workspace(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    workspace_id: str,
    encryption_key: str | None = None,
) -> dict[str, ToolDescriptor]:
    """Load every cloud-mode server in the workspace + bridge every
    cached tool into a `ToolDescriptor`, ready to merge into the
    registry. Per-server failures (decrypt, missing cache) drop just
    that server.

    Decryption + bridging run concurrently across servers via
    `asyncio.gather` so a slow Postgres response on one row doesn't
    stall the others.
    """
    servers = await load_workspace_cloud_servers(pool, user_id=user_id, workspace_id=workspace_id)
    if not servers:
        return {}

    bundles = await asyncio.gather(
        *[
            _discover_one_server(
                pool,
                server=s,
                user_id=user_id,
                encryption_key=encryption_key,
            )
            for s in servers
        ],
        return_exceptions=True,
    )

    out: dict[str, ToolDescriptor] = {}
    for bundle in bundles:
        if isinstance(bundle, BaseException):
            logger.warning("mcp_tools.discover_one_failed", error=str(bundle))
            continue
        for desc in bundle:
            out[desc.name] = desc
    return out


async def extend_registry_with_mcp(
    registry: dict[str, ToolDescriptor],
    *,
    pool: asyncpg.Pool,
    user_id: str,
    workspace_id: str,
    encryption_key: str | None = None,
) -> dict[str, ToolDescriptor]:
    """Mutate `registry` in place, adding `mcp__<server>__<tool>`
    entries for every cloud-mode MCP tool the workspace exposes.
    Returns the same registry for chaining."""
    mcp_tools = await discover_mcp_tools_for_workspace(
        pool,
        user_id=user_id,
        workspace_id=workspace_id,
        encryption_key=encryption_key,
    )
    registry.update(mcp_tools)
    return registry


__all__ = [
    "CloudMcpServerRow",
    "build_mcp_tool",
    "discover_mcp_tools_for_workspace",
    "extend_registry_with_mcp",
    "load_workspace_cloud_servers",
    "mcp_tool_name",
]
