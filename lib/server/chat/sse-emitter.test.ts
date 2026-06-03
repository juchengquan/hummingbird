import { describe, expect, test } from "bun:test"

import { ChatSseEmitter } from "./sse-emitter"

/** Capture frames a `ChatSseEmitter` writes. The emitter is given a
 *  raw line writer; we collect the lines into an array and then
 *  parse the data payloads with `parseFrames` below. */
function collect(format: "custom" | "ai-sdk"): {
  emitter: ChatSseEmitter
  lines: string[]
} {
  const lines: string[] = []
  const emitter = new ChatSseEmitter((line) => lines.push(line), format)
  return { emitter, lines }
}

/** Decode a list of raw `data: ...\n\n` SSE frames into their JSON
 *  payloads (or the literal string `"[DONE]"` for the AI SDK terminator). */
function parseFrames(lines: string[]): unknown[] {
  return lines.map((l) => {
    const stripped = l.replace(/^data: /, "").trimEnd()
    return stripped === "[DONE]" ? "[DONE]" : JSON.parse(stripped)
  })
}

describe("ChatSseEmitter — custom format", () => {
  test("text → {type:'text',value}", () => {
    const { emitter, lines } = collect("custom")
    emitter.start()
    emitter.text("Hello ")
    emitter.text("world")
    emitter.done()
    expect(parseFrames(lines)).toEqual([
      { type: "text", value: "Hello " },
      { type: "text", value: "world" },
      { type: "done" },
    ])
  })

  test("reasoning → {type:'reasoning',value}", () => {
    const { emitter, lines } = collect("custom")
    emitter.start()
    emitter.reasoning("Let me think…")
    emitter.text("Answer")
    emitter.done()
    const types = parseFrames(lines).map(
      (p) => (p as { type: string }).type,
    )
    expect(types).toEqual(["reasoning", "text", "done"])
  })

  test("empty deltas are dropped", () => {
    const { emitter, lines } = collect("custom")
    emitter.text("")
    emitter.reasoning("")
    expect(lines).toEqual([])
  })

  test("tool_call / tool_result frames carry id+name+summary", () => {
    const { emitter, lines } = collect("custom")
    emitter.toolCall("c1", "webSearch", { query: "hi" })
    emitter.toolResult({
      id: "c1",
      name: "webSearch",
      summary: "3 results",
      results: [
        { title: "a", url: "https://a", snippet: "" },
        { title: "b", url: "https://b", snippet: "" },
        { title: "c", url: "https://c", snippet: "" },
      ],
    })
    const payloads = parseFrames(lines) as Array<{ type: string; [k: string]: unknown }>
    expect(payloads[0]).toEqual({
      type: "tool_call",
      id: "c1",
      name: "webSearch",
      args: { query: "hi" },
    })
    expect(payloads[1]?.type).toBe("tool_result")
    expect(payloads[1]?.results).toBeArray()
  })

  test("toolResult with isError sets the flag", () => {
    const { emitter, lines } = collect("custom")
    emitter.toolResult(
      { id: "c1", name: "webSearch", summary: "error: rate limit" },
      true,
    )
    const p = parseFrames(lines)[0] as { isError?: boolean }
    expect(p.isError).toBe(true)
  })

  test("tool_image → {type:'tool_image',id,mode,images}", () => {
    const { emitter, lines } = collect("custom")
    emitter.toolImage({
      id: "img-1",
      mode: "t2i",
      images: [
        {
          id: "img-1-0",
          url: "https://x",
          width: 512,
          height: 512,
          format: "png",
          prompt: "a cat",
          mode: "t2i",
        },
      ],
    })
    const p = parseFrames(lines)[0] as {
      type: string
      images: Array<{ url: string }>
    }
    expect(p.type).toBe("tool_image")
    expect(p.images[0]?.url).toBe("https://x")
  })

  test("suggestions empty array is silent", () => {
    const { emitter, lines } = collect("custom")
    emitter.suggestions([])
    expect(lines).toEqual([])
  })

  test("suggestions → {type:'suggestions',values}", () => {
    const { emitter, lines } = collect("custom")
    emitter.suggestions(["a", "b"])
    expect(parseFrames(lines)).toEqual([
      { type: "suggestions", values: ["a", "b"] },
    ])
  })

  test("error → {type:'error',code,message}", () => {
    const { emitter, lines } = collect("custom")
    emitter.error("provider", "boom")
    expect(parseFrames(lines)).toEqual([
      { type: "error", code: "provider", message: "boom" },
    ])
  })

  test("endAfterError is a no-op on custom", () => {
    const { emitter, lines } = collect("custom")
    emitter.error("provider", "boom")
    emitter.endAfterError()
    expect(parseFrames(lines)).toEqual([
      { type: "error", code: "provider", message: "boom" },
    ])
  })
})

