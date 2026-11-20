import { afterEach, describe, expect, test } from "bun:test"

import { fetchUrlBookmark, fetchUrlDeps } from "./fetch"

const saved = { ...fetchUrlDeps }
afterEach(() => Object.assign(fetchUrlDeps, saved))

/** Skip DNS / SSRF validation: every URL is "public". */
function allowAll() {
  fetchUrlDeps.validate = (async (raw: string) => ({
    ok: true,
    url: new URL(raw),
  })) as unknown as typeof fetchUrlDeps.validate
}

/** A response whose headers arrive at once but whose body sends one
 *  chunk and then stalls until the request is aborted. */
function stallingResponse(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<html><title>x</title>"))
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted.", "AbortError"))
      })
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } })
}

describe("fetchUrlBookmark — body read failures", () => {
  test("timeout while reading the body → structured timeout (route maps it to 408)", async () => {
    allowAll()
    fetchUrlDeps.timeoutMs = 50
    fetchUrlDeps.fetch = async (_url, init) => stallingResponse(init.signal)
    const result = await fetchUrlBookmark("https://example.com/slow")
    expect(result).toEqual({
      ok: false,
      error: { code: "timeout", message: expect.stringContaining("timed out") },
    })
  })

  test("connection error mid-body → structured network error, not a throw", async () => {
    allowAll()
    fetchUrlDeps.fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([60]))
          controller.error(new TypeError("socket hang up"))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } })
    }
    const result = await fetchUrlBookmark("https://example.com/broken")
    expect(result).toMatchObject({ ok: false, error: { code: "network" } })
  })

  test("a normal page still extracts", async () => {
    allowAll()
    fetchUrlDeps.fetch = async () =>
      new Response("<html><head><title>Hi</title></head><body><p>Body text</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    const result = await fetchUrlBookmark("https://example.com/")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.snapshot.title).toBe("Hi")
      expect(result.snapshot.content).toContain("Body text")
    }
  })
})
