/**
 * Tests for `POST /v1/mcp/{server_id}/{action}`. The actual MCP
 * transport (`@/server/mcp/client`) is covered upstream — here we
 * just verify the route's auth / validation / path-body coupling.
 *
 * No network is made: we hit only the branches that reject the
 * request before the transport opens.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"

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
  return new SignJWT({ sub: "user-uuid-123", role: "authenticated" })
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
      url: "https://mcp.cloud/sse",
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
