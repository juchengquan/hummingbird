import { describe, expect, test } from "bun:test"

import { createThrottle, planRunOutcome, pointerActionFor, type RunOutcomeInputs } from "./chat-outcome"
import type { RunOutcome } from "./reducer"

const base: Omit<RunOutcomeInputs, "outcome"> = {
  turn: "send",
  hasOutput: true,
  started: true,
  isRetry: false,
  offline: false,
  model: "m",
}

const error = (code: string): RunOutcome => ({
  type: "error",
  code,
  message: code,
  error: { code: code === "network" ? "network" : "unknown", detail: code },
})

describe("planRunOutcome", () => {
  test("detached → leave everything", () => {
    expect(planRunOutcome({ ...base, outcome: null })).toEqual({ kind: "detached" })
  })

  test("success → finalise with the taint; without output → the empty-response bubble", () => {
    const success: RunOutcome = { type: "success", result: { text: "x" }, memoryTainted: true }
    expect(planRunOutcome({ ...base, outcome: success })).toEqual({ kind: "finalize", tainted: true })
    expect(planRunOutcome({ ...base, outcome: success, hasOutput: false })).toEqual({
      kind: "empty",
      error: { code: "provider", model: "m", detail: "The model returned an empty response." },
    })
    // A resume continues a message that has output already.
    expect(planRunOutcome({ ...base, turn: "resume", outcome: success, hasOutput: false }).kind).toBe("finalize")
  })

  test("network before output on a send → retry once (online)", () => {
    const o = error("network")
    expect(planRunOutcome({ ...base, outcome: o, hasOutput: false })).toEqual({ kind: "retry" })
    expect(planRunOutcome({ ...base, outcome: o, hasOutput: false, isRetry: true }).kind).toBe("error")
    expect(planRunOutcome({ ...base, outcome: o, hasOutput: false, offline: true }).kind).toBe("error")
    expect(planRunOutcome({ ...base, outcome: o, hasOutput: true }).kind).toBe("error")
    expect(planRunOutcome({ ...base, turn: "rejoin", outcome: o, hasOutput: false }).kind).toBe("error")
  })

  test("errors carry the model", () => {
    expect(planRunOutcome({ ...base, outcome: error("upstream") })).toEqual({
      kind: "error",
      error: { code: "unknown", detail: "upstream", model: "m" },
    })
  })

  test("a rejoin of a forgotten run → forgotten", () => {
    expect(planRunOutcome({ ...base, turn: "rejoin", outcome: error("not_found") })).toEqual({ kind: "forgotten" })
    expect(planRunOutcome({ ...base, outcome: error("not_found") }).kind).toBe("error")
  })

  test("a resume that never started → rejected (no bubble); once started → the bubble", () => {
    expect(
      planRunOutcome({ ...base, turn: "resume", started: false, outcome: error("run_already_resumed") }),
    ).toMatchObject({ kind: "rejected", code: "run_already_resumed" })
    expect(planRunOutcome({ ...base, turn: "resume", started: true, outcome: error("upstream") }).kind).toBe("error")
  })

  test("a resume refused as already applied → answer-applied, its own bubble (Q63)", () => {
    const plan = planRunOutcome({
      ...base,
      turn: "resume",
      started: false,
      outcome: error("run_answer_applied"),
    })
    expect(plan).toEqual({ kind: "answer-applied", error: { code: "answer_applied", model: "m" } })
    expect(pointerActionFor(plan)).toBe("keep")
    // Only a resume that never started: a send's error stays an error.
    expect(planRunOutcome({ ...base, outcome: error("run_answer_applied") }).kind).toBe("error")
  })

  test("cancelled → drop the placeholder only for a send without output", () => {
    const c: RunOutcome = { type: "cancelled" }
    expect(planRunOutcome({ ...base, outcome: c, hasOutput: false })).toEqual({ kind: "cancelled", dropPlaceholder: true })
    expect(planRunOutcome({ ...base, outcome: c })).toEqual({ kind: "cancelled", dropPlaceholder: false })
    expect(planRunOutcome({ ...base, turn: "resume", outcome: c, hasOutput: false })).toEqual({
      kind: "cancelled",
      dropPlaceholder: false,
    })
  })

  test("interrupt → hand over the interrupts", () => {
    const o: RunOutcome = { type: "interrupt", interrupts: [{ id: "i", reason: "approval", raw: {} as never }] }
    expect(planRunOutcome({ ...base, outcome: o })).toEqual({ kind: "interrupt", interrupts: o.interrupts })
  })
})

describe("pointerActionFor", () => {
  test("keep while the run may go on, mark paused runs, clear the rest", () => {
    expect(pointerActionFor({ kind: "detached" })).toBe("keep")
    expect(pointerActionFor({ kind: "retry" })).toBe("keep")
    expect(pointerActionFor({ kind: "rejected", error: { code: "unknown" }, code: "x" })).toBe("keep")
    expect(pointerActionFor({ kind: "interrupt", interrupts: [] })).toBe("interrupted")
    expect(pointerActionFor({ kind: "finalize", tainted: false })).toBe("clear")
    expect(pointerActionFor({ kind: "forgotten" })).toBe("clear")
    expect(pointerActionFor({ kind: "cancelled", dropPlaceholder: true })).toBe("clear")
    expect(pointerActionFor({ kind: "error", error: { code: "unknown" } })).toBe("clear")
  })
})

describe("createThrottle", () => {
  test("leading write, then at most one per window with the latest value", () => {
    let now = 0
    const timers: Array<{ at: number; cb: () => void }> = []
    const clock = {
      now: () => now,
      setTimeout: (cb: () => void, ms: number) => {
        const t = { at: now + ms, cb }
        timers.push(t)
        return t
      },
      clearTimeout: (h: unknown) => {
        const i = timers.indexOf(h as (typeof timers)[number])
        if (i !== -1) timers.splice(i, 1)
      },
    }
    const writes: string[] = []
    const t = createThrottle<string>((v) => writes.push(v), 1000, clock)
    t.push("1")
    t.push("2")
    t.push("3")
    expect(writes).toEqual(["1"])
    now = 1000
    timers.shift()!.cb()
    expect(writes).toEqual(["1", "3"])
    t.push("4")
    t.cancel()
    expect(timers).toHaveLength(0)
    expect(writes).toEqual(["1", "3"])
  })
})
