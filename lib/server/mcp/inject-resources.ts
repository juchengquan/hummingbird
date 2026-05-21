import "server-only"

import { readResource } from "@/server/mcp/client"
import type { EffectiveMcpServer } from "@/server/mcp/load-servers"
import type { ResolvedAttachment } from "@/server/attachments/render"
import type { McpResourceRef } from "@/shared/attachments"

const READ_TIMEOUT_MS = 5000

/**
 * Resolve attached MCP resources concurrently. Each `readResource`
 * call has its own 5s timeout — a slow server can't block the whole
 * chat turn. Failures degrade gracefully: errors emit an inline
 * "[unavailable]" marker so the model knows the user *intended* to
 * share that content but couldn't.
 */
export async function resolveAttachedMcpResources(
  requests: McpResourceRef[] | undefined,
  servers: EffectiveMcpServer[]
): Promise<ResolvedAttachment[]> {
  if (!requests || requests.length === 0) return []
  const serverById = new Map(servers.map((s) => [s.id, s]))

  return Promise.all(
    requests.map(async (req): Promise<ResolvedAttachment> => {
      const server = serverById.get(req.serverId)
      if (!server) {
        return {
          kind: "mcp_resource",
          serverName: "unknown",
          resourceName: req.name,
          error: "server not configured or not enabled",
        }
      }
      try {
        const result = await withTimeout(
          readResource(server, server.credentials, req.uri),
          READ_TIMEOUT_MS
        )
        return {
          kind: "mcp_resource",
          serverName: server.name,
          resourceName: req.name,
          text: result.text,
        }
      } catch (err) {
        return {
          kind: "mcp_resource",
          serverName: server.name,
          resourceName: req.name,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    })
  )
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}
