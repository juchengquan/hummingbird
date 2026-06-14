import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/shared/supabase/types"
import type { McpCredentials } from "@/shared/mcp/credentials"

/**
 * Server-side credential helpers for cloud-mode MCP servers. The
 * encryption key lives in `MCP_ENCRYPTION_KEY` — never persisted,
 * never logged, never round-trips the client. See
 * `docs/PLAN-mcp-stage-3.md` for the trade-off note on
 * function-argument vs session-setting key passing.
 *
 * All decrypt / encrypt happens via SECURITY DEFINER SQL functions
 * defined in `0005_mcp.sql`. The functions perform their own
 * `auth.uid()` check, so even though they run with elevated
 * privilege they refuse to decrypt rows the caller doesn't own.
 */

export function getMcpEncryptionKey(): string | null {
  const key = process.env.MCP_ENCRYPTION_KEY
  if (!key || key.length < 16) return null
  return key
}

/**
 * Fetch + decrypt the credential for a cloud-mode MCP server. Returns
 * `null` when:
 *   - the encryption key isn't configured (server admin oversight)
 *   - the row doesn't exist or doesn't belong to the caller
 *   - the row is a local-mode server (no ciphertext)
 *   - decryption fails (key rotated since this row was written)
 *
 * Caller decides how to surface the failure — the proxy returns 401
 * or 502 depending on context; the chat route silently skips the
 * server so other capabilities still work.
 */
export async function fetchDecryptedCredential(
  client: SupabaseClient<Database>,
  serverId: string
): Promise<McpCredentials | null> {
  const key = getMcpEncryptionKey()
  if (!key) return null
  const { data, error } = await client.rpc("mcp_get_decrypted_credentials", {
    p_server_id: serverId,
    p_key: key,
  })
  if (error) {
    // Decryption errors look identical to "row not found" from the
    // client's perspective — both return null with no row. Log to
    // server stderr without including the key.
    console.warn("[mcp] decrypt failed", {
      serverId,
      code: error.code,
      message: error.message,
    })
    return null
  }
  if (!data || typeof data !== "object") return null
  return data as McpCredentials
}

/**
 * Write a cloud-mode server config + encrypted credential in one
 * round-trip. Used by the sync layer when promoting a local cred to
 * cloud, and by an Add-server flow that wants to land directly in
 * cloud mode.
 *
 * Returns `false` when the encryption key isn't configured.
 */
export async function upsertServerWithCredential(
  client: SupabaseClient<Database>,
  params: {
    id: string
    workspaceId: string
    name: string
    url: string
    credentials: McpCredentials
    capabilities?: Database["public"]["Tables"]["mcp_servers"]["Row"]["capabilities"]
    enabled?: boolean
    requiresApproval?: boolean
  }
): Promise<{ ok: boolean; error?: string }> {
  const key = getMcpEncryptionKey()
  if (!key) {
    return { ok: false, error: "encryption_key_unset" }
  }
  // McpCredentials is an open record (no index signature) but at
  // runtime it's plain JSON. Supabase serializes it identically.
  const { error } = await client.rpc("mcp_upsert_server_with_credentials", {
    p_id: params.id,
    p_workspace_id: params.workspaceId,
    p_name: params.name,
    p_url: params.url,
    p_credentials: params.credentials as unknown as Json,
    p_key: key,
    p_capabilities: params.capabilities ?? null,
    p_enabled: params.enabled ?? true,
    p_requires_approval: params.requiresApproval ?? false,
  })
  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true }
}
