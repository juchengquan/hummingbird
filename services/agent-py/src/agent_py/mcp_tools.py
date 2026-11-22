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
     via `build_mcp_tool`. Per-server failures (SSRF-blocked URL,
     decrypt, network) drop that server and let the rest still register.
  3. `extend_registry_with_mcp` mutates a registry dict in place,
     adding `mcp__<server_id>__<tool>` entries. Called by the
     executor after `default_tool_registry()` so the model sees the
     full tool set.

Local-mode servers (credentials held by the browser) reach interactive
runs only — `runs/local_mcp.py` builds their tools with the same
`build_mcp_tool` from `forwardedProps.localMcpServers` + the credentials
in the run's `state` (Q42, Q45).

**MCP Apps.** A tool whose descriptor declares a `uiResourceUri` reads
that `ui://` resource after it ran and returns it as
`ToolInvocationResult.mcp_app` (capped at `MCP_APP_MAX_BYTES`, else a
truncated placeholder) — the Next chat route's `data-mcp-app` frame.

**Credentials** go to the server as headers and nowhere else: whatever
comes back from it (tool text, an error, the App's HTML, an exception
logged) passes `credential_redactor` first, so a server or SDK echoing
a header value doesn't put it in a log, a tool result or the event log.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any

import asyncpg
import structlog

from . import store
from .mcp_client import (
    McpEndpoint,
    McpUrlBlockedError,
    validate_mcp_url,
)
from .mcp_client import (
    McpToolDescriptor as McpToolDescriptorIR,
)
from .mcp_client import (
    call_tool as mcp_call_tool,
)
from .mcp_client import (
    read_resource as mcp_read_resource,
)
from .mcp_credentials import fetch_decrypted_credentials
from .tools.registry import McpAppPayload, ToolDescriptor, ToolError, ToolInvocationResult
from .url_validate import OutboundUrlPolicy

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
    requires_approval: bool = False


def mcp_tool_name(server_id: str, tool_name: str) -> str:
    """Stable name for a tool exposed by an MCP server. Matches the TS
    `mcpToolName` so the same tool surfaces under the same name on both
    stacks — important once the projection reducer / agent metadata
    sees Python-emitted events."""
    return f"mcp__{server_id}__{tool_name}"


def gated_tool_names_for(servers: list[CloudMcpServerRow]) -> set[str]:
    """Tool names to HITL-gate by server policy: for every server with
    `requires_approval`, the `mcp__<id>__<tool>` name of each tool in its
    cached capabilities. Pure — derived from the server rows, independent
    of whether the tool actually registered (gating a non-registered name
    is a harmless no-op)."""
    names: set[str] = set()
    for server in servers:
        if not server.requires_approval:
            continue
        for descriptor in _tools_from_capabilities(server.capabilities):
            names.add(mcp_tool_name(server.id, descriptor.name))
    return names


# --- DB reader -------------------------------------------------------------


