import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "@/shared/agent/events"
import { RunEmitter } from "@/shared/agent/emitter"
import { projectRun } from "@/shared/agent/project"
import { makeTokenCoalescer } from "./runner"

function harness() {
  const events: TaskEvent[] = []
  let tick = 0
  const emitter = new RunEmitter(
    { runId: "r1", now: () => new Date(++tick).toISOString() },
    (e) => events.push(e)
  )
  emitter.startStep()
  return { emitter, events }
}

const tokens = (events: TaskEvent[]) =>
  events.filter((e): e is Extract<TaskEvent, { kind: "token" }> => e.kind === "token")

describe("makeTokenCoalescer", () => {
  test("buffers small deltas and flushes once at the threshold", () => {
    const { emitter, events } = harness()
    const c = makeTokenCoalescer(emitter, 8)
    for (const ch of "abcdefg") c.push("text", ch) // 7 chars, under 8
    expect(tokens(events)).toHaveLength(0)
    c.push("text", "h") // hits 8 → flush
    const t = tokens(events)
    expect(t).toHaveLength(1)
    expect(t[0].text).toBe("abcdefgh")
  })

  test("flushAll emits the trailing remainder once", () => {
    const { emitter, events } = harness()
    const c = makeTokenCoalescer(emitter, 100)
    c.push("text", "hello ")
    c.push("text", "world")
    expect(tokens(events)).toHaveLength(0)
    c.flushAll()
    expect(tokens(events)).toHaveLength(1)
    expect(tokens(events)[0].text).toBe("hello world")
    c.flushAll() // idempotent — nothing buffered
    expect(tokens(events)).toHaveLength(1)
  })

  test("switching channels flushes the other first, preserving order", () => {
    const { emitter, events } = harness()
    const c = makeTokenCoalescer(emitter, 100)
    c.push("reasoning", "think")
    c.push("text", "answer") // flushes reasoning before buffering text
    c.flushAll()
    const t = tokens(events)
    expect(t.map((e) => [e.channel ?? "text", e.text])).toEqual([
      ["reasoning", "think"],
      ["text", "answer"],
    ])
    // Projected text/reasoning reconstruct exactly.
    const view = projectRun(events)
    expect(view.text).toBe("answer")
    expect(view.reasoning).toBe("think")
  })

  test("ignores empty deltas", () => {
    const { emitter, events } = harness()
    const c = makeTokenCoalescer(emitter, 4)
    c.push("text", "")
    c.flushAll()
    expect(tokens(events)).toHaveLength(0)
  })
})
