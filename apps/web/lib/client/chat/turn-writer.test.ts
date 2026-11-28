import { describe, expect, test } from "bun:test"

import type { LiveToolCall } from "@/components/skills/tool-call-strip"
import type { Message } from "@/shared/types"

import { createTurnWriter, messageBaseOf, type TurnWriterDeps } from "./turn-writer"

const CONV = "c"

function fake() {
  const log: string[] = []
  const messages: Message[] = []
  const artifacts: Array<{ kind: string; messageId: string }> = []
  let live: Record<string, LiveToolCall[]> = {}
  const update = (id: string, f: (m: Message) => Message) => {
    const i = messages.findIndex((m) => m.id === id)
    if (i !== -1) messages[i] = f(messages[i])
  }
  const deps = {
    addMessage: (m: Omit<Message, "id" | "timestamp">) => {
      const msg = { ...m, id: `m${messages.length + 1}`, timestamp: new Date() } as Message
      messages.push(msg)
      log.push("add")
      return msg
    },
    setConversationTyping: (_c: string, on: boolean) => void log.push(`typing:${on}`),
    appendToMessage: (id: string, s: string) => update(id, (m) => ({ ...m, content: m.content + s })),
    appendToMessageReasoning: (id: string, s: string) =>
      update(id, (m) => ({ ...m, reasoning: (m.reasoning ?? "") + s })),
    appendMessageGeneratedImages: (id: string, images: NonNullable<Message["generatedImages"]>) =>
      update(id, (m) => ({ ...m, generatedImages: [...(m.generatedImages ?? []), ...images] })),
    appendMessageGeneratedFiles: (id: string, files: NonNullable<Message["generatedFiles"]>) =>
      update(id, (m) => ({ ...m, generatedFiles: [...(m.generatedFiles ?? []), ...files] })),
    appendMessageCodeResult: () => {},
    appendMessageUiPart: () => {},
    appendMessageMcpApp: () => {},
    setMessageSuggestions: () => {},
    setMessageVerification: () => {},
    setMessageRoutedModel: (id: string, routedModel: string) => update(id, (m) => ({ ...m, routedModel })),
    setMessageToolCalls: (id: string, toolCalls: NonNullable<Message["toolCalls"]>) =>
      update(id, (m) => ({ ...m, toolCalls })),
    createArtifact: (a: { kind: string; messageId: string }) => {
      artifacts.push(a)
      return a
    },
    clearMessageOutput: (id: string) =>
      update(id, (m) => ({ id: m.id, role: m.role, timestamp: m.timestamp, content: "" }) as Message),
    getMessage: (id: string) => messages.find((m) => m.id === id),
    setLiveToolCalls: (u: unknown) => {
      live = typeof u === "function" ? (u as (p: typeof live) => typeof live)(live) : (u as typeof live)
    },
  }
  return {
    deps: deps as unknown as TurnWriterDeps,
    log,
    messages,
    artifacts,
    live: () => live,
  }
}

const image = (id: string) => ({ id, url: `https://x/${id}.png`, width: 1, height: 1, format: "png", prompt: "p" })

describe("/v1/chat frames (behaviour moved from use-chat-send unchanged)", () => {
  test("the placeholder is created on the first output frame; typing goes off first", () => {
    const f = fake()
    const w = createTurnWriter(f.deps, { conversationId: CONV })
    expect(w.placeholder).toBeNull()
    expect(w.firstChunk).toBe(true)
    // Parts before any output are dropped (no placeholder yet), as before.
    w.handleFrame({ type: "routed_model", value: "x" })
    expect(f.messages).toHaveLength(0)
    w.handleFrame({ type: "text", value: "Hel" })
    w.handleFrame({ type: "text", value: "lo" })
    expect(f.log).toEqual(["typing:false", "add"])
    expect(w.firstChunk).toBe(false)
    expect(f.messages[0].content).toBe("Hello")
  })

  test("tool calls buffer locally and mirror into the live pills", () => {
    const f = fake()
    const w = createTurnWriter(f.deps, { conversationId: CONV })
    w.handleFrame({ type: "tool_call", id: "t1", name: "webSearch", args: { query: "q" } })
    w.handleFrame({ type: "tool_result", id: "t1", summary: "3 results" })
    expect(w.toolCalls).toEqual([
      { id: "t1", name: "webSearch", argsLabel: "q", status: "done", summary: "3 results", results: undefined },
    ])
    expect(f.live()[w.placeholder!.id]).toBe(w.toolCalls)
  })

  test("error / done stop the stream; memory_tainted flags the turn", () => {
    const f = fake()
    const w = createTurnWriter(f.deps, { conversationId: CONV })
    expect(w.handleFrame({ type: "memory_tainted" })).toBe("continue")
    expect(w.memoryTainted).toBe(true)
    expect(w.handleFrame({ type: "done" })).toBe("stop")
    expect(w.handleFrame({ type: "error", code: "rate_limit", message: "slow" })).toBe("stop")
    expect(w.streamError).toEqual({ code: "rate_limit", message: "slow" })
  })

  test("reasoning is timed", () => {
    const f = fake()
    const w = createTurnWriter(f.deps, { conversationId: CONV })
    w.handleFrame({ type: "reasoning", value: "think" })
    expect(w.reasoningStart).not.toBeNull()
    expect(w.reasoningLast).not.toBeNull()
    expect(f.messages[0].reasoning).toBe("think")
  })
})

