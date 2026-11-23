import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "./events"
import {
  dropSupersededEvents,
  isTerminalStatus,
  LEGACY_RESTART_RESUMED_FROM_SEQ,
  resumeDiscardRange,
} from "./events"
import { EMPTY_RUN_VIEW, isNextEvent, projectRun, reduceRun } from "./project"

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
    expect(view.verification).toBeNull()
  })

  test("result verification folds onto the view (research citation pass)", () => {
    SEQ = 0
    const verification = {
      checks: [
        { claim: "A [1].", status: "supported" as const, sourceIds: ["1"] },
        { claim: "B [2].", status: "unsupported" as const, sourceIds: [] },
      ],
      summary: { supported: 1, partial: 0, unsupported: 1, total: 2 },
    }
    const view = projectRun([
      ev({ kind: "status", status: "running" }),
      ev({ kind: "token", text: "A [1]. B [2]." }, 2, 1),
      ev({ kind: "result", status: "done", verification }, 3, 1),
    ])
    expect(view.verification).toEqual(verification)
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

function handoff(seq: number, childTaskId: string | undefined, agent: string, subgoal: string) {
  return {
    kind: "handoff" as const, runId: "r", seq, step: 1,
    createdAt: "2026-06-20T00:00:00Z", agent, phase: "enter" as const,
    childTaskId, subgoal,
  }
}

describe("reduceRun — handoff → childRuns", () => {
  test("folds a spawn handoff into childRuns", () => {
    const v = reduceRun(EMPTY_RUN_VIEW, handoff(1, "c1", "researcher", "find sources"))
    expect(v.childRuns).toEqual([
      { childTaskId: "c1", agent: "researcher", subgoal: "find sources" },
    ])
  })
  test("dedups by childTaskId", () => {
    let v = reduceRun(EMPTY_RUN_VIEW, handoff(1, "c1", "r", "g"))
    v = reduceRun(v, handoff(2, "c1", "r", "g"))
    expect(v.childRuns).toHaveLength(1)
  })
  test("a handoff without childTaskId is a no-op for childRuns", () => {
    const v = reduceRun(EMPTY_RUN_VIEW, handoff(1, undefined, "r", "g"))
    expect(v.childRuns).toEqual([])
  })
})

describe("reduceRun — restart marker (reclaimed run started over)", () => {
  test("drops the dead attempt's partial output, keeps cursor + step ceiling", () => {
    const log: TaskEvent[] = [
      ev({ kind: "status", status: "queued", maxSteps: 7 }, 1, 0),
      ev({ kind: "status", status: "running" }, 2, 0),
      ev({ kind: "step_start" }, 3, 1),
      ev({ kind: "token", text: "half an ans" }, 4, 1),
      ev({ kind: "tool_input", toolCallId: "t1", toolName: "webSearch", args: {} }, 5, 1),
      ev({ kind: "status", status: "running", restarted: true }, 6, 0),
      ev({ kind: "step_start" }, 7, 1),
      ev({ kind: "token", text: "the answer" }, 8, 1),
    ]
    const view = projectRun(log)
    expect(view.text).toBe("the answer")
    expect(view.toolCalls).toEqual([])
    expect(view.status).toBe("running")
    expect(view.maxSteps).toBe(7)
    expect(view.cursor).toBe(8)
    expect(view.step).toBe(1)
  })

  test("an ordinary status transition keeps the accumulated view", () => {
    let v = reduceRun(EMPTY_RUN_VIEW, ev({ kind: "token", text: "kept" }, 1, 1))
    v = reduceRun(v, ev({ kind: "status", status: "running" }, 2, 1))
    expect(v.text).toBe("kept")
  })

  test("a legacy marker on a view with no fold history still resets", () => {
    // Built by hand, not by `reduceRun` — nothing to rebuild from.
    const handMade = { ...EMPTY_RUN_VIEW, text: "stale", cursor: 4, maxSteps: 3 }
    const v = reduceRun(handMade, ev({ kind: "status", status: "running", restarted: true }, 5, 0))
    expect(v.text).toBe("")
    expect(v.maxSteps).toBe(3)
    expect(v.cursor).toBe(5)
  })
})

describe("reduceRun — resume marker (reclaimed continue / respond)", () => {
  // First chunk up to the checkpoint (seq 5), a dead chunk past it
  // (6..9), then the reclaimed re-run behind its marker (10..).
  const log: TaskEvent[] = [
    ev({ kind: "status", status: "queued", maxSteps: 9 }, 1, 0),
    ev({ kind: "status", status: "running" }, 2, 0),
    ev({ kind: "step_start" }, 3, 1),
    ev({ kind: "token", text: "Part one. " }, 4, 1),
    ev({ kind: "plan", items: [{ id: "a", text: "first", status: "completed" }] }, 5, 1),
    ev({ kind: "step_start" }, 6, 2),
    ev({ kind: "token", text: "Part tw" }, 7, 2),
    ev({ kind: "tool_input", toolCallId: "dead", toolName: "webSearch", args: {} }, 8, 2),
    ev({ kind: "plan", items: [{ id: "b", text: "dead", status: "pending" }] }, 9, 2),
    ev({ kind: "status", status: "running", resumedFromSeq: 5 }, 10, 1),
    ev({ kind: "step_start" }, 11, 2),
    ev({ kind: "token", text: "Part two." }, 12, 2),
  ]

  test("drops exactly the events between the checkpoint and the marker", () => {
    const view = projectRun(log)
    expect(view.text).toBe("Part one. Part two.")
    expect(view.toolCalls).toEqual([])
    expect(view.plan).toEqual([{ id: "a", text: "first", status: "completed" }])
    expect(view.maxSteps).toBe(9)
    expect(view.status).toBe("running")
    expect(view.cursor).toBe(12)
    expect(view.step).toBe(2)
  })

  test("incremental tailing matches the cold projection", () => {
    let warm = EMPTY_RUN_VIEW
    for (const e of log) warm = reduceRun(warm, e)
    expect(warm).toEqual(projectRun(log))
    // Same as projecting the log with the discard range removed.
    expect(warm.text).toBe(projectRun(dropSupersededEvents(log)).text)
  })

  test("a later marker resuming from before an earlier one", () => {
    const later: TaskEvent[] = [
      ...log,
      ev({ kind: "token", text: " Dead again." }, 13, 2),
      ev({ kind: "status", status: "running", resumedFromSeq: 12 }, 14, 2),
      ev({ kind: "token", text: " Three." }, 15, 3),
    ]
    let warm = EMPTY_RUN_VIEW
    for (const e of later) warm = reduceRun(warm, e)
    expect(warm.text).toBe("Part one. Part two. Three.")
    expect(projectRun(later).text).toBe("Part one. Part two. Three.")
  })

  test("a marker resuming a respond clears the input the checkpoint paused on", () => {
    const paused: TaskEvent[] = [
      ev({ kind: "status", status: "running" }, 1, 0),
      ev(
        {
          kind: "approval",
          phase: "request",
          approvalId: "tu_1",
          tool: "danger",
          toolCallId: "tu_1",
        } as Partial<TaskEvent> & { kind: "approval" },
        2,
        1
      ),
      ev({ kind: "status", status: "paused" }, 3, 1),
      ev(
        { kind: "approval", phase: "response", approvalId: "tu_1", approved: true } as Partial<TaskEvent> & {
          kind: "approval"
        },
        4,
        1
      ),
      ev({ kind: "status", status: "running" }, 5, 1),
      ev({ kind: "token", text: "dead" }, 6, 2),
      ev({ kind: "status", status: "running", resumedFromSeq: 3 }, 7, 1),
    ]
    const view = projectRun(paused)
    expect(view.pendingInput).toBeNull()
    expect(view.status).toBe("running")
    expect(view.text).toBe("")
  })
})

describe("dropSupersededEvents / resumeDiscardRange", () => {
  test("ranges come from resumedFromSeq, else the legacy restarted flag", () => {
    expect(
      resumeDiscardRange(ev({ kind: "status", status: "running", resumedFromSeq: 4 }, 9, 1))
    ).toEqual({ after: 4, before: 9 })
    expect(
      resumeDiscardRange(ev({ kind: "status", status: "running", restarted: true }, 6, 0))
    ).toEqual({ after: LEGACY_RESTART_RESUMED_FROM_SEQ, before: 6 })
    // resumedFromSeq wins over the flag a restart also carries.
    expect(
      resumeDiscardRange(
        ev({ kind: "status", status: "running", resumedFromSeq: 0, restarted: true }, 6, 0)
      )
    ).toEqual({ after: 0, before: 6 })
    expect(resumeDiscardRange(ev({ kind: "status", status: "running" }, 6, 0))).toBeNull()
    expect(resumeDiscardRange(ev({ kind: "token", text: "x" }, 6, 0))).toBeNull()
  })

  test("drops the range, keeps the marker and everything outside it", () => {
    const log: TaskEvent[] = [
      ev({ kind: "status", status: "queued" }, 1, 0),
      ev({ kind: "token", text: "a" }, 2, 1),
      ev({ kind: "result", status: "done", finalText: "dead" }, 3, 1),
      ev({ kind: "status", status: "running", resumedFromSeq: 2 }, 4, 1),
      ev({ kind: "token", text: "b" }, 5, 1),
    ]
    expect(dropSupersededEvents(log).map((e) => e.seq)).toEqual([1, 2, 4, 5])
  })
})

describe("isNextEvent — Realtime beside a replay from 0", () => {
  test("a pushed event ahead of the replay waits; the next one is folded", () => {
    const events = [1, 2, 3].map((seq) => ev({ kind: "token", text: `${seq}` }, seq))
    let view = EMPTY_RUN_VIEW
    expect(isNextEvent(view, events[2])).toBe(false)
    expect(isNextEvent(view, events[0])).toBe(true)
    for (const event of events) view = reduceRun(view, event)
    expect(view.text).toBe("123")
    expect(isNextEvent(view, events[2])).toBe(false)
  })
})
