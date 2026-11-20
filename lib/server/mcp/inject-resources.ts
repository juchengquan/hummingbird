import "server-only"

import { readResource } from "@/server/mcp/client"
import type { EffectiveMcpServer } from "@/server/mcp/load-servers"
import type { ResolvedAttachment } from "@/server/attachments/render"
import type { McpResourceRef } from "@/shared/attachments"
import { getRecentFailure, recordFailure } from "@/server/mcp/last-failures"

const READ_TIMEOUT_MS = 5000

/**
 * Resolve attached MCP resources concurrently. Each `readResource`
 * call has its own 5s timeout — a slow server can't block the whole
 * chat turn. Failures degrade gracefully: errors emit an inline
 * "[unavailable]" marker so the model knows the user *intended* to
 * share that content but couldn't.
 *
 * Per-server failure cache (`last-failures.ts`) short-circuits reads
 * against servers that failed in the last 30 s, so only the first
 * turn after an outage pays the timeout. See that module for the
 * design tradeoffs (per-server granularity, in-process Map, etc.).
 */
export async function resolveAttachedMcpResources(
  requests: McpResourceRef[] | undefined,
  servers: EffectiveMcpServer[],
  /** Failure-cache partition: `user:<id>` when signed in, else the
   *  anonymous client key. See `last-failures.ts`. */
  caller: string
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
      const scope = { caller, serverId: server.id, url: server.url }
      const cachedReason = getRecentFailure(scope)
      if (cachedReason !== null) {
        return {
          kind: "mcp_resource",
          serverName: server.name,
          resourceName: req.name,
          error: `${cachedReason} (cached from a recent failure; retrying after 30s cooldown)`,
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
        // Only a generic category reaches the prompt: the SDK's error
        // text carries the upstream response body.
        const reason = recordFailure(scope, err)
        return {
          kind: "mcp_resource",
          serverName: server.name,
          resourceName: req.name,
          error: reason,
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
