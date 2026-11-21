/**
 * Chat on runs end to end below the hook: `createChatRunner` with the real
 * session module (recorded agent-py streams served by a fake `fetch`), the
 * real writer, and a plain in-memory stand-in for the store's mutators.
 * Covers README § 4b-A steps 3–8 and the interrupt → bridge → resume path.
 */

import { describe, expect, test } from "bun:test"

import type { Message, MessageError } from "@/shared/types"

import { buildRunInput } from "./build-input"
import type { InterruptedTurn } from "./chat-bridge"
import { createChatRunner, type ChatRunnerDeps, type ChatRunnerStore } from "./chat-runner"
import { fakeFetch, loadFixture, memoryStorage, sseResponse, type FakeCall } from "./fixtures"
import * as activeRun from "./active-run"
import * as runBase from "./run-base"
import * as session from "./session"
import type { RunsTarget, StartRunRequest } from "./types"

const SIGNED_IN: RunsTarget = { baseUrl: "https://agent.example", authToken: "jwt" }
const CONV = "conv-1"

function bodyFor(name: string): StartRunRequest {
  const started = loadFixture(name).items[0].event as unknown as { runId: string; threadId: string }
  return { threadId: started.threadId, runId: started.runId, messages: [] }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

/** The store's message mutators over one conversation, in memory. */
function fakeStore(initial: Message[] = []) {
  let n = 0
  const conversation = { id: CONV, messages: [...initial], memoryOff: false }
  const state = {
    conversations: [conversation],
    streaming: new Set<string>(),
    typing: new Set<string>(),
    artifacts: [] as Array<{ messageId: string; kind: string }>,
  }
  const update = (id: string, f: (m: Message) => Message) => {
    for (const c of state.conversations) c.messages = c.messages.map((m) => (m.id === id ? f(m) : m))
  }
  const store = {
    get conversations() {
      return state.conversations
    },
    addMessage: (m: Omit<Message, "id" | "timestamp">, convId?: string) => {
      const msg = { ...m, id: `m-${++n}`, timestamp: new Date() } as Message
      state.conversations.find((c) => c.id === (convId ?? CONV))!.messages.push(msg)
      return msg
    },
    deleteMessage: (id: string) => {
      for (const c of state.conversations) c.messages = c.messages.filter((m) => m.id !== id)
    },
    setMessageError: (id: string, error: MessageError) => update(id, (m) => ({ ...m, error })),
    setMessageReasoningDuration: (id: string, d: number) => update(id, (m) => ({ ...m, reasoningDurationMs: d })),
    setConversationStreaming: (id: string, on: boolean) =>
      on ? state.streaming.add(id) : state.streaming.delete(id),
    setConversationTyping: (id: string, on: boolean) => (on ? state.typing.add(id) : state.typing.delete(id)),
    clearMessageOutput: (id: string) =>
      update(id, (m) => ({ id: m.id, role: m.role, timestamp: m.timestamp, content: "" }) as Message),
    appendToMessage: (id: string, chunk: string) => update(id, (m) => ({ ...m, content: m.content + chunk })),
    appendToMessageReasoning: (id: string, chunk: string) =>
      update(id, (m) => ({ ...m, reasoning: (m.reasoning ?? "") + chunk })),
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
      update(id, (m) => ({ ...m, toolCalls: toolCalls.length > 0 ? toolCalls : undefined })),
    createArtifact: (a: { messageId: string; kind: string }) => {
      state.artifacts.push(a)
      return a
    },
  }
  const message = (id: string) => state.conversations[0].messages.find((m) => m.id === id)
  return { state, store: store as unknown as ChatRunnerStore, message, conversation }
}

interface Harness {
  runner: ReturnType<typeof createChatRunner>
  fake: ReturnType<typeof fakeStore>
  storage: ReturnType<typeof memoryStorage>
  turns: Record<string, InterruptedTurn>
  memory: Array<{ text: string; tainted: boolean }>
  archived: string[]
  cancels: string[]
  live: Record<string, unknown>
}

function harness(
  fetchImpl: typeof fetch,
  opts: { initial?: Message[]; target?: RunsTarget | null; deps?: Partial<ChatRunnerDeps> } = {},
): Harness {
  const fake = fakeStore(opts.initial)
  const storage = memoryStorage()
  const turns: Record<string, InterruptedTurn> = {}
  const memory: Harness["memory"] = []
  const archived: string[] = []
  const cancels: string[] = []
  let live: Record<string, unknown> = {}
  const runner = createChatRunner({
    store: () => fake.store,
    setLiveToolCalls: (u) => {
      live = typeof u === "function" ? u(live as never) : u
      h.live = live
    },
    loadSession: async () => session,
    resolveTarget: async () => (opts.target === undefined ? SIGNED_IN : opts.target),
    cancelRun: async (runId) => {
      cancels.push(runId)
    },
    buildRunInput,
    autoArchive: (id) => void archived.push(id),
    extractMemory: (text, _conv, o) => void memory.push({ text, tainted: o.tainted }),
    memoryEnabled: () => true,
    composeResumeInput: (turn) => ({ model: turn.model }),
    interruptedTurns: () => ({
      byConversation: turns,
      setInterruptedTurn: (t) => {
        turns[t.conversationId] = t
      },
      clearInterruptedTurn: (conv, runId) => {
        if (turns[conv] && (runId === undefined || turns[conv].runId === runId)) delete turns[conv]
      },
    }),
    activeRuns: {
      saveActiveRun: (r) => activeRun.saveActiveRun(r, storage),
      updateActiveRun: (c, id, p) => activeRun.updateActiveRun(c, id, p, storage),
      loadActiveRun: (c) => activeRun.loadActiveRun(c, storage),
      listActiveRuns: () => activeRun.listActiveRuns(storage),
      clearActiveRun: (c, id) => activeRun.clearActiveRun(c, id, storage),
    },
    runBases: {
      saveRunBase: (id, c) => runBase.saveRunBase(id, c, storage),
      loadRunBase: (id) => runBase.loadRunBase(id, storage),
      clearRunBase: (id) => runBase.clearRunBase(id, storage),
    },
    sessionOptions: { fetch: fetchImpl, tokens: storage, maxReconnects: 0 },
    isOffline: () => false,
    retryDelayMs: 5,
    cursorThrottleMs: 0,
    ...opts.deps,
  })
  const h: Harness = { runner, fake, storage, turns, memory, archived, cancels, live }
  return h
}

const user = (content: string, id = "u-1"): Message => ({ id, role: "user", content, timestamp: new Date() })

/** A response whose body the test feeds by hand. */
function openStream(): { response: Response; push: (s: string) => void; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const enc = new TextEncoder()
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    push: (s) => controller.enqueue(enc.encode(s)),
    end: () => controller.close(),
  }
}

