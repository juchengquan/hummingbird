import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  __test,
  minimaxGenerateImage,
} from "./minimax-image-client"

const { extractImageUrls, mapMinimaxStatusCode } = __test

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_KEY = process.env.MINIMAX_CN_API_KEY

beforeEach(() => {
  process.env.MINIMAX_CN_API_KEY = "test-key"
})
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_KEY === undefined) delete process.env.MINIMAX_CN_API_KEY
  else process.env.MINIMAX_CN_API_KEY = ORIGINAL_KEY
})

// --- mapMinimaxStatusCode --------------------------------------------------

describe("mapMinimaxStatusCode", () => {
  test("known auth codes → 'auth'", () => {
    expect(mapMinimaxStatusCode(1004)).toBe("auth")
    expect(mapMinimaxStatusCode(1008)).toBe("auth")
  })
  test("known rate-limit codes → 'rate_limit'", () => {
    expect(mapMinimaxStatusCode(1013)).toBe("rate_limit")
    expect(mapMinimaxStatusCode(1039)).toBe("rate_limit")
  })
  test("known content-policy codes → 'content_policy'", () => {
    expect(mapMinimaxStatusCode(2013)).toBe("content_policy")
    expect(mapMinimaxStatusCode(2049)).toBe("content_policy")
  })
  test("known validation codes → 'validation'", () => {
    expect(mapMinimaxStatusCode(1002)).toBe("validation")
    expect(mapMinimaxStatusCode(2032)).toBe("validation")
  })
  test("unknown codes → 'upstream' (so status_msg gets surfaced)", () => {
    expect(mapMinimaxStatusCode(9999)).toBe("upstream")
    expect(mapMinimaxStatusCode(0)).toBe("upstream") // 0 means success; shouldn't be passed here, but safe fallback
  })
})

// --- extractImageUrls ------------------------------------------------------

describe("extractImageUrls", () => {
  test("documented shape: data.image_urls", () => {
    const out = extractImageUrls({ data: { image_urls: ["a", "b", "c"] } })
    expect(out).toEqual(["a", "b", "c"])
  })

  test("alternate shape: data.images[].url", () => {
    const out = extractImageUrls({
      data: { images: [{ url: "a" }, { url: "b" }] },
    })
    expect(out).toEqual(["a", "b"])
  })

  test("alternate shape: data.images[].image_url", () => {
    const out = extractImageUrls({
      data: { images: [{ image_url: "a" }] },
    })
    expect(out).toEqual(["a"])
  })

  test("missing data → empty", () => {
    expect(extractImageUrls({})).toEqual([])
  })

  test("missing image fields → empty", () => {
    expect(extractImageUrls({ data: {} })).toEqual([])
  })

  test("non-string entries get filtered out", () => {
    const out = extractImageUrls({
      data: { image_urls: ["ok", 42 as unknown as string, null as unknown as string, "ok2"] },
    })
    expect(out).toEqual(["ok", "ok2"])
  })
})

// --- minimaxGenerateImage (mocked fetch) -----------------------------------

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof fetch
}

describe("minimaxGenerateImage", () => {
  test("missing env returns 'auth' before any network call", async () => {
    delete process.env.MINIMAX_CN_API_KEY
    let called = false
    mockFetch(async () => {
      called = true
      return new Response("", { status: 200 })
    })
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("auth")
    expect(called).toBe(false)
  })

  test("success path: 200 + base_resp.status_code 0 + image_urls", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: { image_urls: ["https://cdn/a", "https://cdn/b"] },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 2,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.images.length).toBe(2)
      expect(res.images[0].url).toBe("https://cdn/a")
      expect(res.images[0].format).toBe("png")
    }
  })

  test("HTTP 401 → 'auth'", async () => {
    mockFetch(async () => new Response("", { status: 401 }))
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("auth")
  })

  test("HTTP 429 → 'rate_limit'", async () => {
    mockFetch(async () => new Response("", { status: 429 }))
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("rate_limit")
  })

  test("HTTP 500 → 'upstream'", async () => {
    mockFetch(async () => new Response("", { status: 500 }))
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("upstream")
  })

  test("base_resp.status_code 2013 → 'content_policy'", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          base_resp: { status_code: 2013, status_msg: "Prompt rejected" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe("content_policy")
      expect(res.message).toContain("Prompt rejected")
    }
  })

  test("success but no image URLs → 'upstream'", async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          data: {},
          base_resp: { status_code: 0, status_msg: "ok" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("upstream")
  })

  test("T2I request body does NOT include subject_reference", async () => {
    let capturedBody = ""
    mockFetch(async (_input, init) => {
      capturedBody = String(init?.body ?? "")
      return new Response(
        JSON.stringify({
          data: { image_urls: ["x"] },
          base_resp: { status_code: 0, status_msg: "ok" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    })
    await minimaxGenerateImage({
      prompt: "a cat",
      aspectRatio: "1:1",
      count: 1,
    })
    expect(capturedBody).not.toContain("subject_reference")
    expect(capturedBody).toContain("\"prompt\":\"a cat\"")
    expect(capturedBody).toContain("\"model\":\"image-01\"")
    expect(capturedBody).toContain("\"response_format\":\"url\"")
  })

  test("I2I request body includes subject_reference with type: character", async () => {
    let capturedBody = ""
    mockFetch(async (_input, init) => {
      capturedBody = String(init?.body ?? "")
      return new Response(
        JSON.stringify({
          data: { image_urls: ["x"] },
          base_resp: { status_code: 0, status_msg: "ok" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    })
    await minimaxGenerateImage({
      prompt: "a cat",
      aspectRatio: "1:1",
      count: 1,
      referenceImageUrl: "https://example.com/ref.jpg",
    })
    expect(capturedBody).toContain("subject_reference")
    expect(capturedBody).toContain("\"type\":\"character\"")
    expect(capturedBody).toContain("https://example.com/ref.jpg")
  })

  test("abort signal yields 'network' error with timeout-like message", async () => {
    mockFetch(async (_input, init) => {
      // Simulate abort by throwing AbortError when signal is aborted.
      const sig = init?.signal as AbortSignal | undefined
      if (sig?.aborted) {
        const err = new Error("aborted")
        err.name = "AbortError"
        throw err
      }
      return new Response("", { status: 200 })
    })
    const upstream = new AbortController()
    upstream.abort()
    const res = await minimaxGenerateImage({
      prompt: "x",
      aspectRatio: "1:1",
      count: 1,
      signal: upstream.signal,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe("network")
  })
})
