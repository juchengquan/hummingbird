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
 * Wire format for a local-mode credential the browser hands the backend
 * (base64 of the credential's JSON, sent as `credentialHeader`); never
 * persisted server-side.
 */
export function encodeCredentialHeader(cred: McpCredentials): string {
  const json = JSON.stringify(cred)
  if (typeof window === "undefined") {
    return Buffer.from(json, "utf8").toString("base64")
  }
  return window.btoa(unescape(encodeURIComponent(json)))
}
