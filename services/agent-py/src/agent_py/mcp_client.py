"""MCP client wrapper — Python port of `lib/server/mcp/client.ts`.

Phase 3f of PLAN-agent-api. Thin wrapper around the official `mcp`
Python SDK (`pip install mcp`) exposing the three operations
Hummingbird uses: `discover` (capability handshake → list tools /
resources / prompts), `call_tool` (forward args to the remote server,
flatten text content), and `read_resource` (URI → text + mime).

Streamable-HTTP transport only — stdio support is deferred (mirrors
the TS path; same rationale in `docs/PLAN-mcp-integration.md`).

Each call opens a fresh session (connect → operation → close), same
pattern as TS. Cheap enough for v1; pool-per-(serverId, fingerprint)
if call volume grows.

The wrapper is intentionally narrow: it doesn't know about asyncpg,
RLS, settings, or the agent loop. The caller threads the credentials
in (typically resolved by `mcp_credentials.fetch_decrypted_credentials`)
and gets back a structured result. Phase 3f-2 wires the wrapper into
the agent's tool registry.
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
import structlog

from .outbound_http import build_guarded_client
from .url_validate import (
    OutboundUrlPolicy,
    ValidationError,
    ValidationOk,
    validate_outbound_url,
)

logger = structlog.get_logger(__name__)


class McpUrlBlockedError(Exception):
    """The MCP endpoint URL failed the SSRF gate (`validate_outbound_url`).

    Raised before any network I/O. `validation` carries the structured
    reason for logs; callers must not echo `validation.message` to an
    untrusted caller (it can describe internal DNS)."""

    code = "mcp_url_blocked"

    def __init__(self, validation: ValidationError) -> None:
        super().__init__(f"MCP server URL blocked: {validation.code}")
        self.validation = validation


def mcp_outbound_policy() -> OutboundUrlPolicy:
    """The SSRF policy for MCP endpoints (`mcpOutboundPolicy` in
    `lib/server/mcp/outbound.ts`): private hosts only when the operator
    set `MCP_ALLOW_PRIVATE_HOSTS=true`; link-local / metadata addresses
    never (`url_validate.OutboundUrlPolicy`). Read per call, so a test
    that swaps the settings sees it."""
    from .settings import get_settings

    return OutboundUrlPolicy(allow_private_hosts=get_settings().MCP_ALLOW_PRIVATE_HOSTS)


async def validate_mcp_url(url: str, policy: OutboundUrlPolicy | None = None) -> str:
    """Return the validated URL, or raise `McpUrlBlockedError`.

    Every MCP URL is untrusted — a request body (local mode), a
    `mcp_servers` row (cloud mode: user-editable under RLS) or an
    upsert — so it is checked at every use, not only at save time.
    `policy` defaults to `mcp_outbound_policy()`."""
    validation = await validate_outbound_url(
        url, policy if policy is not None else mcp_outbound_policy()
    )
    if not isinstance(validation, ValidationOk):
        raise McpUrlBlockedError(validation)
    return validation.url


def mcp_http_client_factory(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """`McpHttpClientFactory` for the MCP SDK's streamable-HTTP transport.

    The SDK's default (`create_mcp_http_client`) follows redirects and
    honours proxy env vars, and nothing checks the address it dials. This
    one routes every request through `outbound_http`'s guarded transport:
    connect-time IP pinning to a validated public address, no redirects,
    `trust_env=False`."""
    return build_guarded_client(headers=headers, timeout=timeout, auth=auth)


def _private_hosts_http_client_factory(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """`mcp_http_client_factory` under `MCP_ALLOW_PRIVATE_HOSTS`: the
    connect-time check admits private addresses, never link-local /
    metadata ones."""
    return build_guarded_client(
        headers=headers,
        timeout=timeout,
        auth=auth,
        policy=OutboundUrlPolicy(allow_private_hosts=True),
    )


def mcp_http_client_factory_for(policy: OutboundUrlPolicy) -> Any:
    """The SDK client factory whose connect-time check applies `policy`
    — the same one the URL was validated with."""
    if policy.allow_private_hosts:
        return _private_hosts_http_client_factory
    return mcp_http_client_factory


@dataclass(frozen=True)
class McpEndpoint:
    """The subset of `McpServer` (TS shape) that the wrapper actually
    uses. Decouples callers from the full DB-row shape — they pass
    whatever runtime descriptor they have."""

    id: str
    name: str
    url: str


@dataclass(frozen=True)
class McpToolDescriptor:
    """Mirrors `McpToolDescriptor` in `lib/shared/types.ts`."""

    name: str
    description: str | None = None
    input_schema: dict[str, Any] | None = None
    ui_resource_uri: str | None = None
    """MCP Apps (ext-apps): the `ui://` resource the tool renders a panel
    from — the tool's `_meta.ui.resourceUri` at discovery, cached as
    `uiResourceUri`. None for ordinary tools."""


@dataclass(frozen=True)
class McpResourceDescriptor:
    """Mirrors `McpResourceDescriptor` in `lib/shared/types.ts`."""

    uri: str
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None


@dataclass(frozen=True)
class McpPromptDescriptor:
    """Subset of the SDK's prompt shape — name + description are all
    we surface today."""

    name: str
    description: str | None = None


@dataclass(frozen=True)
class McpCapabilities:
    """Discovery result. Each field is ``None`` when the server
    didn't advertise that capability — empty list means the server
    advertised it but returned no entries."""

    tools: list[McpToolDescriptor] | None = None
    resources: list[McpResourceDescriptor] | None = None
    prompts: list[McpPromptDescriptor] | None = None


@dataclass(frozen=True)
class McpToolResult:
    """Result of `call_tool` — text is the concatenated text content
    of the MCP `content` array; `is_error` mirrors the SDK's flag."""

    text: str
    is_error: bool = False


