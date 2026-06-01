/**
 * Phase 2 tests — RunEmitter.
 *
 * Mirrors agent-py's `test_emitter.py`. Confirms the monotonic seq
 * + settled-once invariants the runner depends on.
 */

import { describe, test, expect } from "bun:test"

import { RunEmitter } from "../src/emitter"
import type { TaskEvent } from "../src/events"

function makeBuffer(): {
  sink: (e: TaskEvent) => Promise<void>
  events: TaskEvent[]
} {
  const events: TaskEvent[] = []
  return {
    events,
    sink: async (e) => {
      events.push(e)
    },
  }
}

describe("RunEmitter", () => {
  test("seq is monotonic across emits", async () => {
    const { sink, events } = makeBuffer()
    const e = new RunEmitter({ runId: "r1", sink })
    await e.ensureRunning()
    await e.token("a")
    await e.token("b")
    await e.result("done")
    expect(events.map((x) => x.seq)).toEqual([0, 1, 2, 3])
  })

  test("ensureRunning is idempotent — only one status event", async () => {
    const { sink, events } = makeBuffer()
    const e = new RunEmitter({ runId: "r1", sink })
    await e.ensureRunning()
    await e.ensureRunning()
    await e.ensureRunning()
    expect(events.filter((x) => x.kind === "status").length).toBe(1)
  })

  test("result is settle-once — subsequent emits no-op", async () => {
    const { sink, events } = makeBuffer()
    const e = new RunEmitter({ runId: "r1", sink })
    await e.ensureRunning()
    await e.result("done")
    await e.token("ignored")
    await e.result("failed")
    expect(events.filter((x) => x.kind === "result").length).toBe(1)
    expect(events.filter((x) => x.kind === "token").length).toBe(0)
    expect(e.settled).toBe(true)
  })

  test("stepStart bumps step counter before emit", async () => {
    const { sink, events } = makeBuffer()
    const e = new RunEmitter({ runId: "r1", sink })
    await e.stepStart()
    await e.token("first")
    await e.stepStart()
    await e.token("second")
    const tokens = events.filter((x) => x.kind === "token") as Array<{ step: number; text: string }>
    expect(tokens[0]?.step).toBe(1)
    expect(tokens[1]?.step).toBe(2)
  })

  test("startSeq / startStep seed the counters (Phase 3a resume)", async () => {
    const { sink, events } = makeBuffer()
    const e = new RunEmitter({
      runId: "r1",
      sink,
      startSeq: 10,
      startStep: 3,
    })
    await e.token("resumed")
    expect(events[0]?.seq).toBe(10)
    expect(events[0]?.step).toBe(3)
  })

  test("status() rejects terminal values", async () => {
    const { sink } = makeBuffer()
    const e = new RunEmitter({ runId: "r1", sink })
    await expect(e.status("done" as never)).rejects.toThrow(/terminal/)
  })

  test("empty token strings are dropped", async () => {
    const { sink, events } = makeBuffer()
    const e = new RunEmitter({ runId: "r1", sink })
    await e.token("")
    await e.token("real")
    expect(events.filter((x) => x.kind === "token").length).toBe(1)
  })
})
