/**
 * The AG-UI → store step, table-driven over run streams recorded from
 * agent-py (`fixtures/agent-py/`, `bun run fixtures:runs`). Each case folds
 * a whole recorded stream with the pure reducer, applies the ops to a
 * model of the store message, and checks what chat would show.
 */

import { describe, expect, test } from "bun:test"

import { fixtureNames, loadFixture, messageOf, ModelSink, type ModelMessage } from "./fixtures"
import {
  framesFromView,
  hasOutput,
  initialRunTurnState,
  reduceRunEvent,
  reduceRunEvents,
  viewFromMessages,
  type RunOutcome,
  type RunTurnOp,
} from "./reducer"
import { applyRunOps } from "./session"

function fold(name: string): { ops: RunTurnOp[]; message: ModelMessage; outcome: RunOutcome | null } {
  const { items } = loadFixture(name)
  const { state, ops } = reduceRunEvents(items.map((i) => i.event))
  const sink = new ModelSink()
  applyRunOps(sink, ops)
  return { ops, message: sink.message, outcome: state.outcome }
}

function calls(m: ModelMessage): Expect["toolCalls"] {
  return m.toolCalls.map((c) => ({ id: c.id, name: c.name, status: c.status, summary: c.summary }))
}

interface Expect {
  content: string
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; status: "running" | "done"; summary?: string }>
  outcome: Partial<RunOutcome> & { type: RunOutcome["type"] }
  extra?: (r: ReturnType<typeof fold>) => void
}

const LOOKUP = { id: "c1", name: "lookup", status: "done" as const, summary: "Looked it up" }

