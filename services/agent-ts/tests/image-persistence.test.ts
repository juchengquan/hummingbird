/**
 * Tests for `buildToolImageInterceptor`. After a `generateImage`
 * tool result lands, the interceptor downloads + uploads each image
 * to Supabase Storage (or falls back to a data: URL) and emits a
 * `data-tool-image` AI SDK v5 custom data part. Other tools pass
 * through with no extra frames.
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
 *   - GET on a non-Supabase URL → returns FAKE_PNG bytes
 *   - POST .../storage/v1/object/<bucket>/<path>      → 200 (upload)
 *   - POST .../storage/v1/object/sign/<bucket>/<path> → 200 with signedURL
 *
 *  Returns the call log so tests can assert which paths were hit. */
function installFetchStub(
  opts: {
    uploadStatus?: number
    signStatus?: number
    signedUrl?: string
  } = {},
): FetchCall[] {
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
      contentType:
        typeof init?.headers === "object"
          ? (init.headers as Record<string, string>)["Content-Type"]
          : undefined,
    })

    if (method === "GET" && !url.includes(SUPABASE_URL)) {
      return new Response(FAKE_PNG, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    }
    if (url.includes("/storage/v1/object/sign/")) {
      return new Response(JSON.stringify({ signedURL: signedUrl }), {
        status: signStatus,
        headers: { "Content-Type": "application/json" },
      })
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

async function collectFrames(it: AsyncIterable<string>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const f of it) {
    const json = f.replace(/^data: /, "").trimEnd()
    out.push(JSON.parse(json))
  }
  return out
}

interface DataToolImageFrame {
  type: "data-tool-image"
  id: string
  data: {
    id: string
    mode: "t2i" | "i2i"
    images: Array<{
      id: string
      url: string
      storagePath?: string
      width: number
      height: number
      format: string
      prompt: string
      mode: "t2i" | "i2i"
    }>
  }
}

describe("buildToolImageInterceptor — gating", () => {
  test("passes through non-generateImage tool results", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-1",
      name: "webSearch",
      output: { results: [] },
    }
    const frames = await collectFrames(interceptor(frame))
    expect(frames).toEqual([])
  })

  test("skips when generateImage output is not ok", async () => {
    const interceptor = buildToolImageInterceptor({ userId: "u-1" })
    const frame: ToolResultFrame = {
      type: "tool_result",
      id: "call-2",
      name: "generateImage",
      output: { ok: false, error: "rate_limit" },
    }
    const frames = await collectFrames(interceptor(frame))
    expect(frames).toEqual([])
  })

  test("skips images with no url field", async () => {
    installFetchStub()
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
    const frames = await collectFrames(interceptor(frame))
    expect(frames).toEqual([])
  })
})

describe("buildToolImageInterceptor — happy paths", () => {
  test("uploads to Storage + emits data-tool-image with signed URL", async () => {
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
          {
            id: "x",
            url: "https://cdn.minimax/img1.png",
            width: 512,
            height: 512,
            format: "png",
          },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame))
    expect(frames).toHaveLength(1)
    const out = frames[0] as DataToolImageFrame
    expect(out.type).toBe("data-tool-image")
    expect(out.id).toBe("call-3")
    expect(out.data.id).toBe("call-3")
    expect(out.data.mode).toBe("t2i")
    expect(out.data.images).toHaveLength(1)
    expect(out.data.images[0]?.storagePath).toBe("u-1/generated/call-3-0.png")
    expect(out.data.images[0]?.url).toContain(SUPABASE_URL)
    expect(out.data.images[0]?.prompt).toBe("a cat")

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

  test("propagates i2i mode + prompt through to the emitted frame", async () => {
    installFetchStub()
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
          {
            id: "x",
            url: "https://cdn.minimax/img5.png",
            width: 1,
            height: 1,
            format: "png",
          },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame))
    const out = frames[0] as DataToolImageFrame
    expect(out.data.mode).toBe("i2i")
    expect(out.data.images[0]?.mode).toBe("i2i")
    expect(out.data.images[0]?.prompt).toBe("remix")
  })
})

describe("buildToolImageInterceptor — fallback paths", () => {
  test("data: URL when Storage upload fails", async () => {
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
          {
            id: "x",
            url: "https://cdn.minimax/img2.png",
            width: 1,
            height: 1,
            format: "png",
          },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame))
    const out = frames[0] as DataToolImageFrame
    expect(out.data.images[0]?.url.startsWith("data:image/png;base64,")).toBe(
      true,
    )
    expect(out.data.images[0]?.storagePath).toBeUndefined()
  })

  test("data: URL when userId is empty (signed-out caller)", async () => {
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
          {
            id: "x",
            url: "https://cdn.minimax/img3.png",
            width: 1,
            height: 1,
            format: "png",
          },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame))
    const out = frames[0] as DataToolImageFrame
    expect(out.data.images[0]?.url.startsWith("data:image/png;base64,")).toBe(
      true,
    )
    expect(out.data.images[0]?.storagePath).toBeUndefined()
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
          {
            id: "x",
            url: "https://cdn.minimax/img4.png",
            width: 1,
            height: 1,
            format: "png",
          },
        ],
      },
    }
    const frames = await collectFrames(interceptor(frame))
    const out = frames[0] as DataToolImageFrame
    expect(out.data.images[0]?.url.startsWith("data:image/png;base64,")).toBe(
      true,
    )
  })
})

describe("buildToolImageInterceptor — error paths", () => {
  beforeEach(() => {
    installFetchStub()
  })

  // The redundant subset that exercised the AI-SDK shape in a
  // separate `describe` is dropped — there's only one wire format
  // now, and every test in this file already asserts on it.
})
