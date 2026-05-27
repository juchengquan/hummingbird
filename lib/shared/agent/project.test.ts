import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "./events"
import { isTerminalStatus } from "./events"
import { EMPTY_RUN_VIEW, projectRun, reduceRun } from "./project"

// Terse event builders — every event needs runId/seq/step/createdAt.
let SEQ = 0
function ev<T extends Partial<TaskEvent> & { kind: TaskEvent["kind"] }>(
  e: T,
  seq = ++SEQ,
  step = 0
): TaskEvent {
  return {
    runId: "r1",
    seq,
    step,
    createdAt: new Date(seq * 1000).toISOString(),
    ...e,
  } as TaskEvent
}

describe("projectRun — happy linear run", () => {
  test("status → tokens → tool → result folds into a complete view", () => {
    SEQ = 0
    const log: TaskEvent[] = [
      ev({ kind: "status", status: "running", maxSteps: 5 }),
      ev({ kind: "step_start" }, 2, 1),
      ev({ kind: "token", text: "Hello " }, 3, 1),
      ev({ kind: "token", text: "world" }, 4, 1),
      ev({ kind: "tool_input", toolCallId: "t1", toolName: "webSearch", args: { query: "x" } }, 5, 1),
      ev(
        {
          kind: "tool_output",
          toolCallId: "t1",
          toolName: "webSearch",
          summary: "2 results",
          results: [
            { title: "A", url: "https://a", snippet: "sa" },
            { title: "B", url: "https://b", snippet: "sb" },
          ],
        },
        6,
        1
      ),
      ev({ kind: "step_end" }, 7, 1),
      ev({ kind: "result", status: "done", finalText: "Hello world" }, 8, 1),
    ]
    const view = projectRun(log)
    expect(view.status).toBe("done")
    expect(view.text).toBe("Hello world")
    expect(view.maxSteps).toBe(5)
    expect(view.step).toBe(1)
    expect(view.toolCalls).toHaveLength(1)
    expect(view.toolCalls[0]).toMatchObject({
      toolCallId: "t1",
      toolName: "webSearch",
      status: "done",
      summary: "2 results",
    })
    expect(view.toolCalls[0].results).toHaveLength(2)
    expect(view.resultText).toBe("Hello world")
    expect(view.fatalError).toBeNull()
    expect(view.cursor).toBe(8)
  })
})

describe("reduceRun — token channels", () => {
  test("separates text and reasoning", () => {
    SEQ = 0
    let v = EMPTY_RUN_VIEW
    v = reduceRun(v, ev({ kind: "token", text: "ans" }))
    v = reduceRun(v, ev({ kind: "token", text: "thinking", channel: "reasoning" }))
    v = reduceRun(v, ev({ kind: "token", text: "wer" }))
    expect(v.text).toBe("answer")
    expect(v.reasoning).toBe("thinking")
  })
})

describe("reduceRun — idempotent replay", () => {
  test("re-applying an already-folded seq is a no-op", () => {
    SEQ = 0
    const a = ev({ kind: "token", text: "x" }, 1, 0)
    const b = ev({ kind: "token", text: "y" }, 2, 0)
    let v = EMPTY_RUN_VIEW
    v = reduceRun(v, a)
    v = reduceRun(v, b)
    // Replay the overlapping window [a, b] — should not double-append.
    v = reduceRun(v, a)
    v = reduceRun(v, b)
    expect(v.text).toBe("xy")
    expect(v.cursor).toBe(2)
  })

  test("projectRun de-dups duplicate seqs and tolerates out-of-order", () => {
    SEQ = 0
    const log: TaskEvent[] = [
      ev({ kind: "token", text: "b" }, 2, 0),
      ev({ kind: "token", text: "a" }, 1, 0),
      ev({ kind: "token", text: "b-dupe" }, 2, 0), // duplicate seq 2
      ev({ kind: "token", text: "c" }, 3, 0),
    ]
    expect(projectRun(log).text).toBe("abc")
  })
})

