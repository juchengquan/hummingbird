import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { z } from "zod"

import { callTool, discover, readResource } from "@/server/mcp/client"
import {
  MCP_CRED_HEADER,
  decodeCredentialHeader,
  type McpCredentials,
} from "@/shared/mcp/credentials"
import type { McpServer } from "@/shared/types"

/**
 * Server-side MCP proxy. Client-side discovery / tool-call / resource-
 * read goes through here; the chat route calls the MCP client wrapper
 * directly in-process for streaming turns.
 *
 * Routes (all `POST`):
 *   /api/mcp/{serverId}/discover    — fetch tools/list, resources/list, prompts/list
 *   /api/mcp/{serverId}/call        — invoke a tool
 *   /api/mcp/{serverId}/read        — read a resource by URI
 *
 * Stage 2 supports **local-mode credentials only** — the client sends
 * the credential in the `X-MCP-Credentials` header. Cloud-mode
 * credentials (encrypted in Supabase, looked up here by `serverId`)
 * land in Stage 3 alongside the `mcp_servers` table migration.
 *
 * `serverId` is informational at this stage (used for log
 * provenance); the actual endpoint URL comes from the request body
 * since there's no DB lookup yet.
 */

const ServerSchema: z.ZodType<Pick<McpServer, "id" | "name" | "url" | "transport">> =
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().url(),
    transport: z.literal("http"),
  })

const CallSchema = z.object({
  server: ServerSchema,
  tool: z.string().min(1),
  input: z.unknown().optional(),
})

const ReadSchema = z.object({
  server: ServerSchema,
  uri: z.string().min(1),
})

const DiscoverSchema = z.object({
  server: ServerSchema,
})

const VALID_ACTIONS = new Set(["discover", "call", "read"])

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ serverId: string; action: string }> }
) {
  const { serverId, action } = await context.params

  if (!serverId || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  // Parse credentials from the header. Stage 2 supports local-mode
  // only — no DB lookup. Stage 3 will allow an empty header for
  // cloud-mode servers and resolve creds from Supabase via the user
  // session.
  const credHeader = req.headers.get(MCP_CRED_HEADER)
  const credentials: McpCredentials | undefined =
    decodeCredentialHeader(credHeader) ?? undefined

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }

  try {
    if (action === "discover") {
      const parsed = DiscoverSchema.safeParse(body)
      if (!parsed.success) {
        return badRequest("invalid_body", parsed.error.message)
      }
      const server = toServerShape(parsed.data.server, serverId)
      const capabilities = await discover(server, credentials)
      return NextResponse.json({ capabilities })
    }

    if (action === "call") {
      const parsed = CallSchema.safeParse(body)
      if (!parsed.success) {
        return badRequest("invalid_body", parsed.error.message)
      }
      const server = toServerShape(parsed.data.server, serverId)
      const result = await callTool(
        server,
        credentials,
        parsed.data.tool,
        parsed.data.input
      )
      return NextResponse.json({ result })
    }

    if (action === "read") {
      const parsed = ReadSchema.safeParse(body)
      if (!parsed.success) {
        return badRequest("invalid_body", parsed.error.message)
      }
      const server = toServerShape(parsed.data.server, serverId)
      const result = await readResource(server, credentials, parsed.data.uri)
      return NextResponse.json({ result })
    }
  } catch (err) {
    // Never include credentials in error responses.
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: "mcp_call_failed", message },
      { status: 502 }
    )
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 })
}

function badRequest(code: string, detail: string): NextResponse {
  return NextResponse.json({ error: code, detail }, { status: 400 })
}

/**
 * Fill in the fields the MCP client wrapper expects but the client
 * doesn't bother re-sending (workspaceId, timestamps, etc). The
 * wrapper only uses `id`, `name`, `url`, `transport`.
 */
function toServerShape(
  partial: Pick<McpServer, "id" | "name" | "url" | "transport">,
  pathServerId: string
): McpServer {
  // Catch a body/path mismatch so a buggy client doesn't accidentally
  // hit the wrong server config.
  if (partial.id !== pathServerId) {
    throw new Error("serverId_mismatch")
  }
  return {
    ...partial,
    workspaceId: "",
    credentialMode: "local",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}
