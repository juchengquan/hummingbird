import "client-only"

import { canonicalJson } from "@/shared/canonical-json"
import { encodeCredentialHeader, type McpCredentials } from "@/shared/mcp/credentials"
import type { McpServer } from "@/shared/types"

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
 * SHA-256 (truncated to 64 bits) over the canonical JSON — keys sorted
 * at every depth, so `headers` contributes to the hash. SubtleCrypto-
 * based — async by necessity.
 */
export async function credentialFingerprint(
  cred: McpCredentials
): Promise<string> {
  const canonical = canonicalJson(cred)
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // No SubtleCrypto (insecure context / very old browser): a non-
    // cryptographic hash of the full canonical form. Still tells
    // different creds apart; never echoes any part of the secret.
    return `fnv1a-${fnv1a32(canonical)}`
  }
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function fnv1a32(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Self-heal for fingerprints written before the canonical-JSON fix:
 * the old code's key whitelist serialised `headers` as `{}`, so every
 * bearer credential got the same fingerprint. Nothing compares
 * fingerprints yet (they are written + synced only), but a future
 * reader must not trust those collisions. For each live local-mode
 * server whose credential is on THIS device, recompute and return the
 * ones that differ from what is stored; servers whose cred lives on
 * another device are left for that device to heal. The caller writes
 * results back via `updateMcpServer`, which syncs like any other edit.
 */
export async function staleCredentialFingerprints(
  servers: ReadonlyArray<
    Pick<McpServer, "id" | "credentialMode" | "credentialFingerprint" | "deletedAt">
  >,
  getCred: (serverId: string) => McpCredentials | undefined = getLocalCred
): Promise<Array<{ id: string; fingerprint: string }>> {
  const out: Array<{ id: string; fingerprint: string }> = []
  for (const s of servers) {
    if (s.deletedAt || s.credentialMode !== "local") continue
    const cred = getCred(s.id)
    if (!cred) continue
    const fingerprint = await credentialFingerprint(cred)
    if (fingerprint !== s.credentialFingerprint) {
      out.push({ id: s.id, fingerprint })
    }
  }
  return out
}

/**
 * Re-export the shared encoder so client callers don't have to import
 * from two places.
 */
export { encodeCredentialHeader as serializeCredentialHeader }
