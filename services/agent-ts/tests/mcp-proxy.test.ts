/**
 * Tests for `POST /v1/mcp/{server_id}/{action}`. The actual MCP
 * transport (`@/server/mcp/client`) is covered upstream — here we
 * just verify the route's auth / validation / path-body coupling.
 *
 * No network is made: we hit only the branches that reject the
 * request before the transport opens.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"
import { _setCloudServerLookupForTest } from "../src/routes/mcp-proxy"

const SECRET = "test-secret-do-not-use-in-prod-32-bytes!"

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_JWT_SECRET
  resetEnvCacheForTest()
})

async function makeJwt(): Promise<string> {
  const encoder = new TextEncoder()
  return new SignJWT({ sub: "00000000-0000-4000-8000-000000000123", role: "authenticated", aud: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(encoder.encode(SECRET))
}

describe("POST /v1/mcp/{server_id}/{action}", () => {
  test("requires auth", async () => {
    const app = createApp()
    const res = await app.request("/v1/mcp/srv1/discover", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("unknown action -> 404", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/srv1/bogus", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test("invalid JSON -> 400 invalid_json", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/srv1/discover", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "not json",
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("invalid_json")
  })

  test("missing server in body -> 400 invalid_body", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/srv1/discover", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("invalid_body")
  })

  test("path / body id mismatch -> 400 serverId_mismatch", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/path-id/discover", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        server: {
          id: "body-id",
          name: "Test",
          url: "https://example.com/mcp",
          transport: "http",
        },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("serverId_mismatch")
  })

  test("call action without tool -> 400 invalid_body", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/srv1/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        server: {
          id: "srv1",
          name: "Test",
          url: "https://example.com/mcp",
          transport: "http",
        },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe("invalid_body")
    expect(body.detail).toContain("tool")
  })

  test("read action without uri -> 400 invalid_body", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/srv1/read", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        server: {
          id: "srv1",
          name: "Test",
          url: "https://example.com/mcp",
          transport: "http",
        },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe("invalid_body")
    expect(body.detail).toContain("uri")
  })
})

describe("POST /v1/mcp/server (upsert)", () => {
  const UUID = "11111111-1111-1111-1111-111111111111"
  const WS_UUID = "11111111-1111-1111-1111-111111111122"

  function validBody(): Record<string, unknown> {
    return {
      id: UUID,
      workspaceId: WS_UUID,
      name: "Cloud MCP",
      // Public IP literal: clears the anti-SSRF check without a DNS
      // lookup, so the test stays hermetic.
      url: "https://1.1.1.1/sse",
      credentials: { type: "header", headers: { "X-API-Key": "secret" } },
      enabled: true,
    }
  }

  test("requires auth", async () => {
    const app = createApp()
    const res = await app.request("/v1/mcp/server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(401)
  })

  test("503 when no DB pool is configured", async () => {
    // No SUPABASE_DB_URL → hasPool() returns false → 503. Mirrors
    // agent-py's behaviour: clear misconfig signal rather than
    // letting the RPC fail opaquely later.
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/server", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody()),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("db_unconfigured")
  })

  test("invalid JSON → 400", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/mcp/server", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{not json",
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("invalid_request")
  })

  test("missing required field → 422", async () => {
    const app = createApp()
    const token = await makeJwt()
    const bad = validBody()
    delete bad.name
    const res = await app.request("/v1/mcp/server", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bad),
    })
    // Validation runs before the hasPool check — same order as
    // FastAPI's auto-validation on agent-py.
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("invalid_request")
  })
})

describe("MCP anti-SSRF + credential scoping", () => {
  const UUID = "11111111-1111-1111-1111-111111111111"

  type Hit = { authorization: string | null }
  function startUpstream(label: string, hits: Hit[]) {
    // A fake "MCP server" that records every request and fails with a
    // body the proxy must never reflect back to its caller.
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        hits.push({ authorization: req.headers.get("authorization") })
        return new Response(`UPSTREAM-SECRET-BODY-${label}`, { status: 500 })
      },
    })
  }

  afterEach(() => {
    delete process.env.MCP_ALLOW_PRIVATE_HOSTS
    _setCloudServerLookupForTest(null)
  })

  async function post(
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const app = createApp()
    const token = await makeJwt()
    return app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    })
  }

  test("upsert rejects a metadata-address URL with 400 mcp_url_blocked", async () => {
    const res = await post("/v1/mcp/server", {
      id: UUID,
      workspaceId: UUID,
      name: "Evil",
      url: "http://169.254.169.254/latest/meta-data/",
      credentials: {},
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("mcp_url_blocked")
  })

  test("upsert rejects a loopback URL unless MCP_ALLOW_PRIVATE_HOSTS=true", async () => {
    const payload = {
      id: UUID,
      workspaceId: UUID,
      name: "Local",
      url: "http://127.0.0.1:9/mcp",
      credentials: {},
    }
    const blocked = await post("/v1/mcp/server", payload)
    expect(blocked.status).toBe(400)
    expect(((await blocked.json()) as { code: string }).code).toBe("mcp_url_blocked")

    process.env.MCP_ALLOW_PRIVATE_HOSTS = "true"
    const allowed = await post("/v1/mcp/server", payload)
    // Passes URL validation, then hits the (absent) DB pool.
    expect(allowed.status).toBe(503)
  })

  test("proxy rejects a private body URL with 400 mcp_url_blocked", async () => {
    const res = await post("/v1/mcp/srv1/discover", {
      server: { id: "srv1", name: "x", url: "http://10.0.0.5/mcp", transport: "http" },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("mcp_url_blocked")
  })

  test("proxy rejects a private DB-stored URL too", async () => {
    _setCloudServerLookupForTest(async () => ({
      id: UUID,
      name: "Stored",
      url: "http://169.254.169.254/",
      credentials: { headers: { Authorization: "Bearer stored-secret" } },
    }))
    const res = await post(`/v1/mcp/${UUID}/discover`, {
      server: { id: UUID, name: "Body", url: "https://1.1.1.1/mcp", transport: "http" },
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("mcp_url_blocked")
  })

  test("cloud credentials go only to the DB-stored URL, never the body URL", async () => {
    process.env.MCP_ALLOW_PRIVATE_HOSTS = "true"
    const attackerHits: Hit[] = []
    const storedHits: Hit[] = []
    const attacker = startUpstream("attacker", attackerHits)
    const stored = startUpstream("stored", storedHits)
    const lookups: { userId: string; serverId: string }[] = []
    _setCloudServerLookupForTest(async (args) => {
      lookups.push(args)
      return {
        id: UUID,
        name: "Stored",
        url: `http://127.0.0.1:${stored.port}/mcp`,
        credentials: { headers: { Authorization: "Bearer stored-secret" } },
      }
    })
    try {
      const res = await post(`/v1/mcp/${UUID}/discover`, {
        server: {
          id: UUID,
          name: "Body",
          url: `http://127.0.0.1:${attacker.port}/mcp`,
          transport: "http",
        },
      })
      expect(lookups).toHaveLength(1)
      expect(attackerHits).toHaveLength(0)
      expect(storedHits.length).toBeGreaterThan(0)
      expect(storedHits[0]?.authorization).toBe("Bearer stored-secret")

      // Upstream failure → generic 502; the upstream body is not echoed.
      expect(res.status).toBe(502)
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ error: "mcp_upstream_error" })
      expect(text).not.toContain("UPSTREAM-SECRET-BODY")
    } finally {
      attacker.stop(true)
      stored.stop(true)
    }
  })

  test("header credentials skip the cloud lookup and use the body URL", async () => {
    process.env.MCP_ALLOW_PRIVATE_HOSTS = "true"
    const hits: Hit[] = []
    const upstream = startUpstream("local", hits)
    let lookedUp = false
    _setCloudServerLookupForTest(async () => {
      lookedUp = true
      return null
    })
    try {
      const cred = Buffer.from(
        JSON.stringify({ headers: { Authorization: "Bearer local-cred" } }),
      ).toString("base64")
      const res = await post(
        "/v1/mcp/srv1/discover",
        {
          server: {
            id: "srv1",
            name: "Local",
            url: `http://127.0.0.1:${upstream.port}/mcp`,
            transport: "http",
          },
        },
        { "X-MCP-Credentials": cred },
      )
      expect(lookedUp).toBe(false)
      expect(hits[0]?.authorization).toBe("Bearer local-cred")
      expect(res.status).toBe(502)
      expect(await res.text()).not.toContain("UPSTREAM-SECRET-BODY")
    } finally {
      upstream.stop(true)
    }
  })
})
