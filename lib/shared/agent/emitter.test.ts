import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "./events"
import { RunEmitter } from "./emitter"
import { EMPTY_RUN_VIEW, projectRun, reduceRun } from "./project"

function collect(opts?: { maxSteps?: number }) {
  const events: TaskEvent[] = []
  let tick = 0
  const em = new RunEmitter(
    { runId: "r1", maxSteps: opts?.maxSteps, now: () => new Date(++tick * 1000).toISOString() },
    (e) => events.push(e)
  )
  return { em, events }
}

describe("RunEmitter — sequencing invariants", () => {
  test("seq is strictly monotonic from 1", () => {
    const { em, events } = collect()
    em.status("running")
    em.token("a")
    em.token("b")
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  test("step starts at 0 and advances only via startStep", () => {
    const { em, events } = collect()
    em.status("running") // step 0
    expect(em.step).toBe(0)
    em.startStep() // → 1
    em.token("x") // step 1
    em.startStep() // → 2
    em.token("y") // step 2
    expect(em.step).toBe(2)
    const steps = events.map((e) => e.step)
    expect(steps).toEqual([0, 1, 1, 2, 2])
  })

  test("createdAt comes from the injected clock", () => {
    const { em, events } = collect()
    em.status("running")
    expect(events[0].createdAt).toBe(new Date(1000).toISOString())
  })

  test("maxSteps rides the status event", () => {
    const { em, events } = collect({ maxSteps: 8 })
    em.status("running")
    expect(events[0]).toMatchObject({ kind: "status", status: "running", maxSteps: 8 })
  })
})

describe("RunEmitter — settle semantics", () => {
  test("emits drop after result()", () => {
    const { em, events } = collect()
    em.status("running")
    em.result("done", { finalText: "fin" })
    expect(em.settled).toBe(true)
    // Late callbacks must not append past the end.
    em.token("late")
    em.toolOutput("t1", "x", "late")
    expect(events).toHaveLength(2) // status + result only
    expect(events.at(-1)).toMatchObject({ kind: "result", status: "done" })
  })

  test("a terminal status (cancelled) settles the run", () => {
    const { em, events } = collect()
    em.status("running")
    em.status("cancelled")
    em.token("after") // dropped
    expect(em.settled).toBe(true)
    expect(events).toHaveLength(2)
  })

  test("non-terminal status does not settle", () => {
    const { em } = collect()
    em.status("running")
    em.status("paused")
    expect(em.settled).toBe(false)
  })
})

describe("RunEmitter — tool + plan + error payloads", () => {
  test("toolOutput carries results only when provided", () => {
    const { em, events } = collect()
    em.toolInput("t1", "webSearch", { query: "q" })
    em.toolOutput("t1", "webSearch", "1 result", [
      { title: "T", url: "https://t", snippet: "s" },
    ])
    em.toolOutput("t2", "webFetch", "ok")
    const withResults = events.find((e) => e.kind === "tool_output" && "results" in e)
    expect(withResults).toBeDefined()
    const withoutResults = events.find(
      (e) => e.kind === "tool_output" && !("results" in e)
    )
    expect(withoutResults).toMatchObject({ toolName: "webFetch", summary: "ok" })
  })

  test("plan + stepError + artifactRef emit the expected kinds", () => {
    const { em, events } = collect()
    em.plan([{ id: "1", text: "do x", status: "in_progress" }])
    em.stepError("flaky", true)
    em.artifactRef("a1")
    expect(events.map((e) => e.kind)).toEqual(["plan", "step_error", "artifact_ref"])
  })

  test("startSeq / startStep seed counters for a HITL continuation", () => {
    const events: TaskEvent[] = []
    let tick = 0
    const em = new RunEmitter(
      {
        runId: "r1",
        now: () => new Date(++tick * 1000).toISOString(),
        startSeq: 12,
        startStep: 3,
      },
      (e) => events.push(e)
    )
    em.status("running")
    em.startStep() // continues from step 3 → 4
    em.token("hi")
    expect(events.map((e) => e.seq)).toEqual([13, 14, 15])
    expect(events.map((e) => e.step)).toEqual([3, 4, 4])
  })
})

describe("RunEmitter ↔ projectRun — producer/consumer agree", () => {
  test("a realistic linear run round-trips into a coherent view", () => {
    const { em, events } = collect({ maxSteps: 5 })
    em.status("running")
    em.startStep()
    em.token("Researching", "reasoning")
    em.plan([
      { id: "1", text: "search", status: "in_progress" },
      { id: "2", text: "write", status: "pending" },
    ])
    em.toolInput("t1", "webSearch", { query: "react frameworks" })
    em.toolOutput("t1", "webSearch", "3 results", [
      { title: "A", url: "https://a", snippet: "sa" },
    ])
    em.endStep()
    em.startStep()
    em.plan([
      { id: "1", text: "search", status: "completed" },
      { id: "2", text: "write", status: "in_progress" },
    ])
    em.token("Here is the comparison.")
    em.result("done")
    em.endStep() // dropped — already settled

    const view = projectRun(events)
    expect(view.status).toBe("done")
    expect(view.step).toBe(2)
    expect(view.maxSteps).toBe(5)
    expect(view.reasoning).toBe("Researching")
    expect(view.text).toBe("Here is the comparison.")
    expect(view.resultText).toBe("Here is the comparison.") // falls back to token text
    expect(view.plan.map((p) => p.status)).toEqual(["completed", "in_progress"])
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({ status: "done", summary: "3 results" })
    // cursor = last accepted seq; the post-settle endStep was dropped.
    expect(view.cursor).toBe(events.at(-1)!.seq)
    expect(events.at(-1)).toMatchObject({ kind: "result" })
  })

  test("incremental reduce matches whole-log project (live tail == cold render)", () => {
    const { em, events } = collect()
    em.status("running")
    em.startStep()
    em.token("hello ")
    em.token("world")
    em.result("done")

    // Fold incrementally (as a live client tailing the stream would)
    // vs. all-at-once (cold render / resume). They must agree.
    const cold = projectRun(events)
    let warm = EMPTY_RUN_VIEW
    for (const e of events) warm = reduceRun(warm, e)
    expect(warm).toEqual(cold)
  })
})