function framesOf(name: string): string[] {
  return loadFixture(name)
    .body.split("\n\n")
    .filter(Boolean)
    .map((f) => `${f}\n\n`)
}

describe("send", () => {
  test("success: placeholder first, frames applied, finalised, pointer + hold released", async () => {
    const fixture = loadFixture("memory-interactive")
    const { fetch, calls } = fakeFetch(() => sseResponse(fixture.body))
    const h = harness(fetch, { initial: [user("hi")] })
    const body = bodyFor("memory-interactive")
    await h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body,
      target: SIGNED_IN,
      model: "anthropic/claude-haiku-4.5",
    })

    expect(calls[0].url).toBe("https://agent.example/v1/runs")
    const msgs = h.fake.conversation.messages
    expect(msgs).toHaveLength(2)
    const answer = msgs[1]
    expect(answer.role).toBe("assistant")
    expect(answer.content).toBe("Let me check.It is done.")
    expect(answer.toolCalls).toEqual([{ id: "c1", name: "lookup", argsLabel: undefined, summary: "Looked it up" }])
    expect(answer.error).toBeUndefined()
    expect(h.archived).toEqual([answer.id])
    // `RUN_FINISHED.result.memoryTainted` (the run read a tool result).
    expect(h.memory).toEqual([{ text: "User: hi\n\nAssistant: Let me check.It is done.", tainted: true }])
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
    expect(h.fake.state.typing.has(CONV)).toBe(false)
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
  })

  test("the pointer names the run while it streams, with its cursor", async () => {
    const live = openStream()
    const { fetch } = fakeFetch(() => live.response)
    const h = harness(fetch, { initial: [user("hi")] })
    const frames = framesOf("memory-interactive")
    const body = bodyFor("memory-interactive")
    const sending = h.runner.send({ conversationId: CONV, history: [user("hi")], body, target: SIGNED_IN })
    for (const f of frames.slice(0, 4)) live.push(f)
    await tick(20)
    // The sync hold, the placeholder (with the first text), the pointer.
    expect(h.fake.state.streaming.has(CONV)).toBe(true)
    const placeholder = h.fake.conversation.messages[1]
    expect(placeholder.content).toBe("Let me check.")
    expect(activeRun.loadActiveRun(CONV, h.storage)).toMatchObject({
      runId: body.runId,
      threadId: body.threadId,
      conversationId: CONV,
      messageId: placeholder.id,
      status: "running",
      anonymous: false,
    })
    expect(activeRun.loadActiveRun(CONV, h.storage)?.cursor).not.toBe("0")
    for (const f of frames.slice(4)) live.push(f)
    live.end()
    await sending
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
  })

  test("a run error surfaces on the message with the model", async () => {
    const { fetch } = fakeFetch(() => sseResponse(loadFixture("memory-error").body))
    const h = harness(fetch, { initial: [user("hi")] })
    await h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body: bodyFor("memory-error"),
      target: SIGNED_IN,
      model: "m",
    })
    const answer = h.fake.conversation.messages[1]
    expect(answer.content).toBe("partial ")
    expect(answer.error).toMatchObject({ code: "provider", model: "m", detail: "model stream broke" })
    expect(h.memory).toEqual([])
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
  })

  test("a network failure before output retries once with the same body", async () => {
    const fixture = loadFixture("memory-interactive")
    let n = 0
    const { fetch, calls } = fakeFetch(() => {
      n += 1
      if (n === 1) throw new TypeError("Failed to fetch")
      return sseResponse(fixture.body)
    })
    const h = harness(fetch, { initial: [user("hi")] })
    const body = bodyFor("memory-interactive")
    await h.runner.send({ conversationId: CONV, history: [user("hi")], body, target: SIGNED_IN })
    expect(calls).toHaveLength(2)
    expect((calls[1].body as StartRunRequest).runId).toBe(body.runId)
    expect(calls[1].body).toEqual(calls[0].body)
    // One placeholder, completed by the retry.
    expect(h.fake.conversation.messages).toHaveLength(2)
    expect(h.fake.conversation.messages[1].content).toBe("Let me check.It is done.")
    expect(h.fake.conversation.messages[1].error).toBeUndefined()
  })

  test("the retry happens once: a second network failure is the bubble", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new TypeError("Failed to fetch")
    })
    const h = harness(fetch, { initial: [user("hi")] })
    await h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body: bodyFor("memory-interactive"),
      target: SIGNED_IN,
    })
    expect(calls).toHaveLength(2)
    expect(h.fake.conversation.messages[1].error?.code).toBe("network")
  })

  test("a success without output is the empty-response bubble", async () => {
    const started = loadFixture("memory-interactive").items[0].event as unknown as {
      runId: string
      threadId: string
    }
    const body =
      `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: started.threadId, runId: started.runId })}\n\n` +
      `id: 1\ndata: ${JSON.stringify({ type: "RUN_FINISHED", threadId: started.threadId, runId: started.runId, outcome: { type: "success" }, result: { text: "" } })}\n\n`
    const { fetch } = fakeFetch(() => sseResponse(body))
    const h = harness(fetch, { initial: [user("hi")] })
    await h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body: bodyFor("memory-interactive"),
      target: SIGNED_IN,
    })
    expect(h.fake.conversation.messages[1].error).toMatchObject({
      code: "provider",
      detail: "The model returned an empty response.",
    })
  })
})

