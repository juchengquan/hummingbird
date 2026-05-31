/**
 * Phase 3 tests — `/v1/chat` text-only streaming.
 *
 * The AI SDK's `streamText` returns a real result; we'd rather not
 * call Anthropic from tests, so we drive the SSE formatters
 * (`chatStream`, `chatStreamAiSdk`) directly with a fake `LanguageModel`
 * that emits a canned stream. The route is exercised separately with
 * a short happy-path + the 503 + 422 paths.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { SignJWT } from "jose"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV2 } from "ai/test"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"
import {
  chatStream,
  chatStreamAiSdk,
  type ChatConfig,
} from "../src/chat"

const SECRET = "test-secret-do-not-use-in-prod-32-bytes!"

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET
  process.env.ANTHROPIC_API_KEY = "sk-test"
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.SUPABASE_JWT_SECRET
  delete process.env.ANTHROPIC_API_KEY
  resetEnvCacheForTest()
})

async function makeJwt(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ role: "authenticated", sub: "u", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET))
}

function makeModel(deltas: string[]): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          ...deltas.map((d) => ({
            type: "text-delta" as const,
            id: "t1",
            delta: d,
          })),
          { type: "text-end", id: "t1" },
          {
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        ],
      }),
    }),
  })
}

const baseConfig: ChatConfig = {
  model: "claude-3-5-haiku-20241022",
  messages: [{ role: "user", content: "hi" }],
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const f of gen) out.push(f)
  return out
}

function parseCustom(frames: string[]): Array<{ type: string } & Record<string, unknown>> {
  return frames.map((f) => JSON.parse(f.replace(/^data: /, "").trimEnd()))
}

function parseAiSdk(frames: string[]): Array<string | { type: string; [k: string]: unknown }> {
  return frames.map((f) => {
    const s = f.replace(/^data: /, "").trimEnd()
    return s === "[DONE]" ? "[DONE]" : JSON.parse(s)
  })
}

describe("chatStream — custom format", () => {
  test("emits text + done in order", async () => {
    const model = makeModel(["Hello", " world"])
    const frames = await collect(chatStream(model, baseConfig))
    const payloads = parseCustom(frames)
    expect(payloads).toEqual([
      { type: "text", value: "Hello" },
      { type: "text", value: " world" },
      { type: "done" },
    ])
  })

  test("text-delta with empty text is suppressed", async () => {
    const model = makeModel(["", "ok"])
    const frames = await collect(chatStream(model, baseConfig))
    const payloads = parseCustom(frames)
    const textFrames = payloads.filter((p) => p.type === "text")
    expect(textFrames).toEqual([{ type: "text", value: "ok" }])
  })
})

describe("chatStreamAiSdk — AI SDK v5 format", () => {
  test("full lifecycle (start → start-step → text-start → text-delta… → text-end → finish-step → finish → [DONE])", async () => {
    const model = makeModel(["A", "B"])
    const frames = await collect(chatStreamAiSdk(model, baseConfig))
    const payloads = parseAiSdk(frames)
    const types = payloads.map((p) => (typeof p === "string" ? p : p.type))
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
      "[DONE]",
    ])
    // text-delta carries the same id as text-start / text-end.
    const textStart = payloads[2] as unknown as { id: string }
    const textDelta0 = payloads[3] as unknown as { id: string; delta: string }
    expect(textDelta0.id).toBe(textStart.id)
    expect(textDelta0.delta).toBe("A")
  })
})

describe("POST /v1/chat — route surface", () => {
  test("rejects missing JWT", async () => {
    const app = createApp()
    const res = await app.request("/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(401)
  })

  test("rejects invalid format query", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/chat?format=bogus", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
    expect(res.status).toBe(422)
  })

  test("rejects empty messages", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/chat", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
    expect(res.status).toBe(422)
  })

  test("rejects invalid role", async () => {
    const app = createApp()
    const token = await makeJwt()
    const res = await app.request("/v1/chat", {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "system", content: "x" }],
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
    expect(res.status).toBe(422)
  })

  test("returns 503 when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY
    resetEnvCacheForTest()
    try {
      const app = createApp()
      const token = await makeJwt()
      const res = await app.request("/v1/chat", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          messages: [{ role: "user", content: "hi" }],
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      })
      expect(res.status).toBe(503)
    } finally {
      process.env.ANTHROPIC_API_KEY = "sk-test"
      resetEnvCacheForTest()
    }
  })
})
