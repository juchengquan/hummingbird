import "server-only"

import { getSupabaseServerClient } from "@/server/supabase/server"
import { fetchDecryptedCredential } from "@/server/mcp/credentials"
import type { McpCredentials } from "@/shared/mcp/credentials"
import type { McpCapabilities, McpTransport } from "@/shared/types"

/**
 * The MCP server shape the chat route + tool builders need at runtime.
 * `credentials` is the decrypted cred ready to forward; `capabilities`
 * holds the cached `tools/resources/prompts` summary.
 */
export interface EffectiveMcpServer {
  id: string
  name: string
  url: string
  transport: McpTransport
  capabilities?: McpCapabilities
  credentials?: McpCredentials
}

/** Wire shape coming from the chat-route request body. Mirrors the
 *  Zod schema in `lib/shared/api-schemas.ts`. */
export interface RequestMcpServer {
  id: string
  name: string
  url: string
  transport: McpTransport
  enabled?: boolean
  capabilities?: McpCapabilities
  credentials?: McpCredentials
}

/**
 * Merge the local-mode servers the client sent in the body with the
 * cloud-mode servers stored in Supabase. Cloud-mode rows are filtered
 * by the active workspace + `enabled = true` + non-tombstoned, and
 * their credentials are decrypted server-side. Failures (no session,
 * missing key, RLS reject, decrypt error) drop the server silently
 * from the merged list — the chat still proceeds with whatever
 * capabilities remain.
 *
 * When `workspaceId` is empty, only local servers come back (no
 * filter to constrain the cloud query).
 *
 * An optional `allowedServerIds` array (Phase 2 of
 * `PLAN-custom-agents.md`) acts as a per-turn allow-list — when
 * provided, every returned server's id must appear in the set. Empty
 * array means "no MCP for this turn" (a persona's explicit shut-off).
 * `undefined` / omission means "no restriction" (default behaviour).
 */
export async function loadEffectiveMcpServers(
  workspaceId: string | undefined,
  bodyServers: RequestMcpServer[] | undefined,
  opts?: { allowedServerIds?: readonly string[] | null }
): Promise<EffectiveMcpServer[]> {
  const allow =
    opts?.allowedServerIds === undefined || opts?.allowedServerIds === null
      ? null
      : new Set(opts.allowedServerIds)
  const out: EffectiveMcpServer[] = []

  // Local-mode: pass through as-is, dropping disabled rows.
  for (const s of bodyServers ?? []) {
    if (s.enabled === false) continue
    if (allow && !allow.has(s.id)) continue
    out.push({
      id: s.id,
      name: s.name,
      url: s.url,
      transport: s.transport,
      capabilities: s.capabilities,
      credentials: s.credentials,
    })
  }

  if (!workspaceId) return out

  // Cloud-mode: requires a session. No session → user is signed out,
  // no cloud servers visible (RLS would block anyway).
  const client = await getSupabaseServerClient()
  if (!client) return out

  const { data: rows, error } = await client
    .from("mcp_servers")
    .select(
      "id, name, url, transport, capabilities, credential_mode, enabled, deleted_at"
    )
    .eq("workspace_id", workspaceId)
    .eq("credential_mode", "cloud")
    .eq("enabled", true)
    .is("deleted_at", null)

  if (error || !rows) return out

  // Decrypt each cred in parallel. We intentionally don't surface
  // individual decrypt failures to the caller — they look identical
  // to "row deleted between query and rpc" from the client side, and
  // both should silently drop the server.
  const decrypted = await Promise.all(
    rows.map(async (row) => {
      const cred = await fetchDecryptedCredential(client, row.id)
      if (!cred) return null
      // Tools-only servers can still discover resources lazily; we
      // ship whatever capabilities the row has cached. Schema is JSON,
      // cast back to the shared type.
      const capabilities =
        row.capabilities && typeof row.capabilities === "object"
          ? (row.capabilities as McpCapabilities)
          : undefined
      const server: EffectiveMcpServer = {
        id: row.id,
        name: row.name,
        url: row.url,
        // Codegen widens text columns with CHECK constraints to
        // `string`; the constraint `transport in ('http')` still
        // enforces this at runtime. Cast to satisfy the narrow
        // domain type.
        transport: row.transport as EffectiveMcpServer['transport'],
        capabilities,
        credentials: cred,
      }
      return server
    })
  )
  for (const server of decrypted) {
    if (!server) continue
    if (allow && !allow.has(server.id)) continue
    out.push(server)
  }

  return out
}