describe("stop", () => {
  function cancellable() {
    const frames = framesOf("memory-cancel")
    const live = openStream()
    const { fetch, calls } = fakeFetch((call: FakeCall) => {
      if (call.url.endsWith("/cancel")) {
        live.push(frames.at(-1)!)
        live.end()
        return new Response(JSON.stringify({ status: "cancelled" }), { status: 200 })
      }
      return live.response
    })
    return { frames, live, fetch, calls }
  }

  test("Stop cancels on the server; the partial answer stays, no error", async () => {
    const { frames, live, fetch, calls } = cancellable()
    const h = harness(fetch, { initial: [user("hi")] })
    const body = bodyFor("memory-cancel")
    const sending = h.runner.send({ conversationId: CONV, history: [user("hi")], body, target: SIGNED_IN })
    for (const f of frames.slice(0, -1)) live.push(f)
    await tick(20)
    expect(h.runner.stop(CONV)).toBe(true)
    await sending
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://agent.example/v1/runs",
      `POST https://agent.example/v1/runs/${body.runId}/cancel`,
    ])
    const answer = h.fake.conversation.messages[1]
    expect(answer.content).toBe("partial answer")
    expect(answer.error).toBeUndefined()
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
    expect(h.memory).toEqual([])
  })

  test("Stop before any output drops the empty placeholder", async () => {
    const { frames, live, fetch } = cancellable()
    const h = harness(fetch, { initial: [user("hi")] })
    const sending = h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body: bodyFor("memory-cancel"),
      target: SIGNED_IN,
    })
    live.push(frames[0])
    await tick(20)
    h.runner.stop(CONV)
    await sending
    expect(h.fake.conversation.messages).toHaveLength(1)
  })

  test("stop() is false for a conversation without a run", () => {
    const h = harness(fakeFetch(() => new Response("")).fetch)
    expect(h.runner.stop(CONV)).toBe(false)
  })
})

