/**
 * JWT middleware tests. Mirrors agent-py's `test_auth.py` — Phase 0
 * only has one protected endpoint (`/v1/whoami`), but the failure
 * shapes here are the contract every later route depends on.
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

async function makeJwt(
  claims: Record<string, unknown> = {},
  secret = SECRET,
): Promise<string> {
  const encoder = new TextEncoder()
  return new SignJWT({ role: "authenticated", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(encoder.encode(secret))
}

describe("/v1/whoami auth", () => {
  test("returns claims with a valid token", async () => {
    const app = createApp()
    const token = await makeJwt({ sub: "user-uuid-123" })
    const res = await app.request("/v1/whoami", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string | null; role: string | null }
    expect(body).toEqual({ user_id: "user-uuid-123", role: "authenticated" })
  })

  test("rejects missing header with 401 + WWW-Authenticate", async () => {
    const app = createApp()
    const res = await app.request("/v1/whoami")
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
  })

  test("rejects non-bearer scheme", async () => {
    const app = createApp()
    const res = await app.request("/v1/whoami", {
      headers: { Authorization: "Basic abc==" },
    })
    expect(res.status).toBe(401)
  })

  test("rejects garbage token", async () => {
    const app = createApp()
    const res = await app.request("/v1/whoami", {
      headers: { Authorization: "Bearer not-a-jwt" },
    })
    expect(res.status).toBe(401)
  })

  test("rejects token signed with a different secret", async () => {
    const app = createApp()
    const wrong = await makeJwt(
      { sub: "u" },
      "different-secret-also-32-bytes-long!",
    )
    const res = await app.request("/v1/whoami", {
      headers: { Authorization: `Bearer ${wrong}` },
    })
    expect(res.status).toBe(401)
  })

  test("returns 503 when SUPABASE_JWT_SECRET is unset", async () => {
    const prev = process.env.SUPABASE_JWT_SECRET
    try {
      delete process.env.SUPABASE_JWT_SECRET
      resetEnvCacheForTest()
      const app = createApp()
      // Even an otherwise-valid header should yield 503 — the misconfig
      // dominates.
      const res = await app.request("/v1/whoami", {
        headers: { Authorization: "Bearer anything" },
      })
      expect(res.status).toBe(503)
    } finally {
      if (prev !== undefined) process.env.SUPABASE_JWT_SECRET = prev
      resetEnvCacheForTest()
    }
  })
})
