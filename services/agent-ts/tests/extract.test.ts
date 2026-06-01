/**
 * Tests for `POST /v1/extract`. The extraction primitives themselves
 * (truncation budgets, kind classification) live in the shared
 * `lib/server/extraction.ts` — exercised directly here so we don't
 * have to feed binary blobs through the multipart parser on every
 * assertion.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { SignJWT } from "jose"

import { extractFile } from "@/server/extraction"

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

describe("extractFile() — kind classification", () => {
  test("plain text -> text", async () => {
    const result = await extractFile({
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello world", "utf-8"),
    })
    expect(result.kind).toBe("text")
    expect(result.text).toBe("hello world")
    expect(result.truncated).toBe(false)
  })

  test("markdown -> markdown", async () => {
    const result = await extractFile({
      name: "README.md",
      mimeType: "text/markdown",
      data: Buffer.from("# Title", "utf-8"),
    })
    expect(result.kind).toBe("markdown")
  })

  test("json by extension -> json", async () => {
    const result = await extractFile({
      name: "config.json",
      mimeType: "application/octet-stream",
      data: Buffer.from('{"a":1}', "utf-8"),
    })
    expect(result.kind).toBe("json")
  })

  test("code file -> code + language", async () => {
    const result = await extractFile({
      name: "server.ts",
      mimeType: "application/octet-stream",
      data: Buffer.from("export const x = 1", "utf-8"),
    })
    expect(result.kind).toBe("code")
    expect(result.language).toBe("typescript")
  })

  test("image -> image with empty text", async () => {
    const result = await extractFile({
      name: "logo.png",
      mimeType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })
    expect(result.kind).toBe("image")
    expect(result.text).toBe("")
    expect(result.truncated).toBe(false)
  })

  test("unknown -> unsupported", async () => {
    const result = await extractFile({
      name: "mystery.xyz",
      mimeType: "application/octet-stream",
      data: Buffer.from([0x00, 0x01, 0x02]),
    })
    expect(result.kind).toBe("unsupported")
  })

  test("HTML strips tags + script content", async () => {
    const html = `<html><body><script>alert(1)</script><p>Visible</p></body></html>`
    const result = await extractFile({
      name: "page.html",
      mimeType: "text/html",
      data: Buffer.from(html, "utf-8"),
    })
    expect(result.kind).toBe("html")
    expect(result.text).toContain("Visible")
    expect(result.text).not.toContain("alert")
  })

  test("large text triggers truncation + fullText", async () => {
    // 200 KB — past the 100 KB inline budget but under the 1 MB full
    // budget, so we expect both fields set and distinct.
    const huge = "a".repeat(200 * 1024)
    const result = await extractFile({
      name: "big.txt",
      mimeType: "text/plain",
      data: Buffer.from(huge, "utf-8"),
    })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(100 * 1024)
    expect(result.fullText?.length).toBe(200 * 1024)
  })
})

describe("POST /v1/extract — route", () => {
  test("requires auth", async () => {
    const app = createApp()
    const res = await app.request("/v1/extract", { method: "POST" })
    expect(res.status).toBe(401)
  })

  test("rejects non-multipart body", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/extract", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(400)
  })

  test("rejects multipart without file field", async () => {
    const app = createApp()
    const token = await makeJwt()
    const form = new FormData()
    form.append("not_file", "hello")
    const res = await app.request("/v1/extract", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(400)
  })

  test("extracts a small text file", async () => {
    const app = createApp()
    const token = await makeJwt()
    const form = new FormData()
    form.append("file", new Blob(["hello world"], { type: "text/plain" }), "notes.txt")
    const res = await app.request("/v1/extract", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kind: string
      text: string
      truncated: boolean
    }
    expect(body.kind).toBe("text")
    expect(body.text).toBe("hello world")
    expect(body.truncated).toBe(false)
  })
})
