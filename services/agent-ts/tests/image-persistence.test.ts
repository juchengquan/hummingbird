/**
 * Follow-up #5 tests — `image-persistence.ts`.
 *
 * The `buildToolImageInterceptor` is meant to fire after a
 * `generateImage` tool result and emit a `tool_image` SSE frame.
 * We exercise the interceptor directly with synthetic
 * `ToolResultFrame` inputs and a mocked global `fetch` to simulate
 * Minimax download + Supabase Storage upload + sign.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test"

import { resetEnvCacheForTest } from "../src/env"
import { buildToolImageInterceptor } from "../src/image-persistence"
import type { ToolResultFrame } from "../src/chat"

const SUPABASE_URL = "https://example.supabase.co"
const SERVICE_KEY = "service-role-test-key"
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const originalFetch = globalThis.fetch

beforeAll(() => {
  process.env.SUPABASE_URL = SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  resetEnvCacheForTest()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

interface FetchCall {
  url: string
  method: string
  contentType?: string
}

/** Install a fetch stub that:
 *   - GET on a Minimax-shaped URL → returns FAKE_PNG bytes
 *   - POST .../storage/v1/object/<bucket>/<path>      → 200 (upload)
 *   - POST .../storage/v1/object/sign/<bucket>/<path> → 200 with signedURL
 *
 *  Returns the call log so tests can assert which paths were hit. */
function installFetchStub(opts: {
  uploadStatus?: number
  signStatus?: number
  signedUrl?: string
} = {}): FetchCall[] {
  const log: FetchCall[] = []
  const uploadStatus = opts.uploadStatus ?? 200
  const signStatus = opts.signStatus ?? 200
  const signedUrl = opts.signedUrl ?? "/object/sign/path?token=abc"

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input.toString()
    const method = init?.method ?? "GET"
    log.push({
      url,
      method,
      contentType: typeof init?.headers === "object"
        ? (init.headers as Record<string, string>)["Content-Type"]
        : undefined,
    })

    // Minimax download — anything pointing at `cdn.minimax.io` / arbitrary
    // external URL that isn't our Supabase URL.
    if (method === "GET" && !url.includes(SUPABASE_URL)) {
      return new Response(FAKE_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    }

    if (url.includes("/storage/v1/object/sign/")) {
      return new Response(
        JSON.stringify({ signedURL: signedUrl }),
        {
          status: signStatus,
          headers: { "Content-Type": "application/json" },
        },
      )
    }

    if (url.includes("/storage/v1/object/")) {
      return new Response(JSON.stringify({ Key: "x" }), {
        status: uploadStatus,
        headers: { "Content-Type": "application/json" },
      })
    }

    return new Response("not stubbed", { status: 500 })
  }) as typeof fetch

  return log
}

async function collectFrames(
  it: AsyncIterable<string>,
): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const f of it) {
    const json = f.replace(/^data: /, "").trimEnd()
    out.push(JSON.parse(json))
  }
  return out
}

