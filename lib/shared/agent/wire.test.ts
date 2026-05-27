import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "./events"
import { RunEmitter } from "./emitter"
import { projectRun } from "./project"
import {
  AGENT_EVENT_PART_TYPE,
  fromDataPart,
  fromDataParts,
  toDataPart,
  TaskEventSchema,
} from "./wire"

function event(over: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent {
  return {
    runId: "r1",
    seq: 1,
    step: 0,
    createdAt: new Date(0).toISOString(),
    ...over,
  } as TaskEvent
}

describe("toDataPart / fromDataPart — round-trip per kind", () => {
  const samples: TaskEvent[] = [
    event({ kind: "token", text: "hi", channel: "reasoning" }),
    event({ kind: "tool_input", toolCallId: "t1", toolName: "webSearch", args: { q: "x" } }),
    event({
      kind: "tool_output",
      toolCallId: "t1",
      toolName: "webSearch",
      summary: "1 result",
      results: [{ title: "A", url: "https://a", snippet: "s" }],
    }),
    event({ kind: "step_start" }),
    event({ kind: "step_end" }),
    event({ kind: "status", status: "running", maxSteps: 5 }),
    event({ kind: "plan", items: [{ id: "1", text: "do", status: "pending" }] }),
    event({ kind: "step_error", message: "flaky", willRetry: true }),
    event({ kind: "handoff", agent: "researcher", phase: "enter" }),
    event({ kind: "approval", approvalId: "a1", phase: "response", approved: true }),
    event({ kind: "compact", summary: "folded 10 msgs" }),
    event({ kind: "artifact_ref", artifactId: "art1" }),
    event({ kind: "result", status: "done", finalText: "fin" }),
  ]

  for (const s of samples) {
    test(`${s.kind} survives encode → decode`, () => {
      const part = toDataPart(s)
      expect(part.type).toBe(AGENT_EVENT_PART_TYPE)
      expect(fromDataPart(part)).toEqual(s)
    })
  }
})

describe("fromDataPart — graceful rejection (never throws, returns null)", () => {
  test("non-object input", () => {
    expect(fromDataPart(null)).toBeNull()
    expect(fromDataPart(undefined)).toBeNull()
    expect(fromDataPart("nope")).toBeNull()
    expect(fromDataPart(42)).toBeNull()
  })

  test("a native AI-SDK part (wrong type) is rejected", () => {
    expect(fromDataPart({ type: "text-delta", id: "1", delta: "hi" })).toBeNull()
  })

  test("a foreign data part (different data-* name) is rejected", () => {
    expect(fromDataPart({ type: "data-something-else", data: {} })).toBeNull()
  })

  test("right type but malformed payload is rejected", () => {
    expect(
      fromDataPart({ type: AGENT_EVENT_PART_TYPE, data: { kind: "token" } }) // missing base fields
    ).toBeNull()
    expect(
      fromDataPart({ type: AGENT_EVENT_PART_TYPE, data: { ...event({ kind: "status" }) } }) // status missing `status`
    ).toBeNull()
  })

  test("a future/unknown kind is rejected (consumer predates it)", () => {
    const future = {
      type: AGENT_EVENT_PART_TYPE,
      data: { runId: "r1", seq: 1, step: 0, createdAt: "t", kind: "memory_write", key: "x" },
    }
    expect(fromDataPart(future)).toBeNull()
  })
})

describe("fromDataParts — batch drops invalid, keeps valid", () => {
  test("mixed batch", () => {
    const parts: unknown[] = [
      toDataPart(event({ kind: "token", text: "a" })),
      { type: "text-delta", id: "x", delta: "ignore" }, // foreign
      toDataPart(event({ kind: "result", status: "done" })),
      null,
    ]
    const events = fromDataParts(parts)
    expect(events.map((e) => e.kind)).toEqual(["token", "result"])
  })
})

describe("TaskEventSchema — direct validation", () => {
  test("accepts a valid event", () => {
    expect(TaskEventSchema.safeParse(event({ kind: "token", text: "x" })).success).toBe(true)
  })
  test("rejects negative seq", () => {
    expect(
      TaskEventSchema.safeParse(event({ kind: "token", text: "x", seq: -1 })).success
    ).toBe(false)
  })
})

describe("wire codec ↔ full pipeline — emit → encode → decode → project", () => {
  test("a run survives a full wire round-trip into a coherent view", () => {
    const wireParts: AgentEventPartLike[] = []
    let tick = 0
    const em = new RunEmitter(
      { runId: "r1", maxSteps: 3, now: () => new Date(++tick).toISOString() },
      // Sink encodes to the wire immediately, as the route would.
      (e) => wireParts.push(toDataPart(e) as AgentEventPartLike)
    )
    em.status("running")
    em.startStep()
    em.token("Working", "reasoning")
    em.toolInput("t1", "webFetch", { url: "https://x" })
    em.toolOutput("t1", "webFetch", "fetched")
    em.token("Done.")
    em.result("done")

    // Serialize through JSON to simulate the actual transport, then
    // decode + project on the "client".
    const overWire: unknown[] = JSON.parse(JSON.stringify(wireParts))
    const decoded = fromDataParts(overWire)
    const view = projectRun(decoded)

    expect(view.status).toBe("done")
    expect(view.reasoning).toBe("Working")
    expect(view.text).toBe("Done.")
    expect(view.toolCalls[0]).toMatchObject({ toolName: "webFetch", status: "done" })
    expect(view.maxSteps).toBe(3)
    expect(decoded).toHaveLength(wireParts.length)
  })
})

type AgentEventPartLike = ReturnType<typeof toDataPart>
