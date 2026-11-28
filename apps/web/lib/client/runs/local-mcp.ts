import "client-only"

/**
 * The local MCP servers of a chat turn on runs (Q42, Q45): the
 * `forwardedProps.localMcpServers` list (no credentials) and the
 * credentials for `state["hummingbird.localMcp"]` (`buildRunInput` puts
 * them there). The same servers the `/v1/chat` body's `mcpServers` lists
 * (`use-chat-send`): the workspace's enabled, non-deleted local-mode
 * servers with cached tools — minus the ones outside the persona's
 * `allowedMcpServerIds` (agent-py filters too; this keeps their
 * credentials off the wire).
 *
 * Clamped to the contract's limits (8 servers, 64 tools each, field
 * lengths, 32 headers) so a large cache can't turn the start into a 422.
 * The credentials are read (`getCred` — `getLocalCred`) per call and kept
 * nowhere: the caller puts them in the in-flight request only.
 *
 * Pure (the credential reader is injected).
 */

import type { McpCredentials } from "@/shared/mcp/credentials"
import type { McpServer } from "@/shared/types"

import type { LocalMcpCredentials, LocalMcpServer } from "./types"

type LocalMcpTool = NonNullable<NonNullable<LocalMcpServer["capabilities"]>["tools"]>[number]

const MAX_SERVERS = 8
const MAX_TOOLS = 64
const MAX_NAME = 200
const MAX_SERVER_NAME = 200
const MAX_URL = 2000
const MAX_DESCRIPTION = 2000
const MAX_UI_URI = 2000
const MAX_HEADERS = 32
const MAX_HEADER_VALUE = 8192
const MAX_CRED_TYPE = 40

export interface RunLocalMcp {
  localMcpServers?: LocalMcpServer[]
  localMcpCredentials?: LocalMcpCredentials
}

function toolOf(t: { name: string; description?: string; inputSchema?: unknown; uiResourceUri?: string }): LocalMcpTool | null {
  if (!t.name || t.name.length > MAX_NAME) return null
  return {
    name: t.name,
    ...(t.description ? { description: t.description.slice(0, MAX_DESCRIPTION) } : {}),
    ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
    ...(t.uiResourceUri && t.uiResourceUri.length <= MAX_UI_URI ? { uiResourceUri: t.uiResourceUri } : {}),
  }
}

function credentialOf(cred: McpCredentials | undefined): LocalMcpCredentials[string] | null {
  if (!cred || typeof cred !== "object") return null
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(cred.headers ?? {})) {
    if (Object.keys(headers).length >= MAX_HEADERS) break
    if (k && typeof v === "string" && v.length <= MAX_HEADER_VALUE) headers[k] = v
  }
  const type = typeof cred.type === "string" && cred.type.length <= MAX_CRED_TYPE ? cred.type : undefined
  if (!type && Object.keys(headers).length === 0) return null
  return { ...(type ? { type } : {}), ...(Object.keys(headers).length > 0 ? { headers } : {}) }
}

export function localMcpForRun(
  servers: readonly McpServer[],
  workspaceId: string | null | undefined,
  getCred: (serverId: string) => McpCredentials | undefined,
  opts: { allowedMcpServerIds?: readonly string[] } = {},
): RunLocalMcp {
  const allow = opts.allowedMcpServerIds ? new Set(opts.allowedMcpServerIds) : null
  const localMcpServers: LocalMcpServer[] = []
  const localMcpCredentials: LocalMcpCredentials = {}
  for (const s of servers) {
    if (localMcpServers.length >= MAX_SERVERS) break
    if (s.workspaceId !== workspaceId || s.deletedAt || !s.enabled || s.credentialMode !== "local") continue
    if (allow && !allow.has(s.id)) continue
    if (s.name.length > MAX_SERVER_NAME || s.url.length > MAX_URL) continue
    const tools = (s.capabilities?.tools ?? [])
      .map(toolOf)
      .filter((t): t is LocalMcpTool => t !== null)
      .slice(0, MAX_TOOLS)
    if (tools.length === 0) continue
    localMcpServers.push({
      id: s.id,
      name: s.name,
      url: s.url,
      transport: s.transport,
      ...(s.requiresApproval ? { requiresApproval: true } : {}),
      capabilities: { tools },
    })
    const cred = credentialOf(getCred(s.id))
    if (cred) localMcpCredentials[s.id] = cred
  }
  return {
    ...(localMcpServers.length > 0 ? { localMcpServers } : {}),
    ...(Object.keys(localMcpCredentials).length > 0 ? { localMcpCredentials } : {}),
  }
}
