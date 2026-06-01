/**
 * Follow-up #2 tests — `/v1/chat` with tools enabled.
 *
 * Drives `chatStream` + `chatStreamAiSdk` with a `MockLanguageModelV2`
 * that emits a tool-call chunk. The AI SDK's loop wires the
 * accompanying tool's `execute` result back as a `tool-result` part
 * on `fullStream`. We assert the resulting SSE frames in both wire
 * formats and check the system-prompt + tool-set wiring inside
 * `buildToolSet` / `buildSkillNotes`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { simulateReadableStream, tool } from "ai"
import { MockLanguageModelV2 } from "ai/test"
import { z } from "zod"

import type { ServerSkill } from "@/server/skills/registry"

import {
  chatStream,
  chatStreamAiSdk,
  isToolError,
  summariseToolOutput,
  stringifyToolOutput,
  type ChatConfig,
  type StreamTextTools,
} from "../src/chat"
import { resetEnvCacheForTest } from "../src/env"
import {
  buildSkillNotes,
  buildToolSet,
  type SkillEntry,
} from "../src/skills"

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "sk-test"
  resetEnvCacheForTest()
})

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY
  resetEnvCacheForTest()
})

/** Build a `LanguageModelV2` that, in a single step, emits one
 *  tool-call (with the supplied id / name / args) and then finishes.
 *  The AI SDK will see the call, invoke the matching tool's `execute`,
 *  and emit a `tool-result` part for the next iteration. We feed a
 *  finish chunk so the SDK stops after the first iteration without
 *  asking the model for a follow-up text turn. */
function makeToolCallModel(opts: {
  toolCallId: string
  toolName: string
  input: object
}): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: opts.toolCallId,
            toolName: opts.toolName,
            input: JSON.stringify(opts.input),
          },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  })
}

const messages = [{ role: "user" as const, content: "hi" }]

/** A tool that returns a static success payload. We `unknown`-cast at
 *  the boundaries — the agent-ts and root `ai` packages each have
 *  their own copy of the `Tool` generic, so the literal types diverge
 *  even though the runtime shape is identical. */
function fakeSearchTool(): unknown {
  return tool({
    description: "Fake search",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => ({
      results: [
        { title: "Doc A", url: "https://x", snippet: query },
        { title: "Doc B", url: "https://y", snippet: query },
      ],
    }),
  })
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

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = []
  for await (const f of gen) out.push(f)
  return out
}

describe("chatStream — custom format with tools", () => {
  test("emits tool_call + tool_result frames", async () => {
    const model = makeToolCallModel({
      toolCallId: "call-1",
      toolName: "fakeSearch",
      input: { query: "hummingbirds" },
    })

    const tools = { fakeSearch: fakeSearchTool() } as StreamTextTools
    const config: ChatConfig = {
      model: "claude-3-5-haiku-20241022",
      messages,
      tools,
      maxSteps: 1,
    }

    const frames = await collect(chatStream(model, config))
    const payloads = parseCustom(frames)

    const toolCall = payloads.find((p) => p.type === "tool_call")
    const toolResult = payloads.find((p) => p.type === "tool_result")
    expect(toolCall).toMatchObject({
      type: "tool_call",
      id: "call-1",
      name: "fakeSearch",
      args: { query: "hummingbirds" },
    })
    expect(toolResult).toMatchObject({
      type: "tool_result",
      id: "call-1",
      name: "fakeSearch",
      summary: "2 results",
    })
    expect(payloads.at(-1)).toEqual({ type: "done" })
  })

  test("tool_result includes isError on a failure-shaped output", async () => {
    const model = makeToolCallModel({
      toolCallId: "call-x",
      toolName: "fakeBoom",
      input: {},
    })
    const boomTool: unknown = tool({
      description: "Fails on purpose",
      inputSchema: z.object({}),
      execute: async () => ({ ok: false, error: "network timeout" }),
    })

    const tools = { fakeBoom: boomTool } as StreamTextTools
    const config: ChatConfig = {
      model: "claude-3-5-haiku-20241022",
      messages,
      tools,
      maxSteps: 1,
    }

    const frames = await collect(chatStream(model, config))
    const payloads = parseCustom(frames)
    const toolResult = payloads.find((p) => p.type === "tool_result")
    expect(toolResult).toMatchObject({
      type: "tool_result",
      id: "call-x",
      isError: true,
      summary: "network timeout",
    })
  })
})

