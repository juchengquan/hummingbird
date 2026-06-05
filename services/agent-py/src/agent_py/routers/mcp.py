"""`/v1/mcp/{server_id}/{action}` — MCP-server proxy with cloud-mode
credential fallback. Mirrors `app/api/mcp/[serverId]/[action]/route.ts`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ..db import get_pool, has_pool
from ..mcp_client import McpEndpoint
from ..mcp_client import call_tool as mcp_call_tool
from ..mcp_client import discover as mcp_discover
from ..mcp_client import read_resource as mcp_read_resource
from ..mcp_credentials import (
    fetch_decrypted_credentials,
    upsert_server_with_credentials,
)

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["mcp"])


class McpServerBody(BaseModel):
    """Subset of `McpServer` the proxy actually needs. Mirrors the
    TS `ServerSchema` in the route. Transport is fixed at `http`
    matching the DB CHECK constraint."""

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    url: str = Field(min_length=1)
    transport: Literal["http"] = "http"


class McpProxyBody(BaseModel):
    """One body shape for all three actions. `tool` is required for
    `call`, `uri` for `read`; the route validates per-action."""

    server: McpServerBody
    tool: str | None = Field(default=None, min_length=1)
    input: dict[str, Any] | None = None
    uri: str | None = Field(default=None, min_length=1)


class McpServerCredential(BaseModel):
    """Plaintext credential the route encrypts before storing. Same
    open shape as `McpCredentials` on the TS side — typically
    `{type?, headers?}`. Empty dict means "no headers needed" (some
    public MCP servers don't require auth)."""

    model_config = {"extra": "allow"}

    type: str | None = Field(default=None, max_length=40)
    headers: dict[str, str] | None = None


class McpServerUpsertBody(BaseModel):
    """Wire shape for `POST /v1/mcp/server`. Mirrors the in-Next
    route's `BodySchema` byte-for-byte so the frontend's existing
    `apiClient.mcp.upsertCloudServer` can target either backend with
    no marshalling change."""

    id: str = Field(min_length=1, max_length=64)
    workspaceId: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    url: str = Field(min_length=1, max_length=2000)
    credentials: McpServerCredential
    capabilities: dict[str, Any] | None = None
    enabled: bool | None = True


def _decode_mcp_credential_header(raw: str | None) -> dict[str, Any] | None:
    """Decode the `X-MCP-Credentials` header. TS uses base64-encoded
    JSON; we accept the same shape so a frontend client can hit the
    Python proxy without changing its serialization. Returns None on
    any decode error — caller may fall through to cloud lookup."""
    if not raw:
        return None
    import base64
    import json

    try:
        decoded = base64.b64decode(raw, validate=True).decode("utf-8")
        parsed = json.loads(decoded)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


@router.post("/v1/mcp/server")
async def mcp_server_upsert(
    body: McpServerUpsertBody,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
) -> dict[str, bool]:
    """Create or update a cloud-mode MCP server config + its
    encrypted credential ciphertext. Mirrors
    `app/api/mcp/server/route.ts` byte-for-byte on the wire so the
    frontend's `apiClient.mcp.upsertCloudServer` can hit either
    backend.

    The browser can't call the encryption RPC directly (the
    `MCP_ENCRYPTION_KEY` lives only server-side); this endpoint is
    the only path that can write `credentials_encrypted`. Local-mode
    servers don't need this route — they go through the sync layer
    like any other slice.

    Returns 401 when no DB pool is configured (auth context cannot
    be established), 500 when `MCP_ENCRYPTION_KEY` is unset (clear
    misconfig signal so monitoring alerts), 502 on any other RPC
    failure."""
    if not has_pool():
        # Without a DB pool we can't impersonate the user for RLS,
        # so the upsert can't succeed even if the encryption key were
        # set. Surface as 503 (service misconfigured) rather than
        # 401 — the caller's token is fine; the deploy is incomplete.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "db_unconfigured",
                "message": "SUPABASE_DB_URL is not configured on the agent service.",
            },
        )

    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth", "message": "Token has no subject."},
        )

    # `model_dump(exclude_none=True)` drops the `type`/`headers` keys
    # the caller didn't supply, so the encrypted credential matches
    # what the in-Next route writes for the same input shape.
    credentials = body.credentials.model_dump(exclude_none=True)
    result = await upsert_server_with_credentials(
        get_pool(),
        user_id=user_id,
        server_id=body.id,
        workspace_id=body.workspaceId,
        name=body.name,
        url=body.url,
        credentials=credentials,
        capabilities=body.capabilities,
        enabled=body.enabled if body.enabled is not None else True,
    )
    if not result.ok:
        if result.error == "encryption_key_unset":
            # Server admin oversight — same status the TS route
            # picks for the same condition.
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail={
                    "code": "encryption_key_unset",
                    "message": "MCP_ENCRYPTION_KEY is not configured.",
                },
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "upsert_failed",
                "message": result.error or "RPC failed.",
            },
        )
    return {"ok": True}


