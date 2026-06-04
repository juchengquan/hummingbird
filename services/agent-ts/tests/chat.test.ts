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
import { APICallError, simulateReadableStream } from "ai"
import { MockLanguageModelV2 } from "ai/test"

import { createApp } from "../src/app"
import { resetEnvCacheForTest } from "../src/env"
import {
  categorizeProviderError,
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


function parseAiSdk(frames: string[]): Array<string | { type: string; [k: string]: unknown }> {
  return frames.map((f) => {
    const s = f.replace(/^data: /, "").trimEnd()
    return s === "[DONE]" ? "[DONE]" : JSON.parse(s)
  })
}

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

/** Mock model that emits a reasoning block then a text block.
 *  Mirrors what Anthropic's extended-thinking models stream. */
function makeReasoningThenTextModel(opts: {
  reasoning: string[]
  text: string[]
}): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          ...opts.reasoning.map((d) => ({
            type: "reasoning-delta" as const,
            id: "r1",
            delta: d,
          })),
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          ...opts.text.map((d) => ({
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

describe("chatStreamAiSdk — reasoning channel (B.1)", () => {
  test("emits reasoning-start / reasoning-delta / reasoning-end with matched id", async () => {
    const model = makeReasoningThenTextModel({
      reasoning: ["alpha ", "beta"],
      text: ["gamma"],
    })
    const frames = await collect(chatStreamAiSdk(model, baseConfig))
    const payloads = parseAiSdk(frames)
    const types = payloads.map((p) => (typeof p === "string" ? p : p.type))
    expect(types).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
      "[DONE]",
    ])
    // The reasoning channel id is stable across start/delta/end.
    const rStart = payloads[2] as unknown as { id: string }
    const rDelta = payloads[3] as unknown as { id: string; delta: string }
    const rEnd = payloads[5] as unknown as { id: string }
    expect(rDelta.id).toBe(rStart.id)
    expect(rEnd.id).toBe(rStart.id)
    expect(rDelta.delta).toBe("alpha ")
  })

  test("text-start closes any open reasoning block first", async () => {
    // Drives reasoning ➜ text in one step. The closeReasoning() call
    // before text-start emits a reasoning-end before the text channel
    // opens — `useChat` requires matched start/end pairs per id.
    const model = makeReasoningThenTextModel({
      reasoning: ["thinking"],
      text: ["answer"],
    })
    const frames = await collect(chatStreamAiSdk(model, baseConfig))
    const types = parseAiSdk(frames).map((p) =>
      typeof p === "string" ? p : p.type,
    )
    const rEndIdx = types.indexOf("reasoning-end")
    const tStartIdx = types.indexOf("text-start")
    expect(rEndIdx).toBeGreaterThan(-1)
    expect(tStartIdx).toBeGreaterThan(rEndIdx)
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

// --- Suggestions JSON parsing (PLAN-useChat-adoption.md Phase B.1d) -

describe("parseSuggestionsJson — agent-ts helper", () => {
  test("happy path returns the three strings", async () => {
    const { parseSuggestionsJson } = await import("../src/chat")
    expect(parseSuggestionsJson('["one","two","three"]')).toEqual([
      "one",
      "two",
      "three",
    ])
  })

  test("strips markdown fences", async () => {
    const { parseSuggestionsJson } = await import("../src/chat")
    expect(parseSuggestionsJson('```json\n["a","b"]\n```')).toEqual(["a", "b"])
  })

  test("caps at three entries", async () => {
    const { parseSuggestionsJson } = await import("../src/chat")
    expect(parseSuggestionsJson('["a","b","c","d","e"]')).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  test("drops empty + overlong entries", async () => {
    const { parseSuggestionsJson } = await import("../src/chat")
    const raw = JSON.stringify(["ok", "  ", "x".repeat(200), "fine"])
    expect(parseSuggestionsJson(raw)).toEqual(["ok", "fine"])
  })

  test("invalid JSON yields empty", async () => {
    const { parseSuggestionsJson } = await import("../src/chat")
    expect(parseSuggestionsJson("not json")).toEqual([])
    expect(parseSuggestionsJson('{"not":"a list"}')).toEqual([])
    expect(parseSuggestionsJson("")).toEqual([])
  })
})

describe("chatStreamAiSdk — error frame carries provider-categorised code", () => {
  test("upstream when the model emits an `error` part with a generic Error", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "error", error: new Error("connection reset") },
          ],
        }),
      }),
    })
    const frames = await collect(chatStreamAiSdk(model, baseConfig))
    const payloads = parseAiSdk(frames)
    const types = payloads.map((p) => (typeof p === "string" ? p : p.type))
    expect(types).toEqual(["start", "start-step", "error", "[DONE]"])
    const errFrame = payloads[2] as {
      type: string
      errorText: string
      code: string
    }
    expect(errFrame.errorText).toBe("connection reset")
    expect(errFrame.code).toBe("upstream")
  })

  test("rate_limit when the upstream error mentions rate limiting", async () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "error", error: new Error("429 Too Many Requests") },
          ],
        }),
      }),
    })
    const frames = await collect(chatStreamAiSdk(model, baseConfig))
    const payloads = parseAiSdk(frames)
    const errFrame = payloads[2] as unknown as { code: string }
    expect(errFrame.code).toBe("rate_limit")
  })

  test("context_window when a 400-class APICallError mentions prompt overflow", async () => {
    const apiErr = new APICallError({
      message: "prompt is too long: 220000 tokens > 200000 maximum",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
    })
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "error", error: apiErr },
          ],
        }),
      }),
    })
    const frames = await collect(chatStreamAiSdk(model, baseConfig))
    const payloads = parseAiSdk(frames)
    const errFrame = payloads[2] as unknown as { code: string }
    expect(errFrame.code).toBe("context_window")
  })
})

