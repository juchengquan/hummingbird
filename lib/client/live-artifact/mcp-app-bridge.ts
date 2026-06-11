"use client"
import "client-only"

/**
 * MCP Apps tool-call bridge (phase 2). An MCP App panel rendered in the
 * sandboxed iframe can post a `tool-call` message up to the parent
 * (`McpAppFrame`), which forwards it to the producing MCP server via the
 * existing `/api/mcp/:id/call` proxy and posts the result back into the
 * panel. The iframe can't reach the network itself (CSP `connect-src
 * 'none'`); the parent does, with the user's credentials, **only to the
 * server that produced the app**. See `docs/PLAN-mcp-apps.md`.
 *
 * Pure parse/serialise helpers — no I/O, no React. Tested in isolation;
 * they're the validation boundary for untrusted iframe messages.
 */

/** postMessage namespace for the tool-call bridge — distinct from the
 *  `live-artifact` ns used for the ready/error bridge. */
export const MCP_APP_NS = "mcp-app"

export interface McpAppToolCall {
  /** Correlation id the panel chose; echoed on the response. */
  callId: string
  /** MCP tool name to invoke. */
  name: string
  /** Tool arguments (forwarded verbatim to the server). */
  args?: unknown
}

/**
 * Parse + validate an inbound message from an MCP App panel. Returns the
 * tool-call request, or `null` for anything that isn't a well-formed
 * `mcp-app` tool-call (foreign namespace, wrong type, missing fields) —
 * the caller ignores `null`.
 */
export function parseMcpAppToolCall(data: unknown): McpAppToolCall | null {
  if (!data || typeof data !== "object") return null
  const m = data as {
    ns?: unknown
    type?: unknown
    callId?: unknown
    name?: unknown
    args?: unknown
  }
  if (m.ns !== MCP_APP_NS) return null
  if (m.type !== "tool-call") return null
  if (typeof m.callId !== "string" || !m.callId) return null
  if (typeof m.name !== "string" || !m.name) return null
  return { callId: m.callId, name: m.name, args: m.args }
}

export interface McpAppToolResult {
  ns: typeof MCP_APP_NS
  type: "tool-result"
  callId: string
  ok: boolean
  result?: unknown
  error?: string
}

/** Build the response message posted back into the panel for `callId`. */
export function mcpAppToolResult(
  callId: string,
  payload: { ok: boolean; result?: unknown; error?: string }
): McpAppToolResult {
  return { ns: MCP_APP_NS, type: "tool-result", callId, ...payload }
}