describe("buildToolImageInterceptor", () => {
  test("passes through non-generateImage tool results", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-1",
      name: "webSearch",
      output: { results: [] },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    expect(frames).toEqual([])
  })

  test("skips when the generateImage output is not ok", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-2",
      name: "generateImage",
      output: { ok: false, error: "rate_limit" },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    expect(frames).toEqual([])
  })

  test("uploads to Storage + emits tool_image frame on success", async () => {
    const log = installFetchStub()
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-3",
      name: "generateImage",
      output: {
        ok: true,
        mode: "t2i",
        prompt: "a cat",
        images: [
          { id: "x", url: "https://cdn.minimax/img1.png", width: 512, height: 512, format: "png" },
        ],
      },
    }

    const frames = await collectFrames(interceptor(frame, "custom"))
    expect(frames).toHaveLength(1)
    const out = frames[0] as {
      type: string
      id: string
      mode: string
      images: Array<{
        id: string
        url: string
        storagePath?: string
        width: number
        height: number
        format: string
        prompt: string
      }>
    }
    expect(out.type).toBe("tool_image")
    expect(out.id).toBe("call-3")
    expect(out.mode).toBe("t2i")
    expect(out.images).toHaveLength(1)
    expect(out.images[0]?.storagePath).toBe("u-1/generated/call-3-0.png")
    expect(out.images[0]?.url).toContain(SUPABASE_URL)
    expect(out.images[0]?.prompt).toBe("a cat")

    // Hit order: GET Minimax, POST upload, POST sign.
    const minimaxGets = log.filter((c) => c.method === "GET")
    const storageUploads = log.filter(
      (c) => c.method === "POST" && c.url.includes("/object/user-files/"),
    )
    const storageSigns = log.filter(
      (c) => c.method === "POST" && c.url.includes("/object/sign/"),
    )
    expect(minimaxGets).toHaveLength(1)
    expect(storageUploads).toHaveLength(1)
    expect(storageSigns).toHaveLength(1)
  })

  test("falls back to data: URL when Storage upload fails", async () => {
    installFetchStub({ uploadStatus: 500 })
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-4",
      name: "generateImage",
      output: {
        ok: true,
        mode: "t2i",
        prompt: "a dog",
        images: [
          { id: "x", url: "https://cdn.minimax/img2.png", width: 1, height: 1, format: "png" },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    const out = frames[0] as {
      images: Array<{ url: string; storagePath?: string }>
    }
    expect(out.images[0]?.url.startsWith("data:image/png;base64,")).toBe(true)
    expect(out.images[0]?.storagePath).toBeUndefined()
  })

  test("inline data: URL when userId is empty (signed-out caller)", async () => {
    installFetchStub()
    const interceptor = buildToolImageInterceptor({ userId: "" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-5",
      name: "generateImage",
      output: {
        ok: true,
        mode: "t2i",
        images: [
          { id: "x", url: "https://cdn.minimax/img3.png", width: 1, height: 1, format: "png" },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    const out = frames[0] as {
      images: Array<{ url: string; storagePath?: string }>
    }
    expect(out.images[0]?.url.startsWith("data:image/png;base64,")).toBe(true)
    expect(out.images[0]?.storagePath).toBeUndefined()
  })

  test("localFilesOnly forces data: URL even when authenticated", async () => {
    installFetchStub()
    const interceptor = buildToolImageInterceptor({
      userId: "u-1",
      localFilesOnly: true,
    })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-6",
      name: "generateImage",
      output: {
        ok: true,
        images: [
          { id: "x", url: "https://cdn.minimax/img4.png", width: 1, height: 1, format: "png" },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    const out = frames[0] as { images: Array<{ url: string }> }
    expect(out.images[0]?.url.startsWith("data:image/png;base64,")).toBe(true)
  })
})

describe("buildToolImageInterceptor — error paths", () => {
  beforeEach(() => {
    installFetchStub()
  })

  test("skips images with no url field", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-7",
      name: "generateImage",
      output: {
        ok: true,
        images: [{ id: "x", width: 1, height: 1, format: "png" }],
      },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    expect(frames).toEqual([])
  })

  test("propagates i2i mode tag through to the emitted frame", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-8",
      name: "generateImage",
      output: {
        ok: true,
        mode: "i2i",
        prompt: "remix",
        images: [
          { id: "x", url: "https://cdn.minimax/img5.png", width: 1, height: 1, format: "png" },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame, "custom"))
    const out = frames[0] as {
      mode: string
      images: Array<{ mode: string; prompt: string }>
    }
    expect(out.mode).toBe("i2i")
    expect(out.images[0]?.mode).toBe("i2i")
    expect(out.images[0]?.prompt).toBe("remix")
  })
})

describe("buildToolImageInterceptor — AI SDK format (B.1)", () => {
  test("emits data-tool-image part with {id, mode, images} payload", async () => {
    installFetchStub()
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-ai-1",
      name: "generateImage",
      output: {
        ok: true,
        mode: "t2i",
        prompt: "a bird",
        images: [
          { id: "x", url: "https://cdn.minimax/img.png", width: 512, height: 512, format: "png" },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame, "ai-sdk"))
    expect(frames).toHaveLength(1)
    const out = frames[0] as {
      type: string
      id: string
      data: { id: string; mode: string; images: Array<{ id: string; url: string }> }
    }
    expect(out.type).toBe("data-tool-image")
    expect(out.id).toBe("call-ai-1")
    expect(out.data.mode).toBe("t2i")
    expect(out.data.images).toHaveLength(1)
    expect(out.data.images[0]?.url).toContain(SUPABASE_URL)
  })

  test("ai-sdk format ignores non-generateImage tool results", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-ws",
      name: "webSearch",
      output: { results: [] },
    }
    const frames = await collectFrames(interceptor(frame, "ai-sdk"))
    expect(frames).toEqual([])
  })

  test("ai-sdk format skips when ok:false (same gate as custom)", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-bad",
      name: "generateImage",
      output: { ok: false, error: "rate_limit" },
    }
    const frames = await collectFrames(interceptor(frame, "ai-sdk"))
    expect(frames).toEqual([])
  })
})
