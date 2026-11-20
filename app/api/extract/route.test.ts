import { deflateRawSync } from "node:zlib"

import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { setAiAuthScenario } from "@/server/auth/_test/ai-auth-scenario"

import { EXTRACT_BODY_MAX, extractCacheKey, extractTextLimit, POST } from "./route"

describe("extract cache key", () => {
  test("vision flag changes the key", () => {
    const base = { name: "a.pdf", mimeType: "application/pdf", contentHash: "abc" }
    expect(extractCacheKey({ ...base, vision: true })).not.toBe(
      extractCacheKey({ ...base, vision: false })
    )
  })
  test("same inputs → same key", () => {
    const a = { name: "a.pdf", mimeType: "application/pdf", contentHash: "abc", vision: true }
    expect(extractCacheKey(a)).toBe(extractCacheKey({ ...a }))
  })
})

const URL_ = "http://localhost/api/extract"

function multipart(file: Blob, name: string): NextRequest {
  const form = new FormData()
  form.append("file", file, name)
  return new NextRequest(URL_, { method: "POST", body: form })
}

function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string>) {
  return new NextRequest(URL_, {
    method: "POST",
    body,
    headers: { "content-type": "multipart/form-data; boundary=x", ...headers },
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1])
}

describe("POST /api/extract size caps", () => {
  test("a small text file extracts (200)", async () => {
    const res = await POST(multipart(new Blob(["hello"], { type: "text/plain" }), "a.txt"))
    expect(res.status).toBe(200)
    expect((await res.json()).text).toContain("hello")
  })

  test("Content-Length over the cap → 413 without reading the body", async () => {
    let pulled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true
        },
      },
      { highWaterMark: 0 } // no eager pre-fill pull
    )
    const res = await POST(streamed(body, { "content-length": String(EXTRACT_BODY_MAX + 1) }))
    expect(res.status).toBe(413)
    expect(pulled).toBe(false)
  })

  test("a streamed body with no Content-Length is cut off at the cap → 413", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless stream — the route must stop pulling once past the cap.
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const res = await POST(streamed(body, {}))
    expect(res.status).toBe(413)
    expect(sent).toBeLessThanOrEqual(EXTRACT_BODY_MAX + 4 * chunk.byteLength)
  })

  test("a 6 MB upload → 413", async () => {
    const big = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "text/plain" })
    expect((await POST(multipart(big, "big.txt"))).status).toBe(413)
  })

  test("a zip-bomb docx → 413 (zip guard), not 500", async () => {
    // One deflated entry of 4 KB zeros whose headers claim 200 MB.
    const name = Buffer.from("word/document.xml")
    const data = deflateRawSync(Buffer.alloc(4096))
    const declared = 200 * 1024 * 1024
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(8, 8)
    lfh.writeUInt32LE(data.length, 18)
    lfh.writeUInt32LE(declared, 22)
    lfh.writeUInt16LE(name.length, 26)
    const cdh = Buffer.alloc(46)
    cdh.writeUInt32LE(0x02014b50, 0)
    cdh.writeUInt16LE(8, 10)
    cdh.writeUInt32LE(data.length, 20)
    cdh.writeUInt32LE(declared, 24)
    cdh.writeUInt16LE(name.length, 28)
    const cdOffset = 30 + name.length + data.length
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(46 + name.length, 12)
    eocd.writeUInt32LE(cdOffset, 16)
    const zip = Buffer.concat([lfh, name, data, cdh, name, eocd])
    const res = await POST(multipart(new Blob([zip]), "bomb.docx"))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/extraction limit/)
  })
})

describe("POST /api/extract — per-IP rate limit", () => {
  afterEach(() => extractTextLimit._reset())

  test("past the per-minute cap → 429 with Retry-After, before reading the body", async () => {
    extractTextLimit._reset()
    const fromIp = () => {
      const form = new FormData()
      form.append("file", new Blob(["x"], { type: "text/plain" }), "a.txt")
      return new NextRequest(URL_, {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "203.0.113.9" },
      })
    }
    for (let i = 0; i < 60; i++) expect((await POST(fromIp())).status).toBe(200)
    const res = await POST(fromIp())
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    expect((await res.json()).error).toMatch(/Too many/)
  })
})

describe("POST /api/extract — REQUIRE_AUTH_FOR_AI", () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    restore?.()
    restore = null
  })

  // Text extraction spends no model budget, so an anonymous caller is
  // never 401'd here — the gate only forces the vision pass off.
  test("flag on + anonymous → text extraction still answers 200", async () => {
    restore = setAiAuthScenario("anonymous")
    const form = new FormData()
    form.append("file", new Blob(["anon text"], { type: "text/plain" }), "anon.txt")
    form.append("vision", "true")
    const res = await POST(new NextRequest(URL_, { method: "POST", body: form }))
    expect(res.status).toBe(200)
    expect((await res.json()).text).toContain("anon text")
  })
})