describe("reduceRun — tool calls", () => {
  test("output without prior input synthesizes a done entry", () => {
    SEQ = 0
    let v = EMPTY_RUN_VIEW
    v = reduceRun(
      v,
      ev({ kind: "tool_output", toolCallId: "t9", toolName: "webFetch", summary: "ok" })
    )
    expect(v.toolCalls).toHaveLength(1)
    expect(v.toolCalls[0]).toMatchObject({ toolCallId: "t9", status: "done", summary: "ok" })
  })

  test("input then output resolves the same entry (no duplicate)", () => {
    SEQ = 0
    let v = EMPTY_RUN_VIEW
    v = reduceRun(v, ev({ kind: "tool_input", toolCallId: "t1", toolName: "x", args: {} }))
    expect(v.toolCalls[0].status).toBe("running")
    v = reduceRun(v, ev({ kind: "tool_output", toolCallId: "t1", toolName: "x", summary: "done" }))
    expect(v.toolCalls).toHaveLength(1)
    expect(v.toolCalls[0].status).toBe("done")
  })
})

describe("reduceRun — plan is full-list replace", () => {
  test("latest plan event wins", () => {
    SEQ = 0
    let v = EMPTY_RUN_VIEW
    v = reduceRun(
      v,
      ev({ kind: "plan", items: [{ id: "1", text: "a", status: "in_progress" }] })
    )
    v = reduceRun(
      v,
      ev({
        kind: "plan",
        items: [
          { id: "1", text: "a", status: "completed" },
          { id: "2", text: "b", status: "in_progress" },
        ],
      })
    )
    expect(v.plan).toHaveLength(2)
    expect(v.plan[0].status).toBe("completed")
  })
})

describe("reduceRun — errors", () => {
  test("step_error is non-fatal; run keeps its status", () => {
    SEQ = 0
    let v = reduceRun(EMPTY_RUN_VIEW, ev({ kind: "status", status: "running" }))
    v = reduceRun(v, ev({ kind: "step_error", message: "search timed out", willRetry: true }))
    expect(v.lastStepError).toBe("search timed out")
    expect(v.status).toBe("running")
    expect(v.fatalError).toBeNull()
  })

  test("result: failed sets fatalError + terminal status", () => {
    SEQ = 0
    let v = reduceRun(EMPTY_RUN_VIEW, ev({ kind: "status", status: "running" }))
    v = reduceRun(v, ev({ kind: "result", status: "failed", error: "gateway 500" }))
    expect(v.status).toBe("failed")
    expect(v.fatalError).toBe("gateway 500")
    expect(isTerminalStatus(v.status)).toBe(true)
  })
})

describe("reduceRun — artifact refs dedupe", () => {
  test("same artifact referenced twice appears once", () => {
    SEQ = 0
    let v = EMPTY_RUN_VIEW
    v = reduceRun(v, ev({ kind: "artifact_ref", artifactId: "a1" }))
    v = reduceRun(v, ev({ kind: "artifact_ref", artifactId: "a1" }))
    v = reduceRun(v, ev({ kind: "artifact_ref", artifactId: "a2" }))
    expect(v.artifactIds).toEqual(["a1", "a2"])
  })
})

describe("reduceRun — graceful degradation", () => {
  test("unknown future event kind advances the cursor without throwing", () => {
    SEQ = 0
    let v = reduceRun(EMPTY_RUN_VIEW, ev({ kind: "token", text: "hi" }, 1, 0))
    // Simulate an adapter emitting a richer kind this consumer predates.
    const future = {
      runId: "r1",
      seq: 2,
      step: 0,
      createdAt: new Date().toISOString(),
      kind: "memory_write",
      payload: { key: "x" },
    } as unknown as TaskEvent
    v = reduceRun(v, future)
    expect(v.cursor).toBe(2)
    expect(v.text).toBe("hi")
  })
})

describe("isTerminalStatus", () => {
  test("done / failed / cancelled are terminal; queued / running / paused are not", () => {
    expect(isTerminalStatus("done")).toBe(true)
    expect(isTerminalStatus("failed")).toBe(true)
    expect(isTerminalStatus("cancelled")).toBe(true)
    expect(isTerminalStatus("queued")).toBe(false)
    expect(isTerminalStatus("running")).toBe(false)
    expect(isTerminalStatus("paused")).toBe(false)
  })
})
