import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { setAiAuthScenario } from "@/server/auth/_test/ai-auth-scenario"

import { mcpProxyLimit, POST } from "./route"

// A loopback URL: the SSRF guard rejects it with a 400 before any
// outbound request, which proves the call got past auth + rate limit
// without touching the network.
const BLOCKED_URL = "http://127.0.0.1:9/mcp"

function discover(serverId = "srv-1", ip = "198.51.100.7") {
  const req = new NextRequest(`http://localhost/api/mcp/${serverId}/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({
      server: { id: serverId, name: "s", url: BLOCKED_URL, transport: "http" },
    }),
  })
  return POST(req, { params: Promise.resolve({ serverId, action: "discover" }) })
}

describe("POST /api/mcp/[serverId]/[action] — access control", () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
    mcpProxyLimit._reset()
  })

  test("Supabase configured + anonymous → 401 auth_required (no relay)", async () => {
    restore = setAiAuthScenario("anonymous")
    const res = await discover()
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe("auth_required")
  })

  test("Supabase configured + anonymous → 401 even with REQUIRE_AUTH_FOR_AI off", async () => {
    restore = setAiAuthScenario("flag-off")
    expect((await discover()).status).toBe(401)
  })

  test("no Supabase → anonymous local-mode MCP still reaches the proxy", async () => {
    restore = setAiAuthScenario("supabase-unconfigured")
    const res = await discover()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("mcp_url_blocked")
  })

  test("per-IP limit → 429 with Retry-After once the window is full", async () => {
    restore = setAiAuthScenario("supabase-unconfigured")
    for (let i = 0; i < 120; i++) expect((await discover()).status).toBe(400)
    const res = await discover()
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    // A different client IP has its own bucket.
    expect((await discover("srv-1", "198.51.100.8")).status).toBe(400)
  })
})