const CASES: Record<string, Expect> = {
  "memory-interactive": {
    content: "Let me check.It is done.",
    toolCalls: [LOOKUP],
    outcome: { type: "success", memoryTainted: true },
  },
  "memory-anonymous": {
    content: "Hello, stranger.",
    outcome: { type: "success", memoryTainted: false },
  },
  "memory-cancel": { content: "partial answer", outcome: { type: "cancelled" } },
  // generateImage on runs: the image part follows the tool result (wave 4b-D).
  "memory-generated-image": {
    content: "Drawing.Here is your fox.",
    toolCalls: [{ id: "c-img", name: "generateImage", status: "done", summary: "1 image (t2i)" }],
    outcome: { type: "success", memoryTainted: false },
    extra: ({ message }) => {
      expect(message.images).toEqual([
        expect.objectContaining({
          id: "c-img-0",
          url: "https://storage.example/u/generated/fox.png",
          storagePath: "u/generated/fox.png",
          prompt: "a red fox",
          mode: "t2i",
        }),
      ])
    },
  },
  "memory-error": {
    content: "partial ",
    outcome: { type: "error", code: "upstream" },
    extra: ({ outcome }) => {
      expect(outcome?.type === "error" && outcome.error.code).toBe("provider")
    },
  },
  "memory-interrupt-signed_in": {
    content: "Looking up, then sending.",
    toolCalls: [LOOKUP, { id: "c2", name: "send", status: "running", summary: undefined }],
    outcome: { type: "interrupt" },
    extra: ({ outcome }) => {
      if (outcome?.type !== "interrupt") throw new Error("not an interrupt")
      const [i] = outcome.interrupts
      expect(outcome.interrupts).toHaveLength(1)
      expect(i).toMatchObject({ id: "c2", reason: "approval", toolCallId: "c2", tool: "send", args: { to: "bob" } })
    },
  },
  "memory-interrupt-anonymous": {
    content: "Looking up, then sending.",
    toolCalls: [LOOKUP, { id: "c2", name: "send", status: "running", summary: undefined }],
    outcome: { type: "interrupt" },
  },
  // A resume run on a fresh state: the answered call started in the
  // previous run, so the reducer announces it before its result.
  "memory-resume-signed_in": {
    content: "Sent it.",
    toolCalls: [{ id: "c2", name: "send", status: "done", summary: "Sent" }],
    outcome: { type: "success", memoryTainted: true },
  },
  "memory-resume-anonymous": {
    content: "Sent it.",
    toolCalls: [{ id: "c2", name: "send", status: "done", summary: "Sent" }],
    outcome: { type: "success" },
  },
  "memory-interrupt-choice": {
    content: "Let me ask.",
    toolCalls: [{ id: "c-ask", name: "askUser", status: "running", summary: undefined }],
    outcome: { type: "interrupt" },
    extra: ({ outcome }) => {
      if (outcome?.type !== "interrupt") throw new Error("not an interrupt")
      expect(outcome.interrupts[0]).toMatchObject({
        id: "c-ask",
        reason: "choice",
        message: "Which one?",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      })
    },
  },
  "memory-resume-choice": {
    content: "You picked A.",
    toolCalls: [{ id: "c-ask", name: "askUser", status: "done", summary: "User selected: a" }],
    outcome: { type: "success", memoryTainted: false },
  },
  "memory-interrupt-ui": {
    content: "One moment.",
    toolCalls: [{ id: "c-ui", name: "renderUI", status: "running", summary: undefined }],
    outcome: { type: "interrupt" },
    extra: ({ outcome }) => {
      if (outcome?.type !== "interrupt") throw new Error("not an interrupt")
      expect(outcome.interrupts[0]).toMatchObject({
        reason: "ui-part",
        uiKind: "confirm",
        uiProps: { prompt: "Sure?" },
      })
    },
  },
  "memory-resume-ui": {
    content: "Done.",
    toolCalls: [{ id: "c-ui", name: "renderUI", status: "done", summary: "Yes" }],
    outcome: { type: "success", memoryTainted: false },
  },
  "memory-rejoin-full": {
    content: "first part second partFinished.",
    toolCalls: [LOOKUP],
    outcome: { type: "success" },
  },
  "memory-rejoin-after-0": {
    content: "first part second partFinished.",
    toolCalls: [LOOKUP],
    outcome: { type: "success" },
  },
  // Tails of the same run, from a mid-run cursor: the reducer needs no
  // context (but @ag-ui/client's verifier does — see session.test.ts).
  "memory-rejoin-after-2.0": {
    content: "first part second partFinished.",
    toolCalls: [LOOKUP],
    outcome: { type: "success" },
  },
  "memory-rejoin-after-2": {
    content: " second partFinished.",
    toolCalls: [LOOKUP],
    outcome: { type: "success" },
  },
  "stream-reasoning": {
    content: "It is blue.",
    reasoning: "Look it up.",
    toolCalls: [{ id: "tc1", name: "webSearch", status: "done", summary: "1 result" }],
    outcome: { type: "success", memoryTainted: true },
    extra: ({ message }) => {
      expect(message.routedModel).toBe("anthropic/claude-sonnet-4.6")
      expect(message.toolCalls[0].argsLabel).toBe("sky colour")
      expect(message.toolCalls[0].results).toEqual([
        { title: "Sky", url: "https://sky.example", snippet: "It is blue." },
      ])
    },
  },
  "stream-parts": {
    content: "Here you go.",
    toolCalls: [
      { id: "img1", name: "generateImage", status: "done", summary: "1 image" },
      { id: "code1", name: "runCode", status: "done", summary: "Ran" },
      { id: "ui1", name: "renderUI", status: "done", summary: "Rendered" },
      { id: "app1", name: "mcp__srv__show", status: "done", summary: "Shown" },
    ],
    outcome: { type: "success", memoryTainted: false },
    extra: ({ message }) => {
      expect(message.images).toHaveLength(1)
      expect(message.files).toEqual([
        expect.objectContaining({ id: "f1", name: "out.csv", mimeType: "text/csv" }),
      ])
      expect(message.codeResults).toEqual([
        { id: "code1", stdout: "1\n", stderr: "", results: [{ type: "text", value: "1" }] },
      ])
      expect(message.uiParts).toEqual([{ id: "ui1" }])
      expect(message.mcpApps).toEqual([{ id: "app1" }])
      expect(message.suggestions).toEqual(["Why blue?", "Draw a dog"])
      expect(message.verification).toMatchObject({ checks: [{ claim: "It is blue." }] })
      expect(message.routedModel).toBe("anthropic/claude-sonnet-4.6")
    },
  },
  // Gap + MESSAGES_SNAPSHOT: one reset rebuilds exactly the live result.
  "stream-compacted": {
    content: "It is blue.",
    reasoning: "Look it up.",
    toolCalls: [{ id: "tc1", name: "webSearch", status: "done", summary: "1 result" }],
    outcome: { type: "success", memoryTainted: true },
    extra: ({ ops, message }) => {
      expect(ops.filter((o) => o.type === "reset")).toHaveLength(1)
      expect(message).toEqual(fold("stream-reasoning").message)
    },
  },
  "stream-compacted-after-4.1": {
    content: "It is blue.",
    reasoning: "Look it up.",
    toolCalls: [{ id: "tc1", name: "webSearch", status: "done", summary: "1 result" }],
    outcome: { type: "success" },
  },
  "stream-purged": {
    content: "",
    outcome: { type: "success", memoryTainted: false },
    extra: ({ ops }) => expect(ops[0]).toEqual({ type: "reset", frames: [] }),
  },
  // Replay drops the dead attempt; the marker discards nothing.
  "stream-rewind-replay": {
    content: "Checking. Done.",
    outcome: { type: "success" },
    extra: ({ ops }) => expect(ops).toContainEqual({ type: "rewind", after: 3 }),
  },
  // Live, the reducer reports the rewind; discarding is the session's job.
  "stream-rewind-live": {
    content: "Checking. dead attemptDone.",
    outcome: { type: "success" },
    extra: ({ ops }) => expect(ops).toContainEqual({ type: "rewind", after: 3 }),
  },
  "stream-failed": {
    content: "Trying. ",
    toolCalls: [{ id: "tc1", name: "webSearch", status: "done", summary: "Search failed: quota" }],
    outcome: { type: "error", code: "rate_limit", message: "Rate limited by the provider." },
    extra: ({ outcome }) => {
      expect(outcome?.type === "error" && outcome.error).toEqual({
        code: "rate_limit",
        detail: "Rate limited by the provider.",
      })
    },
  },
  "stream-cancelled": { content: "partial", outcome: { type: "cancelled" } },
}