@dataclass(frozen=True)
class McpResourceContent:
    """Result of `read_resource` — first content item, with `text` set
    when the resource is text-shaped and `mime_type` for the UI to
    decide rendering."""

    text: str | None = None
    mime_type: str | None = None


# --- Session lifecycle ----------------------------------------------------


@asynccontextmanager
async def _open_session(
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None,
    policy: OutboundUrlPolicy | None = None,
) -> Any:
    """Open a fresh MCP session over streamable-HTTP and yield the
    initialized `ClientSession`. The function is split out as a
    separate context manager so tests can patch it with a fake that
    yields a stub session, side-stepping the SDK's network layer
    entirely.

    The URL is re-validated here (SSRF gate) and the SDK's HTTP client
    is the guarded one (`mcp_http_client_factory`), whichever caller —
    proxy, the task executor, a run — opened the session,
    both under `policy` (default `mcp_outbound_policy()`).

    Headers from `credentials["headers"]` are forwarded to the upstream
    MCP server after `_headers_from` drops hop-by-hop / framing / proxy
    headers — Authorization, X-API-Key, etc. pass. The MCP SDK handles
    the streaming-HTTP transport handshake.
    """
    # Lazy imports keep the heavy MCP SDK out of the import graph for
    # callers that only need the dataclasses.
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    effective = policy if policy is not None else mcp_outbound_policy()
    url = await validate_mcp_url(endpoint.url, effective)
    headers = _headers_from(credentials)
    async with (
        streamablehttp_client(
            url,
            headers=headers,
            httpx_client_factory=mcp_http_client_factory_for(effective),
        ) as (read, write, _),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        yield session


# Header names a credential may not set — mirrors
# `DENIED_CREDENTIAL_HEADERS` in `lib/server/mcp/outbound.ts`: hop-by-hop /
# framing headers (request smuggling), `Host` (virtual-host routing to an
# unintended backend), proxy + forwarding headers, and the headers the
# MCP transport owns itself.
_DENIED_CREDENTIAL_HEADERS = frozenset(
    {
        "host",
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "content-length",
        "expect",
        "proxy-authorization",
        "proxy-authenticate",
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-port",
        "x-real-ip",
        "content-type",
        "accept",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
    }
)
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_BAD_HEADER_VALUE_RE = re.compile(r"[\r\n\0]")
_MAX_HEADERS = 32
_MAX_HEADER_NAME = 256
_MAX_HEADER_VALUE = 8192


def _headers_from(credentials: dict[str, Any] | None) -> dict[str, str] | None:
    """Credential headers safe to put on the outbound request. Drops
    (rather than rejects) bad entries, like the TS
    `sanitizeCredentialHeaders`. Never logs values."""
    if not credentials:
        return None
    raw = credentials.get("headers")
    if not isinstance(raw, dict):
        return None
    out: dict[str, str] = {}
    for k, v in raw.items():
        if len(out) >= _MAX_HEADERS:
            break
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        if not k or len(k) > _MAX_HEADER_NAME or not _HEADER_NAME_RE.match(k):
            continue
        lower = k.lower()
        if lower in _DENIED_CREDENTIAL_HEADERS:
            continue
        if lower.startswith(("proxy-", "sec-")):
            continue
        if len(v) > _MAX_HEADER_VALUE or _BAD_HEADER_VALUE_RE.search(v):
            continue
        out[k] = v
    return out or None


# --- Operations -----------------------------------------------------------


async def discover(
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None = None,
    *,
    policy: OutboundUrlPolicy | None = None,
) -> McpCapabilities:
    """Run the MCP capability handshake and list every capability the
    server advertises. Mirrors `discover()` in `client.ts`.

    Tool / resource list calls are gated on the server's reported
    capabilities — calling `list_tools()` on a server that advertised
    no `tools` capability would error on most implementations. Prompts
    are best-effort because some early servers advertise the capability
    but error on `prompts/list`.
    """
    async with _open_session(endpoint, credentials, policy) as session:
        caps = _server_capabilities(session)

        tools: list[McpToolDescriptor] | None = None
        resources: list[McpResourceDescriptor] | None = None
        prompts: list[McpPromptDescriptor] | None = None

        # Capability gates: presence-not-truthiness. The MCP SDK often
        # reports a supported capability as an empty dict ({} carrying
        # no sub-features), so a `caps.get("tools")` truthy check would
        # miss those. Mirrors how the TS path's `serverCaps.tools` would
        # fire on `{}` since {} is truthy in JS.
        if "tools" in caps:
            res = await session.list_tools()
            tools = [
                McpToolDescriptor(
                    name=t.name,
                    description=getattr(t, "description", None),
                    input_schema=getattr(t, "inputSchema", None),
                    ui_resource_uri=_ui_resource_uri(t),
                )
                for t in res.tools
            ]
        if "resources" in caps:
            res = await session.list_resources()
            resources = [
                McpResourceDescriptor(
                    uri=str(r.uri),
                    name=getattr(r, "name", None),
                    description=getattr(r, "description", None),
                    mime_type=getattr(r, "mimeType", None),
                )
                for r in res.resources
            ]
        if "prompts" in caps:
            try:
                res = await session.list_prompts()
                prompts = [
                    McpPromptDescriptor(
                        name=p.name,
                        description=getattr(p, "description", None),
                    )
                    for p in res.prompts
                ]
            except Exception as exc:
                # Mirrors the TS path: tolerate servers that advertise
                # prompts in capabilities but error on listPrompts.
                logger.info(
                    "mcp_client.list_prompts_failed",
                    server=endpoint.id,
                    error=str(exc),
                )
                prompts = None

        return McpCapabilities(tools=tools, resources=resources, prompts=prompts)


async def call_tool(
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None,
    tool_name: str,
    arguments: dict[str, Any] | None,
    *,
    policy: OutboundUrlPolicy | None = None,
) -> McpToolResult:
    """Invoke a tool on the MCP server. Concatenates text + embedded-
    resource text parts of the SDK's `content` response. Mirrors
    `callTool()` in `client.ts` — including the `isError` flag pass-
    through so the caller can decide whether to surface the error or
    retry."""
    async with _open_session(endpoint, credentials, policy) as session:
        result = await session.call_tool(tool_name, arguments or {})

        parts: list[str] = []
        content = getattr(result, "content", None) or []
        for part in content:
            ptype = getattr(part, "type", None)
            if ptype == "text":
                text = getattr(part, "text", None)
                if isinstance(text, str):
                    parts.append(text)
            elif ptype == "resource":
                resource = getattr(part, "resource", None)
                if resource is not None:
                    text = getattr(resource, "text", None)
                    if isinstance(text, str):
                        parts.append(text)

        is_error = bool(getattr(result, "isError", False))
        return McpToolResult(text="\n\n".join(parts), is_error=is_error)


async def read_resource(
    endpoint: McpEndpoint,
    credentials: dict[str, Any] | None,
    uri: str,
    *,
    policy: OutboundUrlPolicy | None = None,
) -> McpResourceContent:
    """Read a resource by URI. Returns the first content item's text +
    mime_type, mirroring `readResource()` in `client.ts`. Binary
    resources lose `text` and the caller has to fall back to fetching
    the bytes some other way (not currently exercised)."""
    async with _open_session(endpoint, credentials, policy) as session:
        result = await session.read_resource(uri)
        contents = getattr(result, "contents", None) or []
        first = contents[0] if contents else None
        if first is None:
            return McpResourceContent()
        return McpResourceContent(
            text=getattr(first, "text", None),
            mime_type=getattr(first, "mimeType", None),
        )


# --- internal helpers -----------------------------------------------------


def _ui_resource_uri(tool: Any) -> str | None:
    """`_meta.ui.resourceUri` of a listed tool (MCP Apps), read
    defensively like the TS `discover` — the extension is optional."""
    meta = getattr(tool, "meta", None)
    if meta is None:
        meta = getattr(tool, "_meta", None)
    ui = meta.get("ui") if isinstance(meta, dict) else None
    uri = ui.get("resourceUri") if isinstance(ui, dict) else None
    return uri if isinstance(uri, str) and uri else None


def _server_capabilities(session: Any) -> dict[str, Any]:
    """Coerce `session.get_server_capabilities()` into a plain dict so
    downstream code can do `caps.get("tools")` without caring whether
    the SDK gave us a pydantic model or a dict. Empty dict on None."""
    raw = session.get_server_capabilities() if hasattr(session, "get_server_capabilities") else None
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    # Pydantic v2 models expose `model_dump`; older versions expose
    # `dict()`. Try both.
    if hasattr(raw, "model_dump"):
        try:
            dumped = raw.model_dump(exclude_none=True)
            return dumped if isinstance(dumped, dict) else {}
        except Exception:
            return {}
    if hasattr(raw, "dict"):
        try:
            dumped = raw.dict(exclude_none=True)
            return dumped if isinstance(dumped, dict) else {}
        except Exception:
            return {}
    return {}


__all__ = [
    "McpCapabilities",
    "McpEndpoint",
    "McpPromptDescriptor",
    "McpResourceContent",
    "McpResourceDescriptor",
    "McpToolDescriptor",
    "McpToolResult",
    "McpUrlBlockedError",
    "call_tool",
    "discover",
    "mcp_http_client_factory",
    "mcp_http_client_factory_for",
    "mcp_outbound_policy",
    "read_resource",
    "validate_mcp_url",
]

# Test seam — overridden by `unittest.mock.patch` in tests so we don't
# need a live MCP server. Mirrors the TS path's session-injection
# helpers.
_open_session_for_tests = _open_session
