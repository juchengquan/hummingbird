import "server-only"

import { readResource } from "@/server/mcp/client"
import type { EffectiveMcpServer } from "@/server/mcp/load-servers"

/**
 * Wire-shape for an MCP resource the client wants attached to the
 * current chat turn. Sent in the request body; the server is
 * responsible for fetching content via `readResource` and injecting
 * it into the system prompt.
 */
export interface ResourceRequest {
  id: string
  serverId: string
  uri: string
  name: string
  mimeType?: string
}

export interface ResolvedResource {
  request: ResourceRequest
  serverName: string
  text?: string
  error?: string
}

const READ_TIMEOUT_MS = 5000

/**
 * Resolve attached MCP resources concurrently. Each `readResource`
 * call has its own 5s timeout — a slow server can't block the whole
 * chat turn. Failures degrade gracefully: the resource shows up in
 * the system prompt as "[MCP resource X unavailable — reason]" so the
 * model knows the user *intended* to share that content but couldn't.
 */
export async function resolveAttachedMcpResources(
  requests: ResourceRequest[] | undefined,
  servers: EffectiveMcpServer[]
): Promise<ResolvedResource[]> {
  if (!requests || requests.length === 0) return []
  const serverById = new Map(servers.map((s) => [s.id, s]))

  return Promise.all(
    requests.map(async (req): Promise<ResolvedResource> => {
      const server = serverById.get(req.serverId)
      if (!server) {
        return {
          request: req,
          serverName: "unknown",
          error: "server not configured or not enabled",
        }
      }
      try {
        const result = await withTimeout(
          readResource(server, server.credentials, req.uri),
          READ_TIMEOUT_MS
        )
        return {
          request: req,
          serverName: server.name,
          text: result.text,
        }
      } catch (err) {
        return {
          request: req,
          serverName: server.name,
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

/**
 * Render resolved resources as a system-prompt fragment, budgeted by
 * `remainingBudget` characters. Resources are prefix-truncated when
 * the budget runs out — same approach as files in
 * `app/api/chat/route.ts`.
 *
 * Returns the fragment (or null if there are no resources to render)
 * and the number of characters consumed.
 */
export function renderMcpResourcesPrompt(
  resolved: ResolvedResource[],
  remainingBudget: number
): { fragment: string | null; used: number } {
  if (resolved.length === 0) return { fragment: null, used: 0 }

  const parts: string[] = []
  let used = 0
  const intro =
    "The user has attached these MCP resources. Their content follows. " +
    "Treat them as authoritative context for any question that references them."
  parts.push(intro)
  used += intro.length

  for (const r of resolved) {
    const header = `\n\n--- ${r.serverName}: ${r.request.name} ---\n`
    if (r.error || !r.text) {
      const placeholder = `${header}[MCP resource "${r.request.name}" unavailable — ${
        r.error ?? "no content"
      }]`
      parts.push(placeholder)
      used += placeholder.length
      continue
    }
    const remaining = remainingBudget - used - header.length
    if (remaining <= 0) {
      parts.push(`\n\n[Additional MCP resource omitted to fit budget: ${r.request.name}]`)
      continue
    }
    const body = r.text.slice(0, remaining)
    const overflow = r.text.length > body.length
    parts.push(
      header +
        body +
        (overflow ? "\n\n[truncated to fit overall budget]" : "")
    )
    used += header.length + body.length
  }

  return { fragment: parts.join(""), used }
}