@router.post("/v1/mcp/{server_id}/{action}")
async def mcp_proxy(
    server_id: str,
    action: str,
    body: McpProxyBody,
    claims: Annotated[dict[str, object], Depends(get_current_user)],
    x_mcp_credentials: Annotated[str | None, Header(alias="X-MCP-Credentials")] = None,
) -> dict[str, Any]:
    """MCP proxy — Phase 4-4b of PLAN-agent-api. Python mirror of
    `app/api/mcp/[serverId]/[action]/route.ts`.

    Actions:
      - `discover` → returns `{capabilities}` from the MCP
        handshake (tools / resources / prompts).
      - `call` → invokes a tool, returns `{result: {text,
        is_error}}`.
      - `read` → reads a resource by URI, returns `{result:
        {text?, mime_type?}}`.

    Credentials come from two places:
      1. `X-MCP-Credentials` header (local-mode — the client
         attaches the cred from localStorage). Decoded as
         base64-JSON, same shape the TS path expects.
      2. Cloud-mode fallback when no header — looks up the
         server row by id under per-user RLS impersonation,
         decrypts the credential via the SECURITY DEFINER RPC.

    If neither produces a credential and the upstream MCP server
    actually requires auth, the call fails upstream and the
    proxy surfaces it as 502 — same as TS."""
    if action not in ("discover", "call", "read"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    # Path / body server id mismatch protects against a buggy
    # client accidentally hitting the wrong server config.
    if body.server.id != server_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "serverId_mismatch", "message": "Path / body id mismatch."},
        )

    credentials = _decode_mcp_credential_header(x_mcp_credentials)
    # Cloud lookup only when the header didn't supply a cred AND
    # we can resolve a user id from the JWT.
    if credentials is None and has_pool():
        user_id = claims.get("sub")
        if isinstance(user_id, str) and user_id:
            credentials = await fetch_decrypted_credentials(
                get_pool(), user_id=user_id, server_id=server_id
            )

    endpoint = McpEndpoint(id=server_id, name=body.server.name, url=body.server.url)

    try:
        if action == "discover":
            caps = await mcp_discover(endpoint, credentials=credentials)
            return {
                "capabilities": {
                    "tools": (
                        [
                            {
                                "name": t.name,
                                "description": t.description,
                                "inputSchema": t.input_schema,
                            }
                            for t in caps.tools
                        ]
                        if caps.tools is not None
                        else None
                    ),
                    "resources": (
                        [
                            {
                                "uri": r.uri,
                                "name": r.name,
                                "description": r.description,
                                "mimeType": r.mime_type,
                            }
                            for r in caps.resources
                        ]
                        if caps.resources is not None
                        else None
                    ),
                    "prompts": (
                        [{"name": p.name, "description": p.description} for p in caps.prompts]
                        if caps.prompts is not None
                        else None
                    ),
                }
            }
        if action == "call":
            if not body.tool:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail={"code": "invalid_body", "message": "`tool` required."},
                )
            tool_result = await mcp_call_tool(endpoint, credentials, body.tool, body.input or {})
            return {
                "result": {
                    "text": tool_result.text,
                    "isError": tool_result.is_error,
                }
            }
        # action == "read"
        if not body.uri:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "invalid_body", "message": "`uri` required."},
            )
        res = await mcp_read_resource(endpoint, credentials, body.uri)
        return {
            "result": {"text": res.text, "mimeType": res.mime_type},
        }
    except HTTPException:
        raise
    except Exception as exc:
        # Never include credentials in error responses.
        logger.warning(
            "mcp.proxy_failed",
            server=server_id,
            action=action,
            error=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "mcp_call_failed", "message": str(exc)},
        ) from exc
