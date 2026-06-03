import { describe, expect, test } from "bun:test"

import { ChatSseEmitter } from "./sse-emitter"

/** Capture frames a `ChatSseEmitter` writes. The emitter is given a
 *  raw line writer; we collect the lines into an array and then
 *  parse the data payloads with `parseFrames` below. */
function collect(): {
  emitter: ChatSseEmitter
  lines: string[]
} {
  const lines: string[] = []
  const emitter = new ChatSseEmitter((line) => lines.push(line))
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


describe("ChatSseEmitter — AI SDK format", () => {
  test("lifecycle: start / start-step / finish-step / finish / [DONE]", () => {
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
    emitter.toolResult(
      { id: "c1", name: "webSearch", summary: "rate limit" },
      true,
    )
    const frame = parseFrames(lines)[0] as { errorText: string }
    expect(frame.errorText).toBe("rate limit")
  })

  test("toolImage → data-tool-image", () => {
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
    emitter.suggestions(["a", "b"])
    const frame = parseFrames(lines)[0] as {
      type: string
      data: { values: string[] }
    }
    expect(frame.type).toBe("data-suggestions")
    expect(frame.data.values).toEqual(["a", "b"])
  })

  test("error closes channels then emits error + skips finish", () => {
    const { emitter, lines } = collect()
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
    const { emitter, lines } = collect()
    emitter.start()
    emitter.error("provider", "instant")
    emitter.endAfterError()
    const types = parseFrames(lines).map((p) =>
      typeof p === "string" ? p : (p as { type: string }).type,
    )
    expect(types).toEqual(["start", "start-step", "error", "[DONE]"])
  })
})