describe("interrupt → bridge → resume", () => {
  const interruptedBody = bodyFor("memory-interrupt-choice")
  const resumed = bodyFor("memory-resume-choice")
  // The resume run's id / thread are the recorded ones.
  const buildFixed = (input: Parameters<typeof buildRunInput>[0]) => ({
    ...buildRunInput(input),
    runId: resumed.runId,
    threadId: resumed.threadId,
  })

  async function interrupted(fetchImpl?: typeof fetch) {
    const calls: FakeCall[] = []
    let phase: "interrupt" | "resume" = "interrupt"
    const fallback = fakeFetch((call) => {
      calls.push(call)
      return sseResponse(loadFixture(phase === "interrupt" ? "memory-interrupt-choice" : "memory-resume-choice").body)
    }).fetch
    const h = harness(fetchImpl ?? fallback, {
      initial: [user("pick one")],
      deps: { buildRunInput: buildFixed },
    })
    await h.runner.send({
      conversationId: CONV,
      history: [user("pick one")],
      body: interruptedBody,
      target: SIGNED_IN,
      model: "anthropic/claude-haiku-4.5",
    })
    phase = "resume"
    return { h, calls }
  }

  test("an interrupt persists done tool calls, marks the pointer, hands the turn over", async () => {
    const { h } = await interrupted()
    const answer = h.fake.conversation.messages[1]
    expect(answer.content).toBe("Let me ask.")
    expect(answer.error).toBeUndefined()
    // The paused call is still running — not persisted.
    expect(answer.toolCalls).toBeUndefined()
    expect(activeRun.loadActiveRun(CONV, h.storage)).toMatchObject({
      runId: interruptedBody.runId,
      messageId: answer.id,
      status: "interrupted",
      model: "anthropic/claude-haiku-4.5",
    })
    expect(h.turns[CONV]).toMatchObject({
      conversationId: CONV,
      messageId: answer.id,
      runId: interruptedBody.runId,
      threadId: interruptedBody.threadId,
      anonymous: false,
      model: "anthropic/claude-haiku-4.5",
    })
    expect(h.turns[CONV].interrupts.map((i) => i.id)).toEqual(["c-ask"])
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
    expect(h.memory).toEqual([])
  })

  test("answering resumes into the same message; the turn is cleared", async () => {
    const { h, calls } = await interrupted()
    const turn = h.turns[CONV]
    const result = await h.runner.answerInterrupts(turn, { "c-ask": { selection: ["a"] } })
    expect(result).toEqual({ ok: true })
    const resumeCall = calls.at(-1)!
    expect(resumeCall.body).toMatchObject({
      runId: resumed.runId,
      forwardedProps: { model: "anthropic/claude-haiku-4.5", previousRunId: interruptedBody.runId },
      resume: [{ interruptId: "c-ask", status: "resolved", payload: { selection: ["a"] } }],
      messages: [{ role: "user", content: "pick one" }],
    })
    const msgs = h.fake.conversation.messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1].content).toBe("Let me ask.You picked A.")
    expect(msgs[1].toolCalls).toEqual([
      { id: "c-ask", name: "askUser", argsLabel: undefined, summary: "User selected: a" },
    ])
    expect(h.turns[CONV]).toBeUndefined()
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
    expect(runBase.loadRunBase(resumed.runId, h.storage)).toBeNull()
    expect(h.memory).toEqual([{ text: "User: pick one\n\nAssistant: Let me ask.You picked A.", tainted: false }])
  })

  test("a rejected resume (409 run_already_resumed) leaves the turn and the message alone", async () => {
    let phase = "interrupt"
    const { fetch } = fakeFetch(() =>
      phase === "interrupt"
        ? sseResponse(loadFixture("memory-interrupt-choice").body)
        : new Response(JSON.stringify({ code: "run_already_resumed", message: "answered elsewhere" }), {
            status: 409,
          }),
    )
    const { h } = await interrupted(fetch)
    phase = "resume"
    const turn = h.turns[CONV]
    const result = await h.runner.answerInterrupts(turn, { "c-ask": { selection: ["a"] } })
    expect(result).toMatchObject({ ok: false, code: "run_already_resumed", error: { detail: "answered elsewhere" } })
    const answer = h.fake.conversation.messages[1]
    expect(answer.content).toBe("Let me ask.")
    expect(answer.error).toBeUndefined()
    expect(h.turns[CONV]).toBe(turn)
    expect(activeRun.loadActiveRun(CONV, h.storage)?.status).toBe("interrupted")
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
  })

  test("an unanswered interrupt is refused before anything is sent", async () => {
    const { h, calls } = await interrupted()
    const before = calls.length
    const result = await h.runner.answerInterrupts(h.turns[CONV], {})
    expect(result).toMatchObject({ ok: false, code: "invalid_answers" })
    expect(calls).toHaveLength(before)
  })

  test("a new message while paused cancels the paused run first (Q35)", async () => {
    const { h } = await interrupted()
    await h.runner.supersedeInterrupted(CONV, SIGNED_IN)
    expect(h.cancels).toEqual([interruptedBody.runId])
    expect(h.turns[CONV]).toBeUndefined()
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
  })

  test("a failing cancel is ignored (Q35)", async () => {
    const { h } = await interrupted()
    const failing = harness(fakeFetch(() => new Response("")).fetch, {
      deps: {
        cancelRun: async () => {
          throw new Error("down")
        },
      },
    })
    failing.turns[CONV] = h.turns[CONV]
    await failing.runner.supersedeInterrupted(CONV, SIGNED_IN)
    expect(failing.turns[CONV]).toBeUndefined()
  })
})

