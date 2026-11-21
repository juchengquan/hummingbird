// VENDORED from `lib/server/mcp/outbound.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

import "server-only"

import {
  validateOutboundUrl,
  type OutboundUrlPolicy,
  type ValidationError,
} from "../url/validate"

/**
 * Anti-SSRF policy for MCP server endpoints. Every MCP URL — whether it
 * came from a request body (local mode), a Supabase row (cloud mode,
 * user-editable), or a save request — is untrusted and must clear
 * `validateMcpServerUrl` before the server talks to it.
 *
 * Private hosts (localhost, RFC 1918, `.local`, …) are refused unless
 * the operator sets `MCP_ALLOW_PRIVATE_HOSTS=true` — intended for
 * single-user local dev where the MCP server runs on the same machine.
 * Link-local / cloud-metadata addresses stay blocked even then (see
 * `OutboundUrlPolicy`). Read per call so tests and hot reloads see
 * the current env.
 */
export function mcpOutboundPolicy(): OutboundUrlPolicy {
  return { allowPrivateHosts: process.env.MCP_ALLOW_PRIVATE_HOSTS === "true" }
}

export async function validateMcpServerUrl(
  url: string
): Promise<{ ok: true; url: URL } | { ok: false; error: ValidationError }> {
  return validateOutboundUrl(url, mcpOutboundPolicy())
}

/** Thrown by the MCP client wrapper when the endpoint URL is refused. */
export class McpUrlBlockedError extends Error {
  readonly code = "mcp_url_blocked"
  constructor(readonly validation: ValidationError) {
    super(`MCP server URL blocked: ${validation.message}`)
    this.name = "McpUrlBlockedError"
  }
}

/**
 * Header names a credential may not set. Hop-by-hop / framing headers
 * (request smuggling, connection hijack), `Host` (virtual-host routing
 * to an unintended backend), proxy + forwarding headers (spoofing the
 * client identity to upstream ACLs), and the headers the MCP transport
 * owns itself.
 */
const DENIED_CREDENTIAL_HEADERS = new Set([
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
])

/** RFC 9110 `token` — rejects spaces, colons, CR/LF and other separators. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const BAD_HEADER_VALUE_RE = /[\r\n\0]/
const MAX_HEADERS = 32
const MAX_HEADER_NAME = 256
const MAX_HEADER_VALUE = 8192

/**
 * Filter caller-supplied credential headers down to ones safe to put on
 * the outbound MCP request. Drops (rather than rejects) bad entries so
 * a stale saved credential degrades to "auth fails upstream" instead of
 * a hard error. Never logs values.
 */
export function sanitizeCredentialHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== "object") return out
  let count = 0
  for (const [name, value] of Object.entries(headers)) {
    if (count >= MAX_HEADERS) break
    if (typeof value !== "string") continue
    if (name.length === 0 || name.length > MAX_HEADER_NAME) continue
    if (!HEADER_NAME_RE.test(name)) continue
    const lower = name.toLowerCase()
    if (DENIED_CREDENTIAL_HEADERS.has(lower)) continue
    if (lower.startsWith("proxy-") || lower.startsWith("sec-")) continue
    if (value.length > MAX_HEADER_VALUE || BAD_HEADER_VALUE_RE.test(value)) continue
    out[name] = value
    count++
  }
  return out
}