describe("categorizeProviderError — typed AI SDK errors", () => {
  test("APICallError 429 → rate_limit", () => {
    const err = new APICallError({
      message: "rate limited",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 429,
    })
    expect(categorizeProviderError(err)).toBe("rate_limit")
  })

  test("APICallError 401 → auth", () => {
    const err = new APICallError({
      message: "invalid x-api-key",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 401,
    })
    expect(categorizeProviderError(err)).toBe("auth")
  })

  test("APICallError 403 → auth", () => {
    const err = new APICallError({
      message: "permission denied",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 403,
    })
    expect(categorizeProviderError(err)).toBe("auth")
  })

  test("APICallError 400 with context-window message → context_window", () => {
    const err = new APICallError({
      message: "prompt is too long: 250000 > 200000",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 400,
    })
    expect(categorizeProviderError(err)).toBe("context_window")
  })

  test("APICallError 400 without context-window phrase → upstream", () => {
    const err = new APICallError({
      message: "messages.0: role must be user|assistant",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 400,
    })
    expect(categorizeProviderError(err)).toBe("upstream")
  })
})

describe("categorizeProviderError — string-match fallback for generic errors", () => {
  test("rate-limit phrasing", () => {
    expect(categorizeProviderError(new Error("Rate limit exceeded"))).toBe(
      "rate_limit",
    )
    expect(categorizeProviderError(new Error("429"))).toBe("rate_limit")
    expect(categorizeProviderError(new Error("too many requests"))).toBe(
      "rate_limit",
    )
  })

  test("auth phrasing", () => {
    expect(categorizeProviderError(new Error("Unauthorized: bad key"))).toBe(
      "auth",
    )
    expect(categorizeProviderError(new Error("403 Forbidden"))).toBe("auth")
  })

  test("context-window phrasing", () => {
    expect(categorizeProviderError(new Error("input is too long"))).toBe(
      "context_window",
    )
    expect(categorizeProviderError(new Error("context window exceeded"))).toBe(
      "context_window",
    )
  })

  test("unrecognised → upstream", () => {
    expect(categorizeProviderError(new Error("connection reset"))).toBe(
      "upstream",
    )
    expect(categorizeProviderError("just a string")).toBe("upstream")
  })

  test("typed rate_limit wins even when message mentions context window", () => {
    const err = new APICallError({
      message: "rate limited (context_length 100)",
      url: "https://x",
      requestBodyValues: {},
      statusCode: 429,
    })
    expect(categorizeProviderError(err)).toBe("rate_limit")
  })
})

describe("chatStreamAiSdk — onComplete hook (B.1d)", () => {
  test("data-suggestions sits before finish-step", async () => {
    const captured: string[] = []
    const model = makeModel(["Hello"])
    const frames = await collect(
      chatStreamAiSdk(model, baseConfig, {
        onComplete: async function* (text: string) {
          captured.push(text)
          yield `data: ${JSON.stringify({
            type: "data-suggestions",
            data: { values: ["a"] },
          })}\n\n`
        },
      }),
    )
    const payloads = parseAiSdk(frames)
    const types = payloads.map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toContain("data-suggestions")
    const idxSuggest = types.indexOf("data-suggestions")
    const idxFinishStep = types.indexOf("finish-step")
    expect(idxSuggest).toBeLessThan(idxFinishStep)
    expect(captured).toEqual(["Hello"])
  })
})
