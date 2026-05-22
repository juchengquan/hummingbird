import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { persistGeneratedImages } from "./image-storage"

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof fetch
}

/** Encode a tiny 1×1 PNG as raw bytes for the mock to return. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 12, 73,
  68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
])

describe("persistGeneratedImages", () => {
  test("empty input → empty output", async () => {
    const r = await persistGeneratedImages([])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.images).toEqual([])
  })

  test("downloads + encodes as data URL with the response's MIME", async () => {
    mockFetch(async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    )
    const r = await persistGeneratedImages([
      { url: "https://cdn/img.png", width: 1, height: 1, format: "png" },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.images.length).toBe(1)
      expect(r.images[0].url.startsWith("data:image/png;base64,")).toBe(true)
      expect(r.images[0].format).toBe("png")
      expect(r.images[0].width).toBe(1)
    }
  })

  test("uses response Content-Type over the input format hint", async () => {
    mockFetch(async () =>
      new Response(TINY_PNG, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    )
    const r = await persistGeneratedImages([
      // Input says "png" but server returns JPEG headers — trust the server.
      { url: "https://cdn/img", width: 1, height: 1, format: "png" },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.images[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
      // "image/jpeg" gets canonicalised to "jpg" on the format field.
      expect(r.images[0].format).toBe("jpg")
    }
  })

  test("rejects oversize responses via Content-Length header", async () => {
    mockFetch(async () =>
      new Response("", {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(10 * 1024 * 1024),
        },
      })
    )
    const r = await persistGeneratedImages([
      { url: "https://cdn/huge.png", width: 0, height: 0, format: "png" },
    ])
    // Only one image failed; persistGeneratedImages returns ok:false
    // when ALL fail. With a single input that's the same thing.
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("image too large")
  })

  test("HTTP 4xx → that image drops out; others succeed", async () => {
    let call = 0
    mockFetch(async () => {
      call += 1
      if (call === 1) return new Response("", { status: 404 })
      return new Response(TINY_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    })
    const r = await persistGeneratedImages([
      { url: "https://cdn/missing.png", width: 1, height: 1, format: "png" },
      { url: "https://cdn/ok.png", width: 1, height: 1, format: "png" },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.images.length).toBe(1)
  })

  test("all-fail → ok:false with first error", async () => {
    mockFetch(async () => new Response("", { status: 500 }))
    const r = await persistGeneratedImages([
      { url: "https://cdn/a", width: 1, height: 1, format: "png" },
      { url: "https://cdn/b", width: 1, height: 1, format: "png" },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("HTTP 500")
  })

  test("aborts on upstream signal", async () => {
    mockFetch(async (_input, init) => {
      const sig = init?.signal as AbortSignal | undefined
      if (sig?.aborted) {
        const err = new Error("aborted")
        err.name = "AbortError"
        throw err
      }
      return new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } })
    })
    const upstream = new AbortController()
    upstream.abort()
    const r = await persistGeneratedImages(
      [{ url: "https://cdn/a", width: 1, height: 1, format: "png" }],
      { signal: upstream.signal }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/abort|timed out/i)
  })
})
