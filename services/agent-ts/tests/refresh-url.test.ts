/**
 * Tests for `POST /v1/images/refresh-url`. The Storage REST call
 * itself is mocked via a global `fetch` patch — we just verify the
 * route's auth + path-prefix guard + error-code mapping.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"

const SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
const SERVICE_KEY = "service-role-test-key"

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET
  process.env.SUPABASE_URL = "https://example.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_JWT_SECRET
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  resetEnvCacheForTest()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function makeJwt(sub = "user-uuid-123"): Promise<string> {
  const encoder = new TextEncoder()
  return new SignJWT({ sub, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(encoder.encode(SECRET))
}

describe("POST /v1/images/refresh-url", () => {
  test("requires auth", async () => {
    const app = createApp()
    const res = await app.request("/v1/images/refresh-url", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("rejects path outside the caller's prefix with 403", async () => {
    const app = createApp()
    const token = await makeJwt("user-uuid-123")
    const res = await app.request("/v1/images/refresh-url", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ storage_path: "different-user/image.png" }),
    })
    expect(res.status).toBe(403)
  })

  test("returns 200 + url when Storage returns a signed URL", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ signedURL: "/object/sign/path?token=abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    const app = createApp()
    const token = await makeJwt("user-uuid-123")
    const res = await app.request("/v1/images/refresh-url", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ storage_path: "user-uuid-123/generated/x.png" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string }
    expect(body.url).toContain("https://example.supabase.co/storage/v1")
  })

  test("returns 404 when Storage returns 404", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch

    const app = createApp()
    const token = await makeJwt("user-uuid-123")
    const res = await app.request("/v1/images/refresh-url", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ storage_path: "user-uuid-123/missing.png" }),
    })
    expect(res.status).toBe(404)
  })
})
