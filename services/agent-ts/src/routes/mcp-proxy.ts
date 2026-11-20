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
 *      SECURITY DEFINER RPC. The row's URL then replaces the body's —
 *      a stored credential is only ever sent to the stored URL.
 *
 * Every effective URL clears the MCP anti-SSRF policy
 * (`@/server/mcp/outbound`; 400 `mcp_url_blocked`). If neither path
 * produces a credential and the upstream MCP server actually requires
 * auth, the call fails upstream and the proxy surfaces a generic
 * 502 `mcp_upstream_error` (details are logged, never echoed) — same
 * as Next.js.
 *
 * The MCP client itself (`@/server/mcp/client`) is reused directly;
 * `bunfig` / CLI `--conditions=react-server` makes the `server-only`
 * marker resolve to its empty shim at module-load time.
 */

import { Hono } from "hono"
import { z } from "zod"

import { callTool, discover, readResource } from "@/server/mcp/client"
import { McpUrlBlockedError, validateMcpServerUrl } from "@/server/mcp/outbound"
import type { McpServer } from "@/shared/types"

import { hasPool, getPool } from "../db"
import {
  fetchCloudServer,
  upsertServerWithCredentials,
  type CloudMcpServer,
  type McpCredentials,
} from "../mcp"
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

/** `POST /v1/mcp/server` body. Mirrors the in-Next route's schema
 *  byte-for-byte so the frontend's `apiClient.mcp.upsertCloudServer`
 *  can target either backend without marshalling. */
const ServerUpsertSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  credentials: z
    .object({
      type: z.string().max(40).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  capabilities: z
    .object({
      tools: z.array(z.unknown()).optional(),
      resources: z.array(z.unknown()).optional(),
      prompts: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
  enabled: z.boolean().optional(),
})

const VALID_ACTIONS = new Set(["discover", "call", "read"] as const)

type CloudServerLookup = (args: {
  userId: string
  serverId: string
}) => Promise<CloudMcpServer | null>

const defaultCloudServerLookup: CloudServerLookup = async (args) =>
  hasPool() ? fetchCloudServer(getPool(), args) : null

let cloudServerLookup: CloudServerLookup = defaultCloudServerLookup

/** Test seam — swap the cloud-mode row lookup (normally an RLS-scoped
 *  Postgres query) so tests can exercise the DB-URL enforcement
 *  without a database. Pass null to restore the default. */
export function _setCloudServerLookupForTest(fn: CloudServerLookup | null): void {
  cloudServerLookup = fn ?? defaultCloudServerLookup
}

export const mcpProxyRoutes = new Hono<{ Variables: AuthVars }>()

/** `POST /v1/mcp/server` — write/update a cloud-mode MCP server +
 *  its encrypted credential. The browser can't call the encrypt RPC
 *  directly because `MCP_ENCRYPTION_KEY` lives only server-side;
 *  this route is the only path that writes `credentials_encrypted`.
 *  Local-mode servers don't need this route — they go through the
 *  sync layer like any other slice. Mirrors `app/api/mcp/server/route.ts`
 *  and `POST /v1/mcp/server` on agent-py. */
mcpProxyRoutes.post("/v1/mcp/server", requireAuth, async (c) => {
  // Body validation first — matches FastAPI's auto-validation order
  // on agent-py so both backends return 400/422 for shape problems
  // before they surface the 503 misconfig signal.
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ code: "invalid_request", message: "Body must be JSON." }, 400)
  }
  const parsed = ServerUpsertSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      422,
    )
  }

  // Anti-SSRF: reject unsafe endpoints at save time so a blocked URL
  // never lands in `mcp_servers`. (Rows can still be edited directly
  // under RLS, so the proxy re-validates on every use too.) Same
  // policy as `app/api/mcp/server/route.ts` — private hosts only with
  // `MCP_ALLOW_PRIVATE_HOSTS=true`.
  const urlCheck = await validateMcpServerUrl(parsed.data.url)
  if (!urlCheck.ok) {
    return c.json(
      {
        code: "mcp_url_blocked",
        message: "MCP server URL is not allowed.",
        detail: urlCheck.error.code,
      },
      400,
    )
  }

  if (!hasPool()) {
    // Without a pool we can't impersonate the user for RLS, so the
    // upsert can't succeed even if the encryption key were set.
    // 503 (service misconfigured) — the caller's token is fine, the
    // deploy is incomplete.
    return c.json(
      {
        code: "db_unconfigured",
        message: "SUPABASE_DB_URL is not configured on the agent service.",
      },
      503,
    )
  }

  const claims = c.get("claims")
  const userId = typeof claims.sub === "string" ? claims.sub : ""
  if (!userId) {
    return c.json({ code: "auth", message: "Token has no subject." }, 401)
  }

  const result = await upsertServerWithCredentials(getPool(), {
    userId,
    serverId: parsed.data.id,
    workspaceId: parsed.data.workspaceId,
    name: parsed.data.name,
    url: parsed.data.url,
    credentials: parsed.data.credentials as McpCredentials,
    capabilities: parsed.data.capabilities,
    enabled: parsed.data.enabled,
  })
  if (!result.ok) {
    if (result.error === "encryption_key_unset") {
      return c.json(
        {
          code: "encryption_key_unset",
          message: "MCP_ENCRYPTION_KEY is not configured.",
        },
        500,
      )
    }
    return c.json(
      { code: "upsert_failed", message: result.error ?? "RPC failed." },
      502,
    )
  }
  return c.json({ ok: true })
})

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

    // Per-action required fields — checked before any DB lookup or
    // DNS-resolving URL validation.
    const tool = parsed.data.tool ?? ""
    const uri = parsed.data.uri ?? ""
    if (action === "call" && !tool) {
      return c.json({ error: "invalid_body", detail: "`tool` required." }, 400)
    }
    if (action === "read" && !uri) {
      return c.json({ error: "invalid_body", detail: "`uri` required." }, 400)
    }

    let credentials: McpCredentials | undefined =
      decodeCredentialHeader(c.req.header("x-mcp-credentials")) ?? undefined
    let serverName = parsed.data.server.name
    let serverUrl = parsed.data.server.url

    // Cloud-mode fallback when the header didn't supply a credential.
    // When the caller owns a cloud-mode row for this id, the row's
    // url/name REPLACE the body's: decrypted cloud credentials must
    // only ever go to the URL the user stored, never to an arbitrary
    // URL in the request body (otherwise any caller could exfiltrate
    // the stored secret to a server they control). Mirrors agent-py's
    // `fetch_cloud_server` path and the in-Next `cloudServerOverride`.
    if (!credentials) {
      const claims = c.get("claims")
      const userId = typeof claims.sub === "string" ? claims.sub : ""
      if (userId) {
        const cloud = await cloudServerLookup({ userId, serverId })
        if (cloud) {
          serverName = cloud.name
          serverUrl = cloud.url
          credentials = cloud.credentials ?? undefined
        }
      }
    }

    // Anti-SSRF: validate the effective URL (body for local mode, the
    // user-editable DB row for cloud mode) before any outbound
    // request. The MCP client wrapper re-checks, but rejecting here
    // gives a clean 400 instead of an upstream error.
    const urlCheck = await validateMcpServerUrl(serverUrl)
    if (!urlCheck.ok) {
      return c.json(
        { error: "mcp_url_blocked", detail: urlCheck.error.code },
        400,
      )
    }

    const endpoint: Pick<McpServer, "id" | "name" | "url" | "transport"> = {
      id: serverId,
      name: serverName,
      url: serverUrl,
      transport: "http",
    }

    try {
      if (action === "discover") {
        const capabilities = await discover(endpoint as McpServer, credentials)
        return c.json({ capabilities })
      }
      if (action === "call") {
        const result = await callTool(
          endpoint as McpServer,
          credentials,
          tool,
          parsed.data.input,
        )
        return c.json({ result })
      }
      // action === "read"
      const result = await readResource(
        endpoint as McpServer,
        credentials,
        uri,
      )
      return c.json({ result })
    } catch (err) {
      if (err instanceof McpUrlBlockedError) {
        return c.json(
          { error: "mcp_url_blocked", detail: err.validation.code },
          400,
        )
      }
      // Never echo the upstream error: the MCP SDK embeds non-2xx
      // response bodies in its error messages, which would turn this
      // proxy into a response-reflecting fetcher. Log server-side only
      // (never the credential object). Mirrors the in-Next route.
      console.error("[mcp-proxy] upstream call failed", {
        serverId,
        action,
        message: err instanceof Error ? err.message : String(err),
      })
      return c.json({ error: "mcp_upstream_error" }, 502)
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
