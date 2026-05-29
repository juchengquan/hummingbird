import { describe, expect, test } from "bun:test"

import type { TaskEvent } from "@/shared/agent/events"
import { RunEmitter } from "@/shared/agent/emitter"
import { projectRun } from "@/shared/agent/project"
import {
  rowToTaskEvent,
  rowsToTaskEvents,
  taskEventToRow,
} from "./persistence"
import type { TaskEventRow } from "./persistence"

function event(over: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent {
  return {
    runId: "11111111-1111-1111-1111-111111111111",
    seq: 1,
    step: 0,
    createdAt: new Date(0).toISOString(),
    ...over,
  } as TaskEvent
}

/** Simulate a DB round-trip: row goes in as Insert, comes back as Row
 *  (id assigned by the DB). */
function asRow(insert: ReturnType<typeof taskEventToRow>, id = 1): TaskEventRow {
  return { id, ...insert, created_at: insert.created_at ?? new Date(0).toISOString() }
}

describe("taskEventToRow — column hoisting", () => {
  test("base fields → columns, kind-specific fields → payload", () => {
    const e = event({
      kind: "tool_output",
      seq: 7,
      step: 2,
      toolCallId: "t1",
      toolName: "webSearch",
      summary: "3 results",
    })
    const row = taskEventToRow(e, "user-1")
    expect(row).toMatchObject({
      task_id: e.runId,
      user_id: "user-1",
      seq: 7,
      step: 2,
      kind: "tool_output",
      created_at: e.createdAt,
    })
    // payload carries only the kind-specific fields — no base leakage.
    expect(row.payload).toEqual({
      toolCallId: "t1",
      toolName: "webSearch",
      summary: "3 results",
    })
    const p = row.payload as Record<string, unknown>
    expect(p.runId).toBeUndefined()
    expect(p.seq).toBeUndefined()
    expect(p.kind).toBeUndefined()
  })
})

describe("round-trip — every kind survives event → row → event", () => {
  const samples: TaskEvent[] = [
    event({ kind: "token", text: "hi", channel: "reasoning" }),
    event({ kind: "tool_input", toolCallId: "t1", toolName: "x", args: { q: 1 } }),
    event({
      kind: "tool_output",
      toolCallId: "t1",
      toolName: "x",
      summary: "ok",
      results: [{ title: "A", url: "https://a", snippet: "s" }],
    }),
    event({ kind: "step_start" }),
    event({ kind: "step_end" }),
    event({ kind: "status", status: "running", maxSteps: 9 }),
    event({ kind: "plan", items: [{ id: "1", text: "do", status: "in_progress" }] }),
    event({ kind: "step_error", message: "flaky", willRetry: false }),
    event({ kind: "handoff", agent: "sub", phase: "enter" }),
    event({ kind: "approval", approvalId: "a1", phase: "request", tool: "rm" }),
    event({ kind: "compact", summary: "folded" }),
    event({ kind: "artifact_ref", artifactId: "art1" }),
    event({ kind: "result", status: "done", finalText: "fin" }),
  ]

  for (const s of samples) {
    test(`${s.kind}`, () => {
      const back = rowToTaskEvent(asRow(taskEventToRow(s, "u1")))
      expect(back).toEqual(s)
    })
  }
})

describe("rowToTaskEvent — graceful rejection", () => {
  test("future/unknown kind → null", () => {
    const row = asRow({
      task_id: "t",
      user_id: "u",
      seq: 1,
      step: 0,
      kind: "memory_write",
      payload: { key: "x" },
      created_at: new Date(0).toISOString(),
    })
    expect(rowToTaskEvent(row)).toBeNull()
  })

  test("malformed payload for a known kind → null", () => {
    const row = asRow({
      task_id: "t",
      user_id: "u",
      seq: 1,
      step: 0,
      kind: "status", // missing required `status` field in payload
      payload: {},
      created_at: new Date(0).toISOString(),
    })
    expect(rowToTaskEvent(row)).toBeNull()
  })

  test("array / non-object payload is tolerated (treated as empty)", () => {
    // A `step_start` carries no payload fields, so an empty/garbage
    // payload still validates.
    const row = asRow({
      task_id: "t",
      user_id: "u",
      seq: 1,
      step: 0,
      kind: "step_start",
      payload: [] as unknown as Record<string, never>,
      created_at: new Date(0).toISOString(),
    })
    expect(rowToTaskEvent(row)?.kind).toBe("step_start")
  })
})

describe("rowsToTaskEvents — batch sort + drop", () => {
  test("sorts by seq and drops invalid rows", () => {
    const good2 = asRow(taskEventToRow(event({ kind: "token", text: "b", seq: 2 }), "u"), 2)
    const good1 = asRow(taskEventToRow(event({ kind: "token", text: "a", seq: 1 }), "u"), 1)
    const bad = asRow({
      task_id: "t",
      user_id: "u",
      seq: 3,
      step: 0,
      kind: "bogus",
      payload: {},
      created_at: new Date(0).toISOString(),
    })
    const events = rowsToTaskEvents([good2, bad, good1])
    expect(events.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe("persistence ↔ pipeline — emit → row → JSON → row → project", () => {
  test("a run survives the DB round-trip into a coherent view", () => {
    const rows: TaskEventRow[] = []
    let id = 0
    let tick = 0
    const em = new RunEmitter(
      { runId: "22222222-2222-2222-2222-222222222222", maxSteps: 4, now: () => new Date(++tick).toISOString() },
      // Sink writes to the "DB" as the runner would.
      (e) => rows.push(asRow(taskEventToRow(e, "u1"), ++id))
    )
    em.status("running")
    em.startStep()
    em.token("Working", "reasoning")
    em.toolInput("t1", "webFetch", { url: "https://x" })
    em.toolOutput("t1", "webFetch", "fetched")
    em.token("Done.")
    em.result("done")

    // Simulate persistence + the resume read (JSON-serialized jsonb).
    const persisted: TaskEventRow[] = JSON.parse(JSON.stringify(rows))
    const view = projectRun(rowsToTaskEvents(persisted))

    expect(view.status).toBe("done")
    expect(view.reasoning).toBe("Working")
    expect(view.text).toBe("Done.")
    expect(view.maxSteps).toBe(4)
    expect(view.toolCalls[0]).toMatchObject({ toolName: "webFetch", status: "done" })
  })
})