describe("rejoin after a reload", () => {
  test("a running pointer is rejoined into its message: complete, not duplicated", async () => {
    const fixture = loadFixture("memory-rejoin-full")
    const { fetch, calls } = fakeFetch(() => sseResponse(fixture.body))
    const body = bodyFor("memory-rejoin-full")
    // What the page persisted before the reload: some text, a stale cursor.
    const answer: Message = { id: "a-1", role: "assistant", content: "first part", timestamp: new Date() }
    const h = harness(fetch, { initial: [user("go"), answer] })
    activeRun.saveActiveRun(
      {
        runId: body.runId,
        threadId: body.threadId,
        conversationId: CONV,
        messageId: "a-1",
        status: "running",
        cursor: "2",
        anonymous: false,
      },
      h.storage,
    )
    await h.runner.rejoinActive()
    await tick(50)
    expect(calls[0].url).toBe(`https://agent.example/v1/runs/${body.runId}/events`)
    const msg = h.fake.message("a-1")!
    expect(msg.content).toBe("first part second partFinished.")
    expect(msg.toolCalls).toEqual([{ id: "c1", name: "lookup", argsLabel: undefined, summary: "Looked it up" }])
    expect(h.fake.conversation.messages).toHaveLength(2)
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
    // The recorded run read a tool result: memory extraction is told so.
    expect(h.memory).toEqual([{ text: "User: go\n\nAssistant: first part second partFinished.", tainted: true }])
  })

  test("a run the backend forgot: pointer dropped, message left as persisted", async () => {
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ code: "not_found", message: "no such run" }), { status: 404 }),
    )
    const body = bodyFor("memory-rejoin-full")
    const answer: Message = { id: "a-1", role: "assistant", content: "first part", timestamp: new Date() }
    const h = harness(fetch, { initial: [user("go"), answer] })
    activeRun.saveActiveRun(
      {
        runId: body.runId,
        threadId: body.threadId,
        conversationId: CONV,
        messageId: "a-1",
        status: "running",
        cursor: "2",
        anonymous: false,
      },
      h.storage,
    )
    await h.runner.rejoinActive()
    await tick(50)
    expect(h.fake.message("a-1")).toMatchObject({ content: "first part" })
    expect(h.fake.message("a-1")?.error).toBeUndefined()
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
  })

  test("a resume run is rebuilt on top of the paused run's output (run base)", async () => {
    const resumed = loadFixture("memory-resume-choice")
    const { fetch } = fakeFetch(() => sseResponse(resumed.body))
    const body = bodyFor("memory-resume-choice")
    // Persisted mid-resume: the paused run's text + part of the resume's.
    const answer: Message = {
      id: "a-1",
      role: "assistant",
      content: "Let me ask.You pi",
      timestamp: new Date(),
    }
    const h = harness(fetch, { initial: [user("pick one"), answer] })
    runBase.saveRunBase(body.runId, runBase.countsOf({ content: "Let me ask." }), h.storage)
    activeRun.saveActiveRun(
      {
        runId: body.runId,
        threadId: body.threadId,
        conversationId: CONV,
        messageId: "a-1",
        status: "running",
        cursor: "0",
        anonymous: false,
      },
      h.storage,
    )
    await h.runner.rejoinActive()
    await tick(50)
    expect(h.fake.message("a-1")?.content).toBe("Let me ask.You picked A.")
    expect(runBase.loadRunBase(body.runId, h.storage)).toBeNull()
  })

  test("pointers whose message is gone are dropped; interrupted ones are left to the cards", async () => {
    const h = harness(fakeFetch(() => new Response("")).fetch, { initial: [user("go")] })
    const body = bodyFor("memory-rejoin-full")
    const other = bodyFor("memory-interrupt-choice")
    activeRun.saveActiveRun(
      { runId: body.runId, threadId: body.threadId, conversationId: CONV, messageId: "gone", status: "running", cursor: "0", anonymous: false },
      h.storage,
    )
    activeRun.saveActiveRun(
      { runId: other.runId, threadId: other.threadId, conversationId: "conv-2", messageId: "x", status: "interrupted", cursor: "0", anonymous: false },
      h.storage,
    )
    await h.runner.rejoinActive()
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
    expect(activeRun.loadActiveRun("conv-2", h.storage)?.status).toBe("interrupted")
  })

  test("off runs (no target): nothing is rejoined", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(""))
    const h = harness(fetch, { initial: [user("go")], target: null })
    const body = bodyFor("memory-rejoin-full")
    activeRun.saveActiveRun(
      { runId: body.runId, threadId: body.threadId, conversationId: CONV, messageId: "u-1", status: "running", cursor: "0", anonymous: false },
      h.storage,
    )
    await h.runner.rejoinActive()
    expect(calls).toHaveLength(0)
    expect(activeRun.loadActiveRun(CONV, h.storage)).not.toBeNull()
  })
})

