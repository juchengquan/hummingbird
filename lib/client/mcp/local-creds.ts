import "client-only"

import { encodeCredentialHeader, type McpCredentials } from "@/shared/mcp/credentials"

export type { McpCredentials } from "@/shared/mcp/credentials"

/**
 * Local credential store for MCP servers. The browser-only side of the
 * dual-mode credential plan (`docs/PLAN-mcp-integration.md`): when a
 * server is configured with `credentialMode === 'local'`, its cred
 * lives here in `localStorage` and is sent on each request via the
 * `X-MCP-Credentials` header to the `/api/mcp/*` proxy. Excluded from
 * the persist `partialize` allowlist — these never sync to Supabase.
 *
 * Shape stored under `STORAGE_KEY`:
 *   { [serverId: string]: McpCredentials }
 */

const STORAGE_KEY = "hummingbird-mcp-creds-v1"

function readAll(): Record<string, McpCredentials> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as Record<string, McpCredentials>
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, McpCredentials>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Quota / privacy mode — fail closed (no creds = proxy will reject).
  }
}

export function getLocalCred(serverId: string): McpCredentials | undefined {
  return readAll()[serverId]
}

export function setLocalCred(serverId: string, cred: McpCredentials): void {
  const all = readAll()
  all[serverId] = cred
  writeAll(all)
}

export function removeLocalCred(serverId: string): void {
  const all = readAll()
  if (!(serverId in all)) return
  delete all[serverId]
  writeAll(all)
}

/**
 * Stable fingerprint of a credential, suitable for storing on the
 * `McpServer.credentialFingerprint` field so two devices can tell
 * whether they share the same cred without actually sharing it.
 * SubtleCrypto-based — async by necessity.
 */
export async function credentialFingerprint(
  cred: McpCredentials
): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // No SubtleCrypto (very old browser) — fall back to a short prefix
    // of the stringified cred. Not cryptographically meaningful, but
    // good enough to detect "definitely the same vs probably different".
    return JSON.stringify(cred).slice(0, 16)
  }
  const canonical = JSON.stringify(cred, Object.keys(cred).sort())
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Re-export the shared encoder so client callers don't have to import
 * from two places.
 */
export { encodeCredentialHeader as serializeCredentialHeader }