describe("ChatSseEmitter — AI SDK format", () => {
  test("lifecycle: start / start-step / finish-step / finish / [DONE]", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.done()
    expect(parseFrames(lines)).toEqual([
      { type: "start" },
      { type: "start-step" },
      { type: "finish-step" },
      { type: "finish" },
      "[DONE]",
    ])
  })

  test("text → text-start (lazy) → text-delta → text-end on done", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.text("Hello ")
    emitter.text("world")
    emitter.done()
    const frames = parseFrames(lines)
    const types = frames.map((p) => (typeof p === "string" ? p : (p as { type: string }).type))
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
    const textStart = frames[2] as { id: string }
    const d0 = frames[3] as { id: string; delta: string }
    expect(d0.id).toBe(textStart.id)
    expect(d0.delta).toBe("Hello ")
  })

  test("reasoning → reasoning-start / reasoning-delta / reasoning-end", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.reasoning("Let me ")
    emitter.reasoning("think")
    emitter.done()
    const types = parseFrames(lines).map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "finish-step",
      "finish",
      "[DONE]",
    ])
  })

  test("text → reasoning closes text-end before reasoning-start", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.text("first")
    emitter.reasoning("paused")
    emitter.text("second")
    emitter.done()
    const types = parseFrames(lines).map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",  // new id for the second text block
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
      "[DONE]",
    ])
  })

  test("tool-call closes any open channels first", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.text("looking")
    emitter.toolCall("c1", "webSearch", { query: "x" })
    emitter.done()
    const types = parseFrames(lines).map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "finish-step",
      "finish",
      "[DONE]",
    ])
  })

  test("toolResult → tool-output-available with stringified output", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.toolResult({
      id: "c1",
      name: "webSearch",
      summary: "3 results",
      results: [{ title: "a", url: "https://a", snippet: "" }],
    })
    const frame = parseFrames(lines)[0] as {
      type: string
      toolCallId: string
      output: string
    }
    expect(frame.type).toBe("tool-output-available")
    expect(frame.toolCallId).toBe("c1")
    expect(JSON.parse(frame.output)).toMatchObject({
      summary: "3 results",
      results: [{ title: "a" }],
    })
  })

  test("toolResult isError sets errorText", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.toolResult(
      { id: "c1", name: "webSearch", summary: "rate limit" },
      true,
    )
    const frame = parseFrames(lines)[0] as { errorText: string }
    expect(frame.errorText).toBe("rate limit")
  })

  test("toolImage → data-tool-image", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.toolImage({
      id: "img-1",
      mode: "t2i",
      images: [
        {
          id: "img-1-0",
          url: "https://x",
          width: 512,
          height: 512,
          format: "png",
          prompt: "a cat",
          mode: "t2i",
        },
      ],
    })
    const frame = parseFrames(lines)[0] as {
      type: string
      id: string
      data: { id: string; mode: string; images: unknown[] }
    }
    expect(frame.type).toBe("data-tool-image")
    expect(frame.id).toBe("img-1")
    expect(frame.data.mode).toBe("t2i")
    expect(frame.data.images).toHaveLength(1)
  })

  test("suggestions → data-suggestions", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.suggestions(["a", "b"])
    const frame = parseFrames(lines)[0] as {
      type: string
      data: { values: string[] }
    }
    expect(frame.type).toBe("data-suggestions")
    expect(frame.data.values).toEqual(["a", "b"])
  })

  test("error closes channels then emits error + skips finish", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.text("partial")
    emitter.error("provider", "boom")
    emitter.endAfterError()
    const types = parseFrames(lines).map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "error",
      "[DONE]",
    ])
    // No `finish` frame on the error path — useChat distinguishes
    // completion from failure on that signal.
    expect(types).not.toContain("finish")
  })

  test("error before any delta: no text-start/text-end orphan", () => {
    const { emitter, lines } = collect("ai-sdk")
    emitter.start()
    emitter.error("provider", "instant")
    emitter.endAfterError()
    const types = parseFrames(lines).map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toEqual(["start", "start-step", "error", "[DONE]"])
  })
})
