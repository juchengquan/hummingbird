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