describe("reduceRunEvent over recorded agent-py streams", () => {
  test("every recorded stream has a case", () => {
    expect(fixtureNames()).toEqual(Object.keys(CASES).sort())
  })

  for (const [name, want] of Object.entries(CASES)) {
    test(name, () => {
      const r = fold(name)
      expect(r.message.content).toBe(want.content)
      expect(r.message.reasoning).toBe(want.reasoning ?? "")
      expect(calls(r.message)).toEqual(want.toolCalls ?? [])
      expect(r.outcome).toMatchObject(want.outcome)
      // `finished` is the last op, once.
      expect(r.ops.filter((o) => o.type === "finished")).toHaveLength(1)
      expect(r.ops.at(-1)?.type).toBe("finished")
      want.extra?.(r)
    })
  }
})

describe("invariants over every recorded stream", () => {
  for (const name of Object.keys(CASES)) {
    test(`${name}: the ops rebuild exactly framesFromView(final view)`, () => {
      const { items } = loadFixture(name)
      const { state, ops } = reduceRunEvents(items.map((i) => i.event))
      const sink = new ModelSink()
      applyRunOps(sink, ops)
      expect(sink.message).toEqual(messageOf(framesFromView(state.view)))
    })
  }

  test("a snapshot's view equals the live view of the same run", () => {
    const live = reduceRunEvents(loadFixture("stream-reasoning").items.map((i) => i.event)).state
    const snapshot = loadFixture("stream-compacted").items.find(
      (i) => i.event.type === "MESSAGES_SNAPSHOT",
    )!.event as unknown as { messages: Parameters<typeof viewFromMessages>[0] }
    const fromSnapshot = viewFromMessages(snapshot.messages)
    expect(messageOf(framesFromView(fromSnapshot))).toEqual(messageOf(framesFromView(live.view)))
  })
})

