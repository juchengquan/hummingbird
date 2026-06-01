/**
 * `POST /v1/mcp/{server_id}/{action}` — port of agent-py's Phase 4-4b
 * route, which itself mirrors `app/api/mcp/[serverId]/[action]/route.ts`.
 *
 * Actions:
 *   - `discover` → `{capabilities}` from the MCP handshake
 *   - `call` → `{result: {text, isError}}`
 *   - `read` → `{result: {text?, mimeType?}}`
 *
 * Credentials come from two places:
 *   1. `X-MCP-Credentials` header (local-mode — base64-JSON).
 *   2. Cloud-mode fallback when no header — looks up the server row by
 *      id under per-user RLS impersonation, decrypts the cred via the
 *      SECURITY DEFINER RPC.
 *
 * If neither produces a credential and the upstream MCP server
 * actually requires auth, the call fails upstream and the proxy
 * surfaces it as 502 — same as agent-py / Next.js.
 *
 * The MCP client itself (`@/server/mcp/client`) is reused directly;
 * `bunfig` / CLI `--conditions=react-server` makes the `server-only`
 * marker resolve to its empty shim at module-load time.
 */

import { Hono } from "hono"
import { z } from "zod"

import { callTool, discover, readResource } from "@/server/mcp/client"
import type { McpServer } from "@/shared/types"

import { hasPool, getPool } from "../db"
import { fetchDecryptedCredentials, type McpCredentials } from "../mcp"
import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"

const ServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
  transport: z.literal("http"),
})

const BodySchema = z.object({
  server: ServerSchema,
  tool: z.string().min(1).optional(),
  input: z.unknown().optional(),
  uri: z.string().min(1).optional(),
})

const VALID_ACTIONS = new Set(["discover", "call", "read"] as const)

export const mcpProxyRoutes = new Hono<{ Variables: AuthVars }>()

mcpProxyRoutes.post(
  "/v1/mcp/:serverId/:action",
  requireAuth,
  async (c) => {
    const { serverId, action } = c.req.param()
    if (!VALID_ACTIONS.has(action as "discover" | "call" | "read")) {
      return c.json({ error: "Not found" }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid_json" }, 400)
    }
    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: "invalid_body", detail: parsed.error.message },
        400,
      )
    }
    if (parsed.data.server.id !== serverId) {
      return c.json(
        { error: "serverId_mismatch", detail: "Path / body id mismatch." },
        400,
      )
    }

    let credentials: McpCredentials | undefined =
      decodeCredentialHeader(c.req.header("x-mcp-credentials")) ?? undefined

    if (!credentials && hasPool()) {
      const claims = c.get("claims")
      const userId = typeof claims.sub === "string" ? claims.sub : ""
      if (userId) {
        const cloud = await fetchDecryptedCredentials(getPool(), {
          userId,
          serverId,
        })
        if (cloud) credentials = cloud
      }
    }

    const endpoint: Pick<McpServer, "id" | "name" | "url" | "transport"> = {
      id: serverId,
      name: parsed.data.server.name,
      url: parsed.data.server.url,
      transport: "http",
    }

    try {
      if (action === "discover") {
        const capabilities = await discover(endpoint as McpServer, credentials)
        return c.json({ capabilities })
      }
      if (action === "call") {
        if (!parsed.data.tool) {
          return c.json(
            { error: "invalid_body", detail: "`tool` required." },
            400,
          )
        }
        const result = await callTool(
          endpoint as McpServer,
          credentials,
          parsed.data.tool,
          parsed.data.input,
        )
        return c.json({ result })
      }
      // action === "read"
      if (!parsed.data.uri) {
        return c.json({ error: "invalid_body", detail: "`uri` required." }, 400)
      }
      const result = await readResource(
        endpoint as McpServer,
        credentials,
        parsed.data.uri,
      )
      return c.json({ result })
    } catch (err) {
      // Never include credentials in the error response.
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: "mcp_call_failed", message }, 502)
    }
  },
)

/** Decode `X-MCP-Credentials` (base64-encoded JSON). Returns null on
 *  any decode error — the caller falls through to the cloud lookup. */
function decodeCredentialHeader(raw: string | undefined): McpCredentials | null {
  if (!raw) return null
  try {
    const json = Buffer.from(raw, "base64").toString("utf-8")
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as McpCredentials
  } catch {
    return null
  }
}