describe("chatStreamAiSdk — AI SDK v5 format with tools", () => {
  test("emits tool-input-available + tool-output-available", async () => {
    const model = makeToolCallModel({
      toolCallId: "call-2",
      toolName: "fakeSearch",
      input: { query: "ts" },
    })
    const tools = { fakeSearch: fakeSearchTool() } as StreamTextTools
    const config: ChatConfig = {
      model: "claude-3-5-haiku-20241022",
      messages,
      tools,
      maxSteps: 1,
    }

    const frames = await collect(chatStreamAiSdk(model, config))
    const payloads = parseAiSdk(frames)
    const types = payloads.map((p) => (typeof p === "string" ? p : p.type))
    expect(types).toContain("tool-input-available")
    expect(types).toContain("tool-output-available")
    expect(types.at(-1)).toBe("[DONE]")

    const input = payloads.find(
      (p) => typeof p !== "string" && p.type === "tool-input-available",
    ) as unknown as { toolCallId: string; toolName: string; input: unknown }
    expect(input.toolCallId).toBe("call-2")
    expect(input.toolName).toBe("fakeSearch")
    expect(input.input).toEqual({ query: "ts" })

    const out = payloads.find(
      (p) => typeof p !== "string" && p.type === "tool-output-available",
    ) as unknown as { toolCallId: string; output: string }
    expect(out.toolCallId).toBe("call-2")
    // Tool output is JSON-stringified per the AI SDK protocol.
    expect(JSON.parse(out.output)).toMatchObject({
      results: [{ title: "Doc A" }, { title: "Doc B" }],
    })
  })
})

describe("summariseToolOutput / isToolError / stringifyToolOutput", () => {
  test("results -> N results", () => {
    expect(summariseToolOutput({ results: [{}, {}, {}] })).toBe("3 results")
    expect(summariseToolOutput({ results: [{}] })).toBe("1 result")
  })

  test("fragments -> N excerpts", () => {
    expect(summariseToolOutput({ fragments: ["a", "b"] })).toBe("2 excerpts")
  })

  test("images -> N images", () => {
    expect(summariseToolOutput({ images: [{}, {}] })).toBe("2 images")
  })

  test("error -> error text", () => {
    expect(summariseToolOutput({ error: "boom" })).toBe("boom")
  })

  test("unknown shape -> done", () => {
    expect(summariseToolOutput({ foo: "bar" })).toBe("done")
    expect(summariseToolOutput(null)).toBe("done")
  })

  test("isToolError flags ok:false and error:string", () => {
    expect(isToolError({ ok: false, code: "auth", error: "x" })).toBe(true)
    expect(isToolError({ error: "y" })).toBe(true)
    expect(isToolError({ results: [] })).toBe(false)
    expect(isToolError(undefined)).toBe(false)
  })

  test("stringifyToolOutput round-trips JSON", () => {
    expect(stringifyToolOutput({ a: 1 })).toBe('{"a":1}')
    expect(stringifyToolOutput("plain")).toBe("plain")
  })
})

describe("buildToolSet / buildSkillNotes", () => {
  test("empty when no skill builds a tool", () => {
    const tools = buildToolSet({ registry: [] })
    expect(Object.keys(tools)).toEqual([])
  })

  test("collects only skills whose buildTool is non-null", () => {
    // `unknown`-cast for the synthetic registry entries — the
    // `SkillId` and `Tool` types come from the lib/server registry
    // (root-installed `ai` package) while we're constructing tools
    // through agent-ts's own `ai` install. Same divergence as
    // `fakeSearchTool` above.
    const registry = [
      {
        id: "imageGen",
        toolName: "generateImage",
        buildTool: () =>
          tool({
            description: "x",
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
          }),
        promptFragment: () => "use generateImage",
      },
      {
        id: "webSearch",
        toolName: "webSearch",
        buildTool: () => null,
        promptFragment: () => null,
      },
    ] as unknown as ServerSkill[]
    const tools = buildToolSet({ registry })
    expect(Object.keys(tools)).toEqual(["generateImage"])
  })

  test("buildSkillNotes joins fragments with leading bullets", () => {
    const registry = [
      {
        id: "a",
        toolName: "a",
        buildTool: () => null,
        promptFragment: () => "use A",
      },
      {
        id: "b",
        toolName: "b",
        buildTool: () => null,
        promptFragment: () => null,
      },
      {
        id: "c",
        toolName: "c",
        buildTool: () => null,
        promptFragment: () => "use C",
      },
    ] as unknown as ServerSkill[]
    const notes = buildSkillNotes({ registry })
    expect(notes).toBe("Available capabilities:\n- use A\n- use C")
  })

  test("skills array narrows per-skill entry by id", () => {
    let observed: SkillEntry | undefined
    const registry = [
      {
        id: "imageGen",
        toolName: "generateImage",
        buildTool: (entry: SkillEntry | undefined) => {
          observed = entry
          return null
        },
        promptFragment: () => null,
      },
    ] as unknown as ServerSkill[]
    buildToolSet({
      skills: [
        { id: "imageGen", imageGenConfig: { maxCalls: 3 } } as unknown as SkillEntry,
      ],
      registry,
    })
    expect(observed).toEqual({ id: "imageGen", imageGenConfig: { maxCalls: 3 } })
  })
})
