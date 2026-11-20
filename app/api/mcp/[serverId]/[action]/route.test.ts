import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { encodeCredentialHeader, MCP_CRED_HEADER } from "@/shared/mcp/credentials"

import { POST } from "./route"

const SECRET = "SECRET-UPSTREAM-BODY-7f3a"
const ENV_KEYS = [
  "MCP_ALLOW_PRIVATE_HOSTS",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const
const saved: Record<string, string | undefined> = {}

let upstream: ReturnType<typeof Bun.serve>

beforeAll(() => {
  // An "internal" HTTP service whose error body must never be reflected.
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(SECRET, { status: 500 }),
  })
})
afterAll(() => upstream.stop(true))

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function call(url: string, opts: { serverId?: string; bodyId?: string } = {}) {
  const serverId = opts.serverId ?? "srv-1"
  const req = new NextRequest(`http://app.test/api/mcp/${serverId}/discover`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Local-mode credential header → no Supabase lookup.
      [MCP_CRED_HEADER]: encodeCredentialHeader({ headers: { authorization: "Bearer t" } }),
    },
    body: JSON.stringify({
      server: { id: opts.bodyId ?? serverId, name: "x", url, transport: "http" },
    }),
  })
  return POST(req, { params: Promise.resolve({ serverId, action: "discover" }) })
}

describe("POST /api/mcp/[serverId]/[action] — SSRF guard", () => {
  test("loopback URL rejected with 400 by default", async () => {
    const res = await call(`http://127.0.0.1:${upstream.port}/mcp`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "mcp_url_blocked", detail: "private_address" })
  })

  test("metadata endpoint rejected even with MCP_ALLOW_PRIVATE_HOSTS=true", async () => {
    process.env.MCP_ALLOW_PRIVATE_HOSTS = "true"
    const res = await call("http://169.254.169.254/latest/meta-data/")
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("mcp_url_blocked")
  })

  test("body/path serverId mismatch → 400", async () => {
    const res = await call("https://93.184.216.34/mcp", { bodyId: "other" })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("serverId_mismatch")
  })
})

describe("POST /api/mcp/[serverId]/[action] — upstream errors not reflected", () => {
  test("non-2xx upstream body is replaced by a generic 502", async () => {
    // Opt in so the loopback test server is reachable at all.
    process.env.MCP_ALLOW_PRIVATE_HOSTS = "true"
    const origError = console.error
    const logged: unknown[] = []
    console.error = (...args: unknown[]) => {
      logged.push(...args)
    }
    try {
      const res = await call(`http://127.0.0.1:${upstream.port}/mcp`)
      expect(res.status).toBe(502)
      const text = await res.text()
      expect(text).not.toContain(SECRET)
      expect(JSON.parse(text)).toEqual({ error: "mcp_upstream_error" })
      // Details (which do carry the upstream body) stay in server logs.
      expect(JSON.stringify(logged)).toContain(SECRET)
    } finally {
      console.error = origError
    }
  })
})