describe("reducer edges", () => {
  const started = { type: "RUN_STARTED", threadId: "t", runId: "r" } as const

  test("events after the end are ignored", () => {
    const { state } = reduceRunEvents([
      started,
      { type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: { type: "cancelled" } },
    ] as never)
    const next = reduceRunEvent(state, { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "x" } as never)
    expect(next.ops).toEqual([])
    expect(next.state).toBe(state)
  })

  test("a MESSAGES_SNAPSHOT without a gap is not this run's output and is ignored", () => {
    const { state, ops } = reduceRunEvents([
      started,
      { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "kept" },
      { type: "MESSAGES_SNAPSHOT", messages: [] },
    ] as never)
    expect(state.view.text).toBe("kept")
    expect(ops.some((o) => o.type === "reset")).toBe(false)
  })

  test("unknown events and CUSTOM names produce nothing", () => {
    const s = initialRunTurnState()
    expect(reduceRunEvent(s, { type: "SOMETHING_NEW" } as never).ops).toEqual([])
    expect(reduceRunEvent(s, { type: "CUSTOM", name: "hummingbird.step_error", value: {} } as never).ops).toEqual(
      [],
    )
  })

  test("replacing an appended part resets the message; a set part re-applies", () => {
    const content = { id: "c1", stdout: "1", stderr: "", results: [] }
    const snap = (c: unknown, type = "hummingbird.code_result", id = "r:code_result:c1") => ({
      type: "ACTIVITY_SNAPSHOT",
      messageId: id,
      activityType: type,
      content: c,
      replace: true,
    })
    let { state, ops } = reduceRunEvents([started, snap(content)] as never)
    expect(ops.map((o) => o.type)).toEqual(["frame"])
    ;({ state, ops } = reduceRunEvents([snap({ ...content, stdout: "2" })] as never, state))
    expect(ops.map((o) => o.type)).toEqual(["reset"])
    const s1 = snap({ values: ["a"] }, "hummingbird.suggestions", "r:suggestions")
    const s2 = snap({ values: ["b"] }, "hummingbird.suggestions", "r:suggestions")
    ;({ ops } = reduceRunEvents([s1, s2] as never, state))
    expect(ops.map((o) => o.type)).toEqual(["frame", "frame"])
  })

  test("an MCP App part (wave 5b-D) becomes the mcp_app frame the chat renders", () => {
    const content = { id: "c2", serverId: "srv-2", html: "<h1>panel</h1>", resourceUri: "ui://fake/panel" }
    const { ops } = reduceRunEvents([
      started,
      {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "r:mcp_app:c2",
        activityType: "hummingbird.mcp_app",
        content,
        replace: true,
      },
    ] as never)
    expect(ops).toEqual([{ type: "frame", frame: { type: "mcp_app", ...content } }])
  })

  test("hasOutput: plan / routed-model / suggestions alone are no answer", () => {
    const part = (activityType: string, content: unknown) => ({
      type: "ACTIVITY_SNAPSHOT",
      messageId: `r:${activityType}`,
      activityType,
      content,
      replace: true,
    })
    const { state } = reduceRunEvents([
      started,
      part("hummingbird.plan", { items: [] }),
      part("hummingbird.routed_model", { model: "m" }),
      part("hummingbird.suggestions", { values: ["x"] }),
    ] as never)
    expect(hasOutput(state.view)).toBe(false)
    expect(hasOutput(reduceRunEvents(loadFixture("memory-interrupt-ui").items.map((i) => i.event)).state.view)).toBe(
      true,
    )
  })
})