describe("deleted conversations and unmount", () => {
  test("a deleted conversation's run is detached; its pointer and paused turn dropped", async () => {
    const live = openStream()
    const { fetch, calls } = fakeFetch(() => live.response)
    const h = harness(fetch, { initial: [user("hi")] })
    const frames = framesOf("memory-cancel")
    const sending = h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body: bodyFor("memory-cancel"),
      target: SIGNED_IN,
    })
    for (const f of frames.slice(0, 3)) live.push(f)
    await tick(20)
    expect(activeRun.loadActiveRun(CONV, h.storage)).not.toBeNull()
    h.runner.forgetDeleted([], [{ id: CONV }])
    await sending
    expect(calls).toHaveLength(1) // detached, not cancelled
    expect(activeRun.loadActiveRun(CONV, h.storage)).toBeNull()
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
    expect(h.runner.has(CONV)).toBe(false)
  })

  test("unmount detaches and releases the hold at once; the pointer stays for the rejoin", async () => {
    const live = openStream()
    const { fetch } = fakeFetch(() => live.response)
    const h = harness(fetch, { initial: [user("hi")] })
    const frames = framesOf("memory-cancel")
    const sending = h.runner.send({
      conversationId: CONV,
      history: [user("hi")],
      body: bodyFor("memory-cancel"),
      target: SIGNED_IN,
    })
    for (const f of frames.slice(0, 4)) live.push(f)
    await tick(20)
    h.runner.detachAll()
    expect(h.fake.state.streaming.has(CONV)).toBe(false)
    await sending
    expect(activeRun.loadActiveRun(CONV, h.storage)?.status).toBe("running")
    expect(h.fake.conversation.messages[1].content).toBe("partial answer")
  })
})
