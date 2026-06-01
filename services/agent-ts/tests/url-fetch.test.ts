/**
 * Smoke tests for `POST /v1/url/fetch`. The fetch pipeline itself
 * (SSRF gate, redirect handling, HTML extraction) is exhaustively
 * covered by the Next.js side's tests on `lib/server/url/fetch.ts`
 * — agent-ts just adds the Hono wrapper, so we only assert the
 * wrapper's contract: auth, validation, status mapping.
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

describe("POST /v1/url/fetch", () => {
  test("requires auth", async () => {
    const app = createApp()
    const res = await app.request("/v1/url/fetch", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    })
    expect(res.status).toBe(401)
  })

  test("rejects non-JSON body", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/url/fetch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "not json",
    })
    expect(res.status).toBe(400)
  })

  test("rejects schema-invalid body (missing url) with 422", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/url/fetch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(422)
  })

  test("rejects unparseable URL with 400 invalid_url", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/url/fetch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "::not::a::url::" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("invalid_url")
  })
})
