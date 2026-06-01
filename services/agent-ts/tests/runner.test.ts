/**
 * Phase 2 tests — agent loop orchestration. Mirrors agent-py's
 * `test_runner.py`.
 */

import { describe, test, expect } from "bun:test"

import { RunEmitter } from "../src/emitter"
import type { TaskEvent } from "../src/events"
import { runAgentLoop } from "../src/runner"
import type { RunStepFn } from "../src/runner"

function makeEmitter(): { emitter: RunEmitter; events: TaskEvent[] } {
  const events: TaskEvent[] = []
  const emitter = new RunEmitter({
    runId: "r1",
    sink: async (e) => {
      events.push(e)
    },
  })
  return { emitter, events }
}

const neverCancelled = async () => false

describe("runAgentLoop", () => {
  test("settled when step fn returns done=true", async () => {
    const { emitter, events } = makeEmitter()
    const stepFn: RunStepFn = async (ctx) => {
      await ctx.emitter.token("hi")
      return { done: true }
    }
    const result = await runAgentLoop({
      emitter,
      maxSteps: 10,
      runStep: stepFn,
      isCancelled: neverCancelled,
    })
    expect(result.kind).toBe("settled")
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual(["status", "step_start", "token", "step_end", "result"])
  })

  test("cancelled before first step emits failed:cancelled", async () => {
    const { emitter, events } = makeEmitter()
    const result = await runAgentLoop({
      emitter,
      maxSteps: 10,
      runStep: async () => ({ done: true }),
      isCancelled: async () => true,
    })
    expect(result.kind).toBe("cancelled")
    const resultEvent = events.find((e) => e.kind === "result")
    expect(resultEvent).toMatchObject({ status: "failed", error: "cancelled" })
  })

  test("yielded returns without emitting result", async () => {
    const { emitter, events } = makeEmitter()
    let calls = 0
    const result = await runAgentLoop({
      emitter,
      maxSteps: 10,
      runStep: async () => {
        calls += 1
        return { done: false }
      },
      isCancelled: neverCancelled,
      // Yield after the first step.
      shouldYield: () => calls >= 1,
    })
    expect(result.kind).toBe("yielded")
    expect(events.find((e) => e.kind === "result")).toBeUndefined()
  })

  test("step fn throwing settles as failed with the error message", async () => {
    const { emitter, events } = makeEmitter()
    const result = await runAgentLoop({
      emitter,
      maxSteps: 10,
      runStep: async () => {
        throw new Error("oops")
      },
      isCancelled: neverCancelled,
    })
    expect(result.kind).toBe("settled")
    const resultEvent = events.find((e) => e.kind === "result")
    expect(resultEvent).toMatchObject({ status: "failed", error: "oops" })
  })

  test("max_steps hit settles failed without infinite loop", async () => {
    const { emitter, events } = makeEmitter()
    const result = await runAgentLoop({
      emitter,
      maxSteps: 3,
      runStep: async () => ({ done: false }),
      isCancelled: neverCancelled,
    })
    expect(result.kind).toBe("settled")
    const stepStarts = events.filter((e) => e.kind === "step_start").length
    expect(stepStarts).toBe(3)
    const resultEvent = events.find((e) => e.kind === "result") as {
      status: string
      error: string
    } | undefined
    expect(resultEvent?.error).toMatch(/max_steps/)
  })
})