_LOAD_SERVERS_SQL = """
SELECT id::text, name, url, capabilities, requires_approval
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
    allowed_server_ids: Collection[str] | None = None,
) -> list[CloudMcpServerRow]:
    """Fetch enabled cloud-mode MCP servers for `workspace_id`, scoped
    by per-user RLS via `SET LOCAL ROLE authenticated` +
    `request.jwt.claims` (same pattern as `searchFiles` Phase 3c-2).

    `allowed_server_ids` is the run's allow-list (Q48,
    `allowedMcpServerIds`): None → every enabled server; otherwise only
    the servers it names (empty → none, without a query) — as Next's
    `loadEffectiveMcpServers(…, {allowedServerIds})`.

    Returns an empty list on RLS reject / DB error rather than raising —
    callers treat MCP as best-effort so a transient blip doesn't tank
    the whole run.
    """
    allow = None if allowed_server_ids is None else frozenset(allowed_server_ids)
    if allow is not None and not allow:
        return []
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
        if allow is not None and row["id"] not in allow:
            continue
        out.append(
            CloudMcpServerRow(
                id=row["id"],
                name=row["name"],
                url=row["url"],
                capabilities=_decode_jsonb(row["capabilities"]),
                requires_approval=bool(row.get("requires_approval", False)),
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

# Tool-result text for a call that failed before the server answered
# (blocked URL, connect / TLS / HTTP error). Deliberately detail-free.
_GENERIC_CALL_ERROR = 'MCP tool "{tool}" failed: the MCP server request did not succeed.'

#: Cap on an MCP App's `ui://` bundle — `MCP_APP_MAX_BYTES` in the Next
#: chat route (it counts UTF-16 units; this counts UTF-8 bytes, the same
#: for ASCII). Over it, the App is a truncated placeholder.
MCP_APP_MAX_BYTES = 512_000
#: The placeholder HTML of an oversized App (the client renders a "UI too
#: large" stub from `truncated`; non-empty for a client that ignores it).
MCP_APP_TRUNCATED_HTML = "<!-- truncated -->"

_REDACTED = "[redacted]"
_MIN_SECRET_LEN = 8


def credential_redactor(credentials: Mapping[str, Any] | None) -> Callable[[str], str]:
    """A function that blanks the credential's header values out of a
    string — for everything that comes back from an MCP server or its
    SDK (a server may echo the request's headers in an error). Values
    shorter than 8 characters are left alone (they can't be told apart
    from ordinary text, and aren't secrets worth the name); a
    `<scheme> <token>` value (`Bearer …`) is blanked whole and by its
    token alone."""
    secrets: set[str] = set()
    raw = credentials.get("headers") if credentials else None
    if isinstance(raw, Mapping):
        for value in raw.values():
            if not isinstance(value, str):
                continue
            for candidate in (value, value.partition(" ")[2]):
                candidate = candidate.strip()
                if len(candidate) >= _MIN_SECRET_LEN:
                    secrets.add(candidate)
    ordered = sorted(secrets, key=len, reverse=True)

    def redact(text: str) -> str:
        for secret in ordered:
            if secret in text:
                text = text.replace(secret, _REDACTED)
        return text

    return redact


def build_mcp_tool(
    *,
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None,
    descriptor: McpToolDescriptorIR,
    policy: OutboundUrlPolicy | None = None,
) -> ToolDescriptor:
    """Wrap a single MCP tool descriptor as a `ToolDescriptor` the
    agent's registry can hand to the Anthropic SDK. The execute
    closure opens a fresh MCP session per call (`call_tool` does this
    internally), forwards the args, and surfaces `is_error` as a
    `ToolError` so the model sees a structured failure.

    `policy` is the SSRF policy of the call (default: the MCP one,
    `mcp_client.mcp_outbound_policy`, read per call). A descriptor with
    `ui_resource_uri` also reads that resource after a successful call
    and returns it as the result's `mcp_app` (MCP Apps).

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
    redact = credential_redactor(credentials)

    async def execute(args: dict[str, Any]) -> ToolInvocationResult:
        try:
            result = await mcp_call_tool(
                endpoint, credentials, descriptor.name, args, policy=policy
            )
        except Exception as exc:
            # Log the detail, never hand it to the model: the SDK embeds
            # upstream response bodies / connect errors in its messages,
            # which would turn the tool into an internal-network oracle.
            logger.warning(
                "mcp_tools.call_failed",
                server=endpoint.id,
                tool=descriptor.name,
                error_type=type(exc).__name__,
                error=redact(str(exc)),
            )
            raise ToolError(_GENERIC_CALL_ERROR.format(tool=descriptor.name)) from None

        if result.is_error:
            raise ToolError(
                redact(result.text) or f'MCP tool "{descriptor.name}" returned an error'
            )
        # MCP tools are free-text shaped; mirror webFetch's summary
        # style ("<server> · <tool>") so UI pills stay short.
        summary = f"{endpoint.name} · {descriptor.name}"
        app = (
            await _read_mcp_app(endpoint, credentials, descriptor.ui_resource_uri, policy, redact)
            if descriptor.ui_resource_uri
            else None
        )
        return ToolInvocationResult(text=redact(result.text), summary=summary, mcp_app=app)

    return ToolDescriptor(
        name=mcp_tool_name(endpoint.id, descriptor.name),
        description=description,
        input_schema=schema,
        execute=execute,
        # An arbitrary third-party action — assume it has side effects.
        side_effecting=True,
    )


async def _read_mcp_app(
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None,
    uri: str,
    policy: OutboundUrlPolicy | None,
    redact: Callable[[str], str],
) -> McpAppPayload | None:
    """The tool's MCP App: its `ui://` resource, read after the tool ran
    (the Next chat route's `readResource` → `data-mcp-app`). Over
    `MCP_APP_MAX_BYTES` → the truncated placeholder; no text → none. A
    failed read is logged and yields no App — the tool's text result
    already stands, so a missing panel must not fail the call."""
    try:
        res = await mcp_read_resource(endpoint, credentials, uri, policy=policy)
    except Exception as exc:
        logger.warning(
            "mcp_tools.app_read_failed",
            server=endpoint.id,
            uri=uri,
            error_type=type(exc).__name__,
            error=redact(str(exc)),
        )
        return None
    html = res.text
    if not html:
        return None
    if len(html.encode("utf-8")) > MCP_APP_MAX_BYTES:
        return McpAppPayload(
            server_id=endpoint.id,
            html=MCP_APP_TRUNCATED_HTML,
            resource_uri=uri,
            truncated=True,
        )
    return McpAppPayload(server_id=endpoint.id, html=redact(html), resource_uri=uri)


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
        # MCP Apps: the `ui://` resource the tool renders (cached at
        # discovery from `_meta.ui.resourceUri`).
        ui_raw = entry.get("uiResourceUri")
        out.append(
            McpToolDescriptorIR(
                name=name,
                description=description,
                input_schema=schema,
                ui_resource_uri=ui_raw if isinstance(ui_raw, str) and ui_raw else None,
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
    """Check the server's URL, decrypt its credentials, then turn each
    cached tool descriptor into a registry-ready `ToolDescriptor`.
    Per-server failure (blocked URL, no cred, no cached tools) returns
    [] so the workspace keeps its other servers' tools."""
    descriptors = _tools_from_capabilities(server.capabilities)
    if not descriptors:
        return []
    # SSRF gate at load: `mcp_servers.url` is user-editable under RLS, so
    # the upsert-time check proves nothing about the row we just read. A
    # blocked URL drops the server's tools before its credential is even
    # decrypted (the session re-checks on every call too — DNS can change
    # between load and call).
    try:
        url = await validate_mcp_url(server.url)
    except McpUrlBlockedError as exc:
        logger.warning(
            "mcp_tools.server_url_blocked",
            server_id=server.id,
            reason=exc.validation.code,
        )
        return []
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
    endpoint = McpEndpoint(id=server.id, name=server.name, url=url)
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
    gated_out: set[str] | None = None,
    allowed_server_ids: Collection[str] | None = None,
) -> dict[str, ToolDescriptor]:
    """Load every cloud-mode server in the workspace + bridge every
    cached tool into a `ToolDescriptor`, ready to merge into the
    registry. Per-server failures (blocked URL, decrypt, missing cache)
    drop just that server.

    Decryption + bridging run concurrently across servers via
    `asyncio.gather` so a slow Postgres response on one row doesn't
    stall the others.

    `gated_out` (optional) is a mutable set the caller owns; when
    provided, tool names for servers with `requires_approval=True` are
    added to it so the executor can gate those tools without a second
    pass over the server list.

    `allowed_server_ids` — the run's allow-list (Q48), see
    `load_workspace_cloud_servers`.
    """
    servers = await load_workspace_cloud_servers(
        pool,
        user_id=user_id,
        workspace_id=workspace_id,
        allowed_server_ids=allowed_server_ids,
    )
    if gated_out is not None:
        gated_out.update(gated_tool_names_for(servers))
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
    gated_out: set[str] | None = None,
    allowed_server_ids: Collection[str] | None = None,
) -> dict[str, ToolDescriptor]:
    """Mutate `registry` in place, adding `mcp__<server>__<tool>`
    entries for every cloud-mode MCP tool the workspace exposes.
    Returns the same registry for chaining.

    `gated_out` (optional) is forwarded to `discover_mcp_tools_for_workspace`
    so the executor can collect server-policy gate names in one pass.
    `allowed_server_ids` (Q48): None → every enabled server; a collection
    → only those (empty → none)."""
    mcp_tools = await discover_mcp_tools_for_workspace(
        pool,
        user_id=user_id,
        workspace_id=workspace_id,
        encryption_key=encryption_key,
        gated_out=gated_out,
        allowed_server_ids=allowed_server_ids,
    )
    registry.update(mcp_tools)
    return registry


__all__ = [
    "MCP_APP_MAX_BYTES",
    "MCP_APP_TRUNCATED_HTML",
    "CloudMcpServerRow",
    "build_mcp_tool",
    "credential_redactor",
    "discover_mcp_tools_for_workspace",
    "extend_registry_with_mcp",
    "gated_tool_names_for",
    "load_workspace_cloud_servers",
    "mcp_tool_name",
]
