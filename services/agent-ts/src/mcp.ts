/**
 * MCP credential decryption — port of
 * `services/agent-py/src/agent_py/mcp_credentials.py` (which itself
 * mirrors `lib/server/mcp/credentials.ts`).
 *
 * Calls the `mcp_get_decrypted_credentials` SECURITY DEFINER Postgres
 * function (`0005_mcp.sql`) under per-user RLS impersonation so the
 * function's internal `auth.uid()` check sees the right user. The
 * encryption key lives in `MCP_ENCRYPTION_KEY` and is passed as an
 * RPC argument — never persisted.
 *
 * Returns ``null`` when:
 *   - `MCP_ENCRYPTION_KEY` is unset or under the 16-char threshold,
 *   - the row doesn't exist or doesn't belong to the caller (RLS
 *     hides it),
 *   - the row is a local-mode server (no ciphertext to decrypt),
 *   - decryption fails (key rotated since this row was written).
 *
 * The caller (the MCP proxy route) decides how to surface the
 * failure — typically just falls back to the header-supplied
 * credential or proceeds without one and lets the upstream MCP
 * server reject the call.
 */

import type { Sql } from "./db"
import { getEnv } from "./env"

const SET_ROLE_SQL = "SET LOCAL ROLE authenticated"
const SET_CLAIMS_SQL = "SELECT set_config('request.jwt.claims', $1, true)"
const DECRYPT_SQL = "SELECT public.mcp_get_decrypted_credentials($1::uuid, $2::text)"
const UPSERT_SQL =
  "SELECT public.mcp_upsert_server_with_credentials(" +
  "$1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb, $6::text, $7::jsonb, $8::boolean)"

export type McpCredentials = {
  type?: string
  headers?: Record<string, string>
} & Record<string, unknown>

export interface FetchDecryptedCredentialsArgs {
  userId: string
  serverId: string
  /** Test seam — production callers leave undefined and we read from env. */
  encryptionKey?: string
}

export async function fetchDecryptedCredentials(
  sql: Sql,
  { userId, serverId, encryptionKey }: FetchDecryptedCredentialsArgs,
): Promise<McpCredentials | null> {
  const key = (encryptionKey ?? getEnv().MCP_ENCRYPTION_KEY ?? "").trim()
  if (key.length < 16) {
    // Mirrors the TS / Python paths' guard. Sub-16-char keys produce
    // weak ciphertext; refuse rather than half-protect.
    return null
  }

  try {
    const raw = await sql.begin(async (tx) => {
      await tx.unsafe(SET_ROLE_SQL)
      await tx.unsafe(SET_CLAIMS_SQL, [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ])
      const rows = await tx.unsafe<{ mcp_get_decrypted_credentials: unknown }[]>(
        DECRYPT_SQL,
        [serverId, key],
      )
      return rows[0]?.mcp_get_decrypted_credentials ?? null
    })
    if (raw === null || raw === undefined) return null
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as unknown
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as McpCredentials)
          : null
      } catch {
        return null
      }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      return raw as McpCredentials
    }
    return null
  } catch {
    // Don't surface the underlying error — never include the key /
    // SQL / row id in caller-facing output.
    return null
  }
}

export interface UpsertServerArgs {
  userId: string
  serverId: string
  workspaceId: string
  name: string
  url: string
  credentials: McpCredentials
  capabilities?: Record<string, unknown> | null
  enabled?: boolean
  /** Test seam — production callers leave undefined. */
  encryptionKey?: string
}

export interface UpsertResult {
  ok: boolean
  /** Discriminant. `'encryption_key_unset'` → the route maps to 500
   *  (clear misconfig signal). Any other string → 502 (RPC failure
   *  — usually an RLS violation or constraint check). */
  error?: string
}

/** Insert or update a cloud-mode MCP server row + its encrypted
 *  credential ciphertext. Wraps the `mcp_upsert_server_with_credentials`
 *  SECURITY DEFINER RPC. The encryption key is passed as an RPC
 *  argument so it never lands in pg_catalog. Mirrors
 *  `upsertServerWithCredential` in `lib/server/mcp/credentials.ts`
 *  and `upsert_server_with_credentials` in
 *  `services/agent-py/src/agent_py/mcp_credentials.py`. */
export async function upsertServerWithCredentials(
  sql: Sql,
  args: UpsertServerArgs,
): Promise<UpsertResult> {
  const key = (args.encryptionKey ?? getEnv().MCP_ENCRYPTION_KEY ?? "").trim()
  if (key.length < 16) {
    // Same guard as `fetchDecryptedCredentials`. Sub-16-char keys
    // produce weak ciphertext; refuse rather than half-protect.
    return { ok: false, error: "encryption_key_unset" }
  }

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(SET_ROLE_SQL)
      await tx.unsafe(SET_CLAIMS_SQL, [
        JSON.stringify({ sub: args.userId, role: "authenticated" }),
      ])
      await tx.unsafe(UPSERT_SQL, [
        args.serverId,
        args.workspaceId,
        args.name,
        args.url,
        JSON.stringify(args.credentials),
        key,
        args.capabilities == null ? null : JSON.stringify(args.capabilities),
        args.enabled ?? true,
      ])
    })
    return { ok: true }
  } catch (err) {
    // Surface the error message for triage but never the key / row.
    // The transaction rolled back automatically — no partial write.
    return { ok: false, error: err instanceof Error ? err.message : "upsert_failed" }
  }
}
