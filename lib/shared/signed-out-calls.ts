/**
 * The agent-py endpoints a signed-out browser calls (wave 12, Q123/Q134 of
 * `docs/PLAN-frontend-backend-split.md`): URL fetch, summarize, extract,
 * extract-table, the MCP proxy and embed. agent-py serves them anonymously
 * (per-IP limits, `REQUIRE_AUTH_FOR_AI`); the contract marks them with an
 * anonymous security alternative (`packages/contract/openapi.yaml`).
 *
 * Everything else agent-py serves outside runs is account-bound (share,
 * schedules, memory extract, the stored-file links, `/v1/mcp/server`) and
 * is only ever sent with a session. `apiClient` derives a call's
 * "anonymous" dispatch from its path here, so the list lives in one place.
 */

const SIGNED_OUT_PATHS = new Set([
  "/v1/url/fetch",
  "/v1/summarize",
  "/v1/extract",
  "/v1/extract-table",
  "/v1/embed",
])

/** `/v1/mcp/{serverId}/{action}` — not `/v1/mcp/server` (cloud mode). */
const MCP_PROXY_PATH = /^\/v1\/mcp\/[^/]+\/(discover|call|read)$/

/** Whether agent-py serves `path` (a `/v1/...` path) to a signed-out caller. */
export function servedSignedOut(path: string): boolean {
  return SIGNED_OUT_PATHS.has(path) || MCP_PROXY_PATH.test(path)
}
