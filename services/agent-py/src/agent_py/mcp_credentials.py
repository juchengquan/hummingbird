"""MCP credential encryption/decryption — Python port of
`lib/server/mcp/credentials.ts`.

Phase 3f of PLAN-agent-api. Both functions call SECURITY DEFINER
Postgres functions (defined in `0005_mcp.sql`) under per-user RLS
impersonation so the function's internal `auth.uid()` check sees the
right user. The encryption key lives in `MCP_ENCRYPTION_KEY` and is
passed as an RPC argument — never persisted to Postgres.

`fetch_decrypted_credentials` reads + decrypts an existing row;
`upsert_server_with_credentials` writes (insert or update) the
cloud-mode server row + ciphertext in one round-trip. The latter is
used by the `POST /v1/mcp/server` write endpoint (the read path was
implemented in Phase 3f, the write path closes the missing half of
the cloud-mode MCP management surface).

Both return values fall back to ``None`` / failure when:
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


class UpsertResult:
    """Discriminated return for `upsert_server_with_credentials`.
    `ok=True` on success; `error` carries a short reason on failure
    so the route can pick the right HTTP status (`encryption_key_unset`
    → 500, anything else → 502)."""

    __slots__ = ("error", "ok")

    def __init__(self, ok: bool, error: str | None = None) -> None:
        self.ok = ok
        self.error = error


async def upsert_server_with_credentials(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    server_id: str,
    workspace_id: str,
    name: str,
    url: str,
    credentials: dict[str, Any],
    capabilities: dict[str, Any] | None = None,
    enabled: bool = True,
    encryption_key: str | None = None,
) -> UpsertResult:
    """Insert or update a cloud-mode MCP server row + its encrypted
    credential ciphertext. Wraps the
    `mcp_upsert_server_with_credentials` SECURITY DEFINER RPC; the
    encryption key is passed as an RPC argument (never stored).

    Mirrors `upsertServerWithCredential` in
    `lib/server/mcp/credentials.ts` — same RPC, same parameter shape,
    same `encryption_key_unset` failure code. `encryption_key` is a
    test seam — production callers leave it None and the function
    reads it from settings.
    """
    key = encryption_key if encryption_key is not None else get_settings().MCP_ENCRYPTION_KEY
    key = (key or "").strip()
    if len(key) < 16:
        # Same guard as `fetch_decrypted_credentials`. Sub-16-char
        # keys produce cryptographically weak ciphertext; refuse
        # rather than half-protect.
        return UpsertResult(ok=False, error="encryption_key_unset")

    try:
        async with pool.acquire() as conn, conn.transaction():
            await store._set_user_context(conn, user_id=user_id)
            await conn.execute(
                "SELECT public.mcp_upsert_server_with_credentials("
                "$1::uuid, $2::uuid, $3::text, $4::text, "
                "$5::jsonb, $6::text, $7::jsonb, $8::boolean);",
                server_id,
                workspace_id,
                name,
                url,
                json.dumps(credentials),
                key,
                json.dumps(capabilities) if capabilities is not None else None,
                enabled,
            )
    except Exception as exc:
        logger.warning(
            "mcp_credentials.upsert_failed",
            server_id=server_id,
            error=str(exc),
        )
        return UpsertResult(ok=False, error=str(exc) or "upsert_failed")
    return UpsertResult(ok=True)


__all__ = [
    "UpsertResult",
    "fetch_decrypted_credentials",
    "upsert_server_with_credentials",
]
