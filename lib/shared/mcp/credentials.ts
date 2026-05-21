/**
 * Shape of an MCP server credential, decoded from either:
 *   - `localStorage` (browser, `credentialMode === 'local'`), or
 *   - the `X-MCP-Credentials` request header (server proxy
 *     forwarding a local-mode call), or
 *   - the encrypted column on `mcp_servers` (server proxy
 *     forwarding a cloud-mode call — Stage 3).
 *
 * Open record by design: each MCP server can describe its own auth
 * shape without locking the type to one schema. The server proxy
 * passes `headers` through verbatim.
 */
export interface McpCredentials {
  /** UI label only ("bearer", "basic", "none", "custom"). Semantics
   *  live in `headers`. */
  type?: string
  /** Headers to attach to every proxied MCP request. Keep keys
   *  lowercase by convention. */
  headers?: Record<string, string>
}

/**
 * Wire format used between the browser and `/api/mcp/*` for local-
 * mode credentials. Decoded on the server with `decodeCredentialHeader`
 * below; never persisted server-side.
 */
export const MCP_CRED_HEADER = "x-mcp-credentials"

export function encodeCredentialHeader(cred: McpCredentials): string {
  const json = JSON.stringify(cred)
  if (typeof window === "undefined") {
    return Buffer.from(json, "utf8").toString("base64")
  }
  return window.btoa(unescape(encodeURIComponent(json)))
}

export function decodeCredentialHeader(value: string | null): McpCredentials | null {
  if (!value) return null
  try {
    const json =
      typeof window === "undefined"
        ? Buffer.from(value, "base64").toString("utf8")
        : decodeURIComponent(escape(window.atob(value)))
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== "object") return null
    return parsed as McpCredentials
  } catch {
    return null
  }
}
