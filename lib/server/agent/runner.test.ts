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

  test("a pendingInput step returns suspended without settling the emitter", async () => {
    const { emitter, events } = harness()
    let calls = 0
    const runStep: RunStepFn = async () => {
      calls += 1
      if (calls === 1) return { done: false } // one tool round
      return {
        done: false,
        pendingInput: {
          toolCallId: "tc1",
          tool: "mcp__srv__write",
          args: { foo: "bar" },
        },
      }
    }
    const result = await runAgentLoop({
      emitter,
      maxSteps: 10,
      signal: new AbortController().signal,
      isCancelled: () => false,
      runStep,
    })
    expect(result).toEqual({
      kind: "suspended",
      pendingInput: {
        toolCallId: "tc1",
        tool: "mcp__srv__write",
        args: { foo: "bar" },
      },
    })
    // No terminal event yet — the emitter is NOT settled.
    expect(emitter.settled).toBe(false)
    const last = events.at(-1)
    expect(last?.kind).not.toBe("result")
    // The view reflects two steps without a status flip.
    expect(projectRun(events).step).toBe(2)
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

  test("shouldYield between steps returns yielded without settling", async () => {
    const { emitter, events } = harness()
    let calls = 0
    const runStep: RunStepFn = async () => {
      calls += 1
      return { done: false }
    }
    // Yield after the second step's pre-check (steps 1 and 2 run, then
    // step 3's gate trips). 1st pre-check (step=1): emitter.step=0 → false;
    // 2nd (step=2): emitter.step=1 → false; 3rd (step=3): emitter.step=2
    // → true.
    const result = await runAgentLoop({
      emitter,
      maxSteps: 10,
      signal: new AbortController().signal,
      isCancelled: () => false,
      shouldYield: () => emitter.step >= 2,
      runStep,
    })
    expect(result).toEqual({ kind: "yielded" })
    expect(calls).toBe(2)
    expect(emitter.settled).toBe(false)
    // No terminal event — the route is responsible for enqueueing
    // `continue` and saving the checkpoint.
    expect(events.findIndex((e) => e.kind === "result")).toBe(-1)
    // Status stays at `running` (no `cancelled` / `paused` either).
    expect(projectRun(events).status).toBe("running")
  })

  test("a continuation loop (startStep seed) yields against the seeded counter", async () => {
    const events: TaskEvent[] = []
    let tick = 0
    const emitter = new RunEmitter(
      {
        runId: "r1",
        maxSteps: 25,
        now: () => new Date(++tick).toISOString(),
        // Simulate resuming after 8 steps already ran (HITL or prior yield).
        startSeq: 50,
        startStep: 8,
      },
      (e) => events.push(e)
    )
    emitter.status("running") // continuation emits this itself
    const runStep: RunStepFn = async () => ({ done: false })
    const result = await runAgentLoop({
      emitter,
      maxSteps: 25,
      signal: new AbortController().signal,
      isCancelled: () => false,
      // Yield once we've done one more step on top of the seeded 8.
      shouldYield: () => emitter.step >= 9,
      runStep,
    })
    expect(result).toEqual({ kind: "yielded" })
    expect(emitter.step).toBe(9)
  })
})