describe("runs: a placeholder given up front, clear(), base", () => {
  test("parts apply to the given placeholder before any text; typing goes off on output", () => {
    const f = fake()
    const ph = f.deps.addMessage({ role: "assistant", content: "" }, CONV)
    f.log.length = 0
    const w = createTurnWriter(f.deps, { conversationId: CONV, placeholder: ph })
    w.handleFrame({ type: "routed_model", value: "anthropic/x" })
    expect(f.messages[0].routedModel).toBe("anthropic/x")
    expect(w.firstChunk).toBe(true)
    w.handleFrame({ type: "text", value: "a" })
    expect(f.log).toEqual(["typing:false"])
    expect(f.messages).toHaveLength(1)
  })

  test("a reset re-applies generated images without creating their artifacts twice", () => {
    const f = fake()
    const ph = f.deps.addMessage({ role: "assistant", content: "" }, CONV)
    const w = createTurnWriter(f.deps, { conversationId: CONV, placeholder: ph })
    w.handleFrame({ type: "text", value: "here" })
    w.handleFrame({ type: "tool_call", id: "t", name: "generateImage" })
    w.handleFrame({ type: "tool_image", images: [image("i1")] })
    expect(f.artifacts).toHaveLength(1)
    w.clear()
    expect(f.messages[0].content).toBe("")
    expect(f.messages[0].generatedImages).toBeUndefined()
    expect(w.toolCalls).toEqual([])
    expect(f.live()[ph.id]).toBeUndefined()
    // The replay's frames.
    w.handleFrame({ type: "text", value: "here" })
    w.handleFrame({ type: "tool_image", images: [image("i1")] })
    w.handleFrame({ type: "tool_image", images: [image("i2")] })
    expect(f.messages[0].generatedImages?.map((i) => i.id)).toEqual(["i1", "i2"])
    expect(f.artifacts).toHaveLength(2)
  })

  test("a resume's base seeds the tool calls (done) and survives a reset", () => {
    const f = fake()
    const ph = f.deps.addMessage({ role: "assistant", content: "" }, CONV)
    f.deps.appendToMessage(ph.id, "Paused text.")
    f.deps.setMessageToolCalls(ph.id, [{ id: "a", name: "lookup", summary: "ok" }])
    const base = messageBaseOf(f.messages[0])
    const w = createTurnWriter(f.deps, { conversationId: CONV, placeholder: f.messages[0], base })
    expect(w.toolCalls).toEqual([{ id: "a", name: "lookup", argsLabel: undefined, summary: "ok", status: "done" }])
    w.handleFrame({ type: "tool_call", id: "ask", name: "askUser" })
    w.handleFrame({ type: "tool_result", id: "ask", summary: "User selected: a" })
    w.handleFrame({ type: "text", value: " More." })
    expect(f.messages[0].content).toBe("Paused text. More.")
    w.clear()
    expect(f.messages[0].content).toBe("Paused text.")
    expect(f.messages[0].toolCalls).toEqual([{ id: "a", name: "lookup", summary: "ok" }])
    expect(w.toolCalls.map((t) => t.id)).toEqual(["a"])
  })
})
