import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { z } from "zod"

import { requireSessionWhenSupabaseConfigured } from "@/server/auth/require-ai-auth"
import { callTool, discover, readResource } from "@/server/mcp/client"
import { fetchDecryptedCredential } from "@/server/mcp/credentials"
import { McpUrlBlockedError, validateMcpServerUrl } from "@/server/mcp/outbound"
import { createSlidingWindow, rateLimitKey } from "@/server/rate-limit"
import { PAYLOAD_TOO_LARGE_CODE, readJsonCapped } from "@/server/read-body-capped"
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

/** Per-user (signed in) or per-IP (no Supabase) cap on proxied calls.
 *  Chat-turn tool calls run in-process and don't count; this covers
 *  discovery, resource reads and MCP-app tool calls from the browser.
 *  Exported for tests. */
export const mcpProxyLimit = createSlidingWindow({ windowMs: 60_000, max: 120 })

/** Body cap: a server config + a tool's input / a resource URI. Tool
 *  inputs are model- or app-written JSON; 1 MB is far past real use. */
const MCP_PROXY_BODY_MAX = 1024 * 1024

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ serverId: string; action: string }> }
) {
  const { serverId, action } = await context.params

  if (!serverId || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  // The proxy fetches a caller-chosen URL with caller-chosen headers, so
  // it must not be an anonymous open relay. With Supabase configured the
  // caller must be signed in (this also covers REQUIRE_AUTH_FOR_AI).
  // Without Supabase there are no accounts: local-mode MCP stays open,
  // bounded by the per-IP limit below and the SSRF guard.
  const session = await requireSessionWhenSupabaseConfigured()
  if (!session.ok) return session.response
  const limitKey = session.user ? `user:${session.user.id}` : `ip:${rateLimitKey(req)}`
  const limit = mcpProxyLimit.consume(limitKey)
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        code: "rate_limited",
        message: `Too many MCP requests. Retry in ${limit.retryAfterSec}s.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    )
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

  const read = await readJsonCapped(req, MCP_PROXY_BODY_MAX)
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: PAYLOAD_TOO_LARGE_CODE }, { status: 413 })
      : NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const body = read.value

  const schema =
    action === "discover" ? DiscoverSchema : action === "call" ? CallSchema : ReadSchema
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return badRequest("invalid_body", parsed.error.message)
  }
  if (parsed.data.server.id !== serverId) {
    // Catch a body/path mismatch so a buggy client doesn't accidentally
    // hit the wrong server config.
    return badRequest("serverId_mismatch", "body server.id must match the path")
  }
  const server = toServerShape(parsed.data.server, serverId, cloudServerOverride)

  // Anti-SSRF: validate the effective URL (body for local mode, the
  // user-editable Supabase row for cloud mode) before any outbound
  // request. The client wrapper re-checks, but rejecting here gives a
  // clean 400 instead of an upstream error.
  const urlCheck = await validateMcpServerUrl(server.url)
  if (!urlCheck.ok) {
    return NextResponse.json(
      { error: "mcp_url_blocked", detail: urlCheck.error.code },
      { status: 400 }
    )
  }

  try {
    if (action === "discover") {
      const capabilities = await discover(server, credentials)
      return NextResponse.json({ capabilities })
    }

    if (action === "call") {
      const data = parsed.data as z.infer<typeof CallSchema>
      const result = await callTool(server, credentials, data.tool, data.input)
      return NextResponse.json({ result })
    }

    const data = parsed.data as z.infer<typeof ReadSchema>
    const result = await readResource(server, credentials, data.uri)
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof McpUrlBlockedError) {
      return NextResponse.json(
        { error: "mcp_url_blocked", detail: err.validation.code },
        { status: 400 }
      )
    }
    // Never echo the upstream error: the MCP SDK embeds non-2xx
    // response bodies in its error messages, which would turn this
    // proxy into a response-reflecting fetcher. Log server-side only
    // (no credentials — they never appear in the SDK's messages, but
    // we also don't log the cred object itself).
    console.error("[mcp-proxy] upstream call failed", {
      serverId,
      action,
      message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: "mcp_upstream_error" }, { status: 502 })
  }
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
