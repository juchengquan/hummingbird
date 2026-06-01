/**
 * Tests for `POST /v1/summarize`. Wire validation only — the four
 * summariser modes call out to Anthropic, so the actual model call
 * is covered separately at the helper level by feeding a fake JSON
 * response through `stripJsonFences`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { SignJWT } from "jose"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"
import {
  isAnthropicModelId,
  resolveModel,
  stripJsonFences,
  DEFAULT_SUMMARY_MODEL,
} from "../src/summarise"

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

describe("summarise helpers", () => {
  test("isAnthropicModelId matches claude*", () => {
    expect(isAnthropicModelId("claude-3-5-haiku-20241022")).toBe(true)
    expect(isAnthropicModelId("claude-opus-4")).toBe(true)
    expect(isAnthropicModelId("google/gemini-2.5-flash")).toBe(false)
    expect(isAnthropicModelId("gpt-4o")).toBe(false)
  })

  test("resolveModel falls back to default for non-Anthropic", () => {
    expect(resolveModel("google/gemini-2.5-flash")).toBe(DEFAULT_SUMMARY_MODEL)
    expect(resolveModel(undefined)).toBe(DEFAULT_SUMMARY_MODEL)
    expect(resolveModel(null)).toBe(DEFAULT_SUMMARY_MODEL)
    expect(resolveModel("claude-3-5-sonnet")).toBe("claude-3-5-sonnet")
  })

  test("stripJsonFences removes ```json wrapping", () => {
    const wrapped = '```json\n{"summary": "x"}\n```'
    expect(stripJsonFences(wrapped)).toBe('{"summary": "x"}')
  })

  test("stripJsonFences removes plain ``` wrapping", () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test("stripJsonFences passes through unfenced JSON", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}')
  })
})

describe("POST /v1/summarize — validation", () => {
  test("requires auth", async () => {
    const app = createApp()
    const res = await app.request("/v1/summarize", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("rejects non-JSON body with 400", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "not json",
    })
    expect(res.status).toBe(400)
  })

  test("rejects unknown mode with 422", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "bogus" }),
    })
    expect(res.status).toBe(422)
  })

  test("file mode without text -> 422", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "file" }),
    })
    expect(res.status).toBe(422)
  })

  test("conversation mode without messages -> 422", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "conversation" }),
    })
    expect(res.status).toBe(422)
  })

  test("file mode with valid shape but no API key -> 502 provider error", async () => {
    delete process.env.ANTHROPIC_API_KEY
    resetEnvCacheForTest()
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "file", text: "hello" }),
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("provider")
  })
})
