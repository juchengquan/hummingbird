import { describe, expect, test } from "bun:test"

import { formatBodyLimit, jsonBodyError, readJsonCapped } from "./read-body-capped"

const URL_ = "http://localhost/api/x"

function jsonReq(body: string, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  })
}

function streamedReq(chunks: Uint8Array[]) {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
  return new Request(URL_, {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit)
}

describe("readJsonCapped", () => {
  test("parses JSON within the cap", async () => {
    expect(await readJsonCapped(jsonReq('{"a":1}'), 1024)).toEqual({ ok: true, value: { a: 1 } })
  })

  test("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"s":"héllo 日本"}')
    const res = await readJsonCapped(streamedReq([bytes.slice(0, 7), bytes.slice(7)]), 1024)
    expect(res).toEqual({ ok: true, value: { s: "héllo 日本" } })
  })

  test("invalid JSON → invalid_json", async () => {
    const res = await readJsonCapped(jsonReq("{nope"), 1024)
    expect(res).toMatchObject({ ok: false, reason: "invalid_json" })
  })

  test("declared Content-Length over the cap → too_large", async () => {
    const res = await readJsonCapped(jsonReq("{}", { "content-length": "999999" }), 1024)
    expect(res).toMatchObject({ ok: false, reason: "too_large", maxBytes: 1024 })
  })

  test("streamed body past the cap (no Content-Length) → too_large", async () => {
    const chunk = new Uint8Array(600).fill(0x20)
    const res = await readJsonCapped(streamedReq([chunk, chunk]), 1024)
    expect(res).toMatchObject({ ok: false, reason: "too_large" })
  })
})

describe("jsonBodyError", () => {
  test("too_large → 413 payload_too_large in the { code, message } envelope", async () => {
    const res = jsonBodyError({ ok: false, reason: "too_large", maxBytes: 256 * 1024 })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      code: "payload_too_large",
      message: "Request body exceeds 256 KB.",
    })
  })

  test("invalid_json → 400 invalid_request", async () => {
    const res = jsonBodyError({ ok: false, reason: "invalid_json", maxBytes: 1 })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("invalid_request")
  })

  test("formatBodyLimit", () => {
    expect(formatBodyLimit(16 * 1024)).toBe("16 KB")
    expect(formatBodyLimit(4 * 1024 * 1024)).toBe("4 MB")
  })
})
