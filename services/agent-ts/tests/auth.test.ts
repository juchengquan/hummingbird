/**
 * JWT middleware tests. Mirrors agent-py's `test_auth.py` — the failure
 * shapes here are the contract every route depends on. A validly
 * signed token is NOT enough: the legacy Supabase anon key is exactly
 * such a token (role `anon`, no `sub`) and ships in the browser bundle.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"

const SECRET = "test-secret-do-not-use-in-prod-32-bytes!"
const USER_ID = "6f1c2a4e-8b3d-4f0a-9c1e-2d3b4a5c6d7e"

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_JWT_SECRET
  resetEnvCacheForTest()
})

/** A valid Supabase user access token; `claims` override, and a value
 *  of `undefined` drops that claim. `exp: false` omits expiry. */
async function makeJwt(
  claims: Record<string, unknown> = {},
  { secret = SECRET, exp = "1h" as string | number | false } = {},
): Promise<string> {
  const merged: Record<string, unknown> = {
    sub: USER_ID,
    role: "authenticated",
    aud: "authenticated",
    ...claims,
  }
  const payload = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  )
  let jwt = new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt()
  if (exp !== false) jwt = jwt.setExpirationTime(exp)
  return jwt.sign(new TextEncoder().encode(secret))
}

async function whoami(token: string): Promise<Response> {
  return createApp().request("/v1/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe("/v1/whoami auth", () => {
  test("returns claims with a valid token", async () => {
    const res = await whoami(await makeJwt())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user_id: string | null; role: string | null }
    expect(body).toEqual({ user_id: USER_ID, role: "authenticated" })
  })

  test("rejects missing header with 401 + WWW-Authenticate", async () => {
    const res = await createApp().request("/v1/whoami")
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
  })

  test("rejects non-bearer scheme", async () => {
    const res = await createApp().request("/v1/whoami", {
      headers: { Authorization: "Basic abc==" },
    })
    expect(res.status).toBe(401)
  })

  test("rejects garbage token", async () => {
    expect((await whoami("not-a-jwt")).status).toBe(401)
  })

  test("rejects token signed with a different secret", async () => {
    const wrong = await makeJwt({}, { secret: "different-secret-also-32-bytes-long!" })
    expect((await whoami(wrong)).status).toBe(401)
  })

  test("rejects expired token", async () => {
    const expired = await makeJwt({}, { exp: Math.floor(Date.now() / 1000) - 60 })
    expect((await whoami(expired)).status).toBe(401)
  })

  test("rejects token without exp", async () => {
    expect((await whoami(await makeJwt({}, { exp: false }))).status).toBe(401)
  })

  test("rejects the legacy anon-key shape (role anon, no sub, no aud)", async () => {
    const anon = await makeJwt({
      role: "anon",
      sub: undefined,
      aud: undefined,
      iss: "supabase",
    })
    expect((await whoami(anon)).status).toBe(401)
  })

  test("rejects anon role even with sub + aud", async () => {
    expect((await whoami(await makeJwt({ role: "anon" }))).status).toBe(401)
  })

  test("rejects service_role tokens on user endpoints", async () => {
    expect((await whoami(await makeJwt({ role: "service_role" }))).status).toBe(401)
  })

  test("rejects missing role", async () => {
    expect((await whoami(await makeJwt({ role: undefined }))).status).toBe(401)
  })

  test("rejects missing sub", async () => {
    expect((await whoami(await makeJwt({ sub: undefined }))).status).toBe(401)
  })

  test("rejects non-UUID sub", async () => {
    expect((await whoami(await makeJwt({ sub: "user-123" }))).status).toBe(401)
  })

  test("rejects missing aud", async () => {
    expect((await whoami(await makeJwt({ aud: undefined }))).status).toBe(401)
  })

  test("rejects wrong aud", async () => {
    expect((await whoami(await makeJwt({ aud: "something-else" }))).status).toBe(401)
  })

  test("401 body is generic — no verifier error text", async () => {
    for (const token of [
      await makeJwt({ aud: "nope" }),
      await makeJwt({ role: "anon" }),
      "not-a-jwt",
    ]) {
      const res = await whoami(token)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ code: "auth", message: "Invalid token." })
    }
  })

  test("audience is configurable via SUPABASE_JWT_AUDIENCE", async () => {
    try {
      process.env.SUPABASE_JWT_AUDIENCE = "custom-aud"
      resetEnvCacheForTest()
      expect((await whoami(await makeJwt({ aud: "custom-aud" }))).status).toBe(200)
      expect((await whoami(await makeJwt())).status).toBe(401)
    } finally {
      delete process.env.SUPABASE_JWT_AUDIENCE
      resetEnvCacheForTest()
    }
  })

  test("returns 503 when SUPABASE_JWT_SECRET is unset", async () => {
    const prev = process.env.SUPABASE_JWT_SECRET
    try {
      delete process.env.SUPABASE_JWT_SECRET
      resetEnvCacheForTest()
      // Even an otherwise-valid header should yield 503 — the misconfig
      // dominates.
      const res = await createApp().request("/v1/whoami", {
        headers: { Authorization: "Bearer anything" },
      })
      expect(res.status).toBe(503)
    } finally {
      if (prev !== undefined) process.env.SUPABASE_JWT_SECRET = prev
      resetEnvCacheForTest()
    }
  })
})
