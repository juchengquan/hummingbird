import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "@/shared/agent/events"
import { RunEmitter } from "@/shared/agent/emitter"
import { projectRun } from "@/shared/agent/project"
import { runAgentLoop, type RunStepFn } from "./runner"

function harness(opts?: { maxSteps?: number }) {
  const events: TaskEvent[] = []
  let tick = 0
  const emitter = new RunEmitter(
    { runId: "r1", maxSteps: opts?.maxSteps ?? 5, now: () => new Date(++tick).toISOString() },
    (e) => events.push(e)
  )
  return { emitter, events }
}

describe("runAgentLoop — control flow", () => {
  test("a one-step run that answers immediately settles done", async () => {
    const { emitter, events } = harness()
    const runStep: RunStepFn = async ({ emitter }) => {
      emitter.token("answer")
      return { done: true }
    }
    await runAgentLoop({
      emitter,
      maxSteps: 5,
      signal: new AbortController().signal,
      isCancelled: () => false,
      runStep,
    })
    const view = projectRun(events)
    expect(view.status).toBe("done")
    expect(view.step).toBe(1)
    expect(view.text).toBe("answer")
    // first event is status:running, last is result:done
    expect(events[0]).toMatchObject({ kind: "status", status: "running" })
    expect(events.at(-1)).toMatchObject({ kind: "result", status: "done" })
  })

  test("loops while steps report not-done, then settles", async () => {
    const { emitter, events } = harness()
    let calls = 0
    const runStep: RunStepFn = async ({ emitter }) => {
      calls += 1
      emitter.toolInput(`t${calls}`, "webSearch", {})
      emitter.toolOutput(`t${calls}`, "webSearch", "ok")
      return { done: calls >= 3 } // tool, tool, then answer
    }
    await runAgentLoop({
      emitter,
      maxSteps: 10,
      signal: new AbortController().signal,
      isCancelled: () => false,
      runStep,
    })
    expect(calls).toBe(3)
    const view = projectRun(events)
    expect(view.status).toBe("done")
    expect(view.step).toBe(3)
    expect(view.toolCalls).toHaveLength(3)
  })

  test("stops at the step cap even if the model never finishes", async () => {
    const { emitter, events } = harness()
    let calls = 0
    const runStep: RunStepFn = async () => {
      calls += 1
      return { done: false } // never finishes
    }
    await runAgentLoop({
      emitter,
      maxSteps: 4,
      signal: new AbortController().signal,
      isCancelled: () => false,
      runStep,
    })
    expect(calls).toBe(4)
    const view = projectRun(events)
    expect(view.step).toBe(4)
    expect(view.status).toBe("done") // settled at the cap
  })

  test("out-of-band cancel between steps stops the loop", async () => {
    const { emitter, events } = harness()
    let calls = 0
    let cancelled = false
    const runStep: RunStepFn = async () => {
      calls += 1
      if (calls === 2) cancelled = true // cancel after the 2nd step
      return { done: false }
    }
    await runAgentLoop({
      emitter,
      maxSteps: 10,
      signal: new AbortController().signal,
      isCancelled: () => cancelled,
      runStep,
    })
    expect(calls).toBe(2) // step 3's pre-check sees the cancel
    expect(projectRun(events).status).toBe("cancelled")
    expect(events.at(-1)).toMatchObject({ kind: "status", status: "cancelled" })
  })

  test("an aborted signal settles cancelled, not failed", async () => {
    const { emitter, events } = harness()
    const ac = new AbortController()
    const runStep: RunStepFn = async () => {
      ac.abort()
      throw new Error("aborted upstream")
    }
    await runAgentLoop({
      emitter,
      maxSteps: 5,
      signal: ac.signal,
      isCancelled: () => false,
      runStep,
    })
    expect(projectRun(events).status).toBe("cancelled")
  })

  test("a thrown step (not aborted) settles failed with the message", async () => {
    const { emitter, events } = harness()
    const runStep: RunStepFn = async () => {
      throw new Error("gateway 500")
    }
    await runAgentLoop({
      emitter,
      maxSteps: 5,
      signal: new AbortController().signal,
      isCancelled: () => false,
      runStep,
    })
    const view = projectRun(events)
    expect(view.status).toBe("failed")
    expect(view.fatalError).toBe("gateway 500")
  })

  test("no events are emitted after the terminal one", async () => {
    const { emitter, events } = harness()
    const runStep: RunStepFn = async ({ emitter }) => {
      emitter.token("hi")
      return { done: true }
    }
    await runAgentLoop({
      emitter,
      maxSteps: 5,
      signal: new AbortController().signal,
      isCancelled: () => false,
      runStep,
    })
    const terminalIdx = events.findIndex((e) => e.kind === "result")
    expect(terminalIdx).toBe(events.length - 1) // result is last
  })
})
