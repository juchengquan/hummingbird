"""MCP credential decryption — Python port of `lib/server/mcp/credentials.ts`.

Phase 3f of PLAN-agent-api. Calls the `mcp_get_decrypted_credentials`
SECURITY DEFINER Postgres function (defined in `0005_mcp.sql`) under
per-user RLS impersonation so the function's internal `auth.uid()`
check sees the right user. The encryption key lives in
`MCP_ENCRYPTION_KEY` and is passed as an RPC argument — never
persisted to Postgres.

The RPC returns `jsonb`; we decode to a plain dict shaped like
`McpCredentials` on the TS side — typically `{headers: {"X-API-Key":
"..."}}` — and hand it to `mcp_client.discover` / `mcp_client.call_tool`
which forwards the headers to the upstream MCP server.

Returns ``None`` when:
  - `MCP_ENCRYPTION_KEY` is unset (server admin oversight),
  - the row doesn't exist or doesn't belong to the caller (RLS
    hides it),
  - the row is a local-mode server (no ciphertext to decrypt),
  - decryption fails (key rotated since this row was written).

The caller decides how to surface the failure — the chat route
skips that server but lets other capabilities still work.
"""

from __future__ import annotations

import json
from typing import Any

import asyncpg
import structlog

from . import store
from .settings import get_settings

logger = structlog.get_logger(__name__)


async def fetch_decrypted_credentials(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    server_id: str,
    encryption_key: str | None = None,
) -> dict[str, Any] | None:
    """Fetch + decrypt the credential for a cloud-mode MCP server.

    `encryption_key` is a test seam — production callers leave it None
    and the function reads it from settings. Tests pass a fixed key to
    avoid having to set env vars.
    """
    key = encryption_key if encryption_key is not None else get_settings().MCP_ENCRYPTION_KEY
    key = (key or "").strip()
    if len(key) < 16:
        # Mirrors the TS path's guard. Sub-16-char keys produce
        # cryptographically weak ciphertext; refuse rather than half-
        # protect.
        return None

    try:
        async with pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=user_id)
            row = await conn.fetchval(
                "SELECT public.mcp_get_decrypted_credentials($1::uuid, $2::text);",
                server_id,
                key,
            )
    except Exception as exc:
        logger.warning(
            "mcp_credentials.decrypt_failed",
            server_id=server_id,
            error=str(exc),
        )
        return None

    if row is None:
        return None
    # asyncpg returns jsonb as str unless a codec is registered. Decode
    # lazily so callers always see a dict.
    if isinstance(row, str):
        try:
            decoded = json.loads(row)
        except Exception:
            return None
        return decoded if isinstance(decoded, dict) else None
    if isinstance(row, dict):
        return row
    return None


__all__ = ["fetch_decrypted_credentials"]
