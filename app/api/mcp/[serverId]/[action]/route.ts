import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { z } from "zod"

import { callTool, discover, readResource } from "@/server/mcp/client"
import { fetchDecryptedCredential } from "@/server/mcp/credentials"
import { getSupabaseServerClient } from "@/server/supabase/server"
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

  // Credentials come from one of two places:
  //   1. `X-MCP-Credentials` header (local-mode server — client
  //      attaches the cred from localStorage on each call).
  //   2. Cloud-mode lookup: when the header is absent, the user must
  //      be signed in; we fetch the row's encrypted cred from
  //      Supabase and decrypt via the SECURITY DEFINER RPC.
  //
  // If neither path produces a cred and the upstream MCP server
  // actually requires auth, the call will fail upstream and the proxy
  // surfaces that as a 502. We don't hard-fail on missing cred here
  // because some MCP servers don't require auth at all.
  const credHeader = req.headers.get(MCP_CRED_HEADER)
  let credentials: McpCredentials | undefined =
    decodeCredentialHeader(credHeader) ?? undefined
  let cloudServerOverride: Partial<McpServer> | null = null
  if (!credentials) {
    const client = await getSupabaseServerClient()
    if (client) {
      // Pull the row + decrypt the cred. RLS guarantees we only see
      // the caller's own rows; the function's auth.uid() check inside
      // gives the same guarantee for the decrypt itself.
      const { data: row } = await client
        .from("mcp_servers")
        .select("id, name, url, transport, credential_mode")
        .eq("id", serverId)
        .is("deleted_at", null)
        .maybeSingle()
      if (row && row.credential_mode === "cloud") {
        cloudServerOverride = {
          id: row.id,
          name: row.name,
          url: row.url,
          // Codegen widens text columns with CHECK constraints to
          // `string`; the constraint `transport in ('http')` still
          // enforces this at runtime. Cast to satisfy the narrow
          // domain type.
          transport: row.transport as McpServer['transport'],
        }
        const cred = await fetchDecryptedCredential(client, serverId)
        if (cred) credentials = cred
      }
    }
  }

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
      const server = toServerShape(parsed.data.server, serverId, cloudServerOverride)
      const capabilities = await discover(server, credentials)
      return NextResponse.json({ capabilities })
    }

    if (action === "call") {
      const parsed = CallSchema.safeParse(body)
      if (!parsed.success) {
        return badRequest("invalid_body", parsed.error.message)
      }
      const server = toServerShape(parsed.data.server, serverId, cloudServerOverride)
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
      const server = toServerShape(parsed.data.server, serverId, cloudServerOverride)
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
 * Fill in the fields the MCP client wrapper expects but the caller
 * doesn't bother re-sending (workspaceId, timestamps, etc). The
 * wrapper only uses `id`, `name`, `url`, `transport`.
 *
 * When `cloudOverride` is non-null, its url/name/transport take
 * precedence over the body — these come from the Supabase row we
 * just fetched, which is the source of truth for cloud-mode servers
 * (a malicious client can't ask the proxy to call an unrelated URL).
 */
function toServerShape(
  partial: Pick<McpServer, "id" | "name" | "url" | "transport">,
  pathServerId: string,
  cloudOverride: Partial<McpServer> | null
): McpServer {
  // Catch a body/path mismatch so a buggy client doesn't accidentally
  // hit the wrong server config.
  if (partial.id !== pathServerId) {
    throw new Error("serverId_mismatch")
  }
  const merged = cloudOverride
    ? {
        ...partial,
        ...cloudOverride,
        id: pathServerId,
      }
    : partial
  return {
    id: merged.id,
    name: merged.name ?? partial.name,
    url: merged.url ?? partial.url,
    transport: merged.transport ?? partial.transport,
    workspaceId: "",
    credentialMode: cloudOverride ? "cloud" : "local",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}
