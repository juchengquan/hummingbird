"""Local MCP tools on interactive runs (Q42, Q45) — a `ToolContributor`.

A local-mode MCP server's credentials live in the browser. The run's
request lists the servers with their cached tools in
`forwardedProps.localMcpServers` (`RunOptions.local_mcp_servers`) and
their credentials in `state["hummingbird.localMcp"]`
(`RunInput.local_mcp_credentials`, `runs/credentials.py`). This hook
turns each cached tool into an `mcp__<serverId>__<tool>` tool — no
discovery call, as the Next chat route builds MCP tools from the
client-supplied capabilities (`app/api/chat/route.ts`,
`loadEffectiveMcpServers`):

* a server outside `allowedMcpServerIds` is skipped (absent = no
  restriction, `[]` = no MCP at all — `loadEffectiveMcpServers`'
  `allowedServerIds`, applied to local servers too);
* a server whose URL fails the MCP SSRF policy (`mcp_outbound_policy`:
  public hosts, plus private ones under `MCP_ALLOW_PRIVATE_HOSTS=true`)
  is dropped, as `dropBlockedUrls` does; every call re-checks it, at
  connect time too (`mcp_client._open_session`);
* `requiresApproval` gates every tool of the server (`draft.gated`), as
  for cloud servers;
* a server without a credential still gets its tools — the call goes
  without headers (servers that need none work; the others refuse).

The credential reaches only the MCP request's headers: `build_mcp_tool`
redacts it out of whatever comes back, and nothing here logs it.
"""

from __future__ import annotations

import asyncio

import structlog

from ..mcp_client import (
    McpEndpoint,
    McpToolDescriptor,
    McpUrlBlockedError,
    mcp_outbound_policy,
    validate_mcp_url,
)
from ..mcp_tools import build_mcp_tool
from ..url_validate import OutboundUrlPolicy
from .harness import RunInput
from .hook_types import HookContext, ToolsetDraft
from .options import LocalMcpServer, RunOptions

logger = structlog.get_logger(__name__)

__all__ = ["local_mcp_tools"]


async def _checked_url(server: LocalMcpServer, policy: OutboundUrlPolicy) -> str | None:
    try:
        return await validate_mcp_url(server.url, policy)
    except McpUrlBlockedError as exc:
        logger.warning(
            "local_mcp.server_url_blocked", server_id=server.id, reason=exc.validation.code
        )
        return None


async def local_mcp_tools(
    ri: RunInput, opts: RunOptions, _ctx: HookContext, draft: ToolsetDraft
) -> None:
    """The run's local MCP servers' cached tools (see the module
    docstring)."""
    allowed = opts.allowed_mcp_server_ids
    servers = [
        s for s in opts.local_mcp_servers if s.tools and (allowed is None or s.id in allowed)
    ]
    if not servers:
        return
    policy = mcp_outbound_policy()
    urls = await asyncio.gather(*(_checked_url(s, policy) for s in servers))
    for server, url in zip(servers, urls, strict=True):
        if url is None:
            continue
        cred = ri.local_mcp_credentials.get(server.id)
        credentials = {"headers": dict(cred.headers)} if cred is not None and cred.headers else None
        endpoint = McpEndpoint(id=server.id, name=server.name, url=url)
        for t in server.tools:
            tool = build_mcp_tool(
                endpoint=endpoint,
                credentials=credentials,
                descriptor=McpToolDescriptor(
                    name=t.name,
                    description=t.description,
                    input_schema=t.input_schema,
                    ui_resource_uri=t.ui_resource_uri,
                ),
                policy=policy,
            )
            draft.tools[tool.name] = tool
            if server.requires_approval:
                draft.gated.add(tool.name)
