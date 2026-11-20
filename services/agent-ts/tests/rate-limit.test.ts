/**
 * Rate-limit key derivation — must match the Next.js semantics in
 * `lib/server/rate-limit.ts`: the client IP is read from the RIGHT of
 * `X-Forwarded-For` (`TRUSTED_PROXY_HOPS`, default 1), so a client
 * can't dodge the limiter by sending a forged left-most entry.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { Hono } from "hono"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"
import { rateLimitKey } from "../src/rate-limit"
import { _resetUrlFetchLimitForTest } from "../src/routes/url-fetch"

const SECRET = "test-secret-do-not-use-in-prod-32-bytes!"

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_JWT_SECRET
  resetEnvCacheForTest()
})

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS
  _resetUrlFetchLimitForTest()
})

async function keyFor(headers: Record<string, string>): Promise<string> {
  const app = new Hono()
  app.get("/", (c) => c.text(rateLimitKey(c)))
  const res = await app.request("/", { headers })
  return res.text()
}

describe("rateLimitKey", () => {
  test("uses the right-most X-Forwarded-For entry by default", async () => {
    expect(await keyFor({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" })).toBe(
      "203.0.113.7",
    )
  })

  test("a forged left-most entry does not change the key", async () => {
    const a = await keyFor({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" })
    const b = await keyFor({ "x-forwarded-for": "2.2.2.2, 203.0.113.7" })
    expect(a).toBe(b)
  })

  test("TRUSTED_PROXY_HOPS=2 reads the second entry from the right", async () => {
    process.env.TRUSTED_PROXY_HOPS = "2"
    expect(
      await keyFor({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }),
    ).toBe("203.0.113.7")
  })

  test("TRUSTED_PROXY_HOPS=0 ignores X-Forwarded-For entirely", async () => {
    process.env.TRUSTED_PROXY_HOPS = "0"
    expect(await keyFor({ "x-forwarded-for": "203.0.113.7" })).toBe("default")
  })

  test("no header → shared default bucket", async () => {
    expect(await keyFor({})).toBe("default")
  })

  test("x-real-ip is not trusted off-platform", async () => {
    expect(
      await keyFor({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "203.0.113.7" }),
    ).toBe("203.0.113.7")
  })
})

describe("POST /v1/url/fetch rate limit", () => {
  test("rotating a spoofed X-Forwarded-For prefix still hits 429", async () => {
    const app = createApp()
    const token = await new SignJWT({
      sub: "00000000-0000-4000-8000-000000000123",
      role: "authenticated",
      aud: "authenticated",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET))

    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const res = await app.request("/v1/url/fetch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          // Left entry rotates per request (attacker-controlled); the
          // proxy-appended right entry is stable.
          "X-Forwarded-For": `10.0.${i}.1, 203.0.113.50`,
        },
        // Unparseable URL → 400 without any network I/O.
        body: JSON.stringify({ url: "::not::a::url::" }),
      })
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})
