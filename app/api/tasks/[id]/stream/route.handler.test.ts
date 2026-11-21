/**
 * Route-handler tests for `GET /api/tasks/:id/stream` — the resume /
 * live-tail endpoint. Focus: a terminal event in the log only ends the
 * stream once the task row is terminal too, so a dead worker's `result`
 * (written before it could settle; superseded by its reclaimed re-run's
 * resume marker) never reaches the client as the run's end.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { mocks, resetAgentMocks } from "../../_test/mock-agent-store"

import type { TaskEvent } from "@/shared/agent/events"
import { decodeTaskEventStream } from "@/shared/agent/stream"

const RUN_ID = "22222222-2222-2222-2222-222222222222"
const params = Promise.resolve({ id: RUN_ID })

function ev(seq: number, e: Partial<TaskEvent> & { kind: TaskEvent["kind"] }): TaskEvent {
  return {
    runId: RUN_ID,
    seq,
    step: 0,
    createdAt: new Date(seq * 1000).toISOString(),
    ...e,
  } as TaskEvent
}

/** A mutable log the `listEventsSince` mock reads from. */
function serveLog(log: TaskEvent[]) {
  mocks.listEventsSince.mockImplementation(async (_db, _id, _user, since) =>
    log.filter((e) => e.seq > since)
  )
}

async function readStream(res: Response): Promise<TaskEvent[]> {
  const out: TaskEvent[] = []
  for await (const e of decodeTaskEventStream(res.body!)) out.push(e)
  return out
}

function get(): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${RUN_ID}/stream`)
}

beforeEach(resetAgentMocks)

describe("GET /api/tasks/:id/stream — terminal confirmation", () => {
  test("result with a terminal row ends the stream at once", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "done" }))
    serveLog([
      ev(1, { kind: "status", status: "queued" }),
      ev(2, { kind: "token", text: "hi" }),
      ev(3, { kind: "result", status: "done" }),
    ])
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  test("a dead attempt's result is held while the row is live, then dropped once superseded", async () => {
    const log: TaskEvent[] = [
      ev(1, { kind: "status", status: "queued" }),
      ev(2, { kind: "token", text: "dead answer" }),
      // Worker died right after this — the task row is still `running`.
      ev(3, { kind: "result", status: "done", finalText: "dead answer" }),
    ]
    serveLog(log)
    let getRunCalls = 0
    mocks.getRun.mockImplementation(async () => {
      getRunCalls += 1
      // 1: the route's existence check; 2: confirming seq 3 (still
      // running); 3: the loop's backstop check. Meanwhile the job is
      // reclaimed and the re-run writes its marker + real answer.
      if (getRunCalls === 2) {
        log.push(
          ev(4, { kind: "status", status: "running", resumedFromSeq: 1 }),
          ev(5, { kind: "token", text: "real answer" }),
          ev(6, { kind: "result", status: "done", finalText: "real answer" })
        )
      }
      return { id: RUN_ID, status: getRunCalls <= 3 ? "running" : "done" }
    })

    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    // The dead `result` (seq 3) is never sent; the stream ends at the
    // re-run's confirmed result.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 4, 5, 6])
    const results = events.filter((e) => e.kind === "result")
    expect(results).toHaveLength(1)
    expect(results[0].seq).toBe(6)
  })

  test("a held result is delivered once the row turns terminal", async () => {
    serveLog([
      ev(1, { kind: "token", text: "answer" }),
      ev(2, { kind: "result", status: "done" }),
    ])
    let getRunCalls = 0
    mocks.getRun.mockImplementation(async () => {
      getRunCalls += 1
      // Producer wrote `result` a moment before settling the row.
      return { id: RUN_ID, status: getRunCalls <= 2 ? "running" : "done" }
    })
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    expect(events.map((e) => e.seq)).toEqual([1, 2])
    // Re-read from before the held result: no duplicate seq 1.
    const sinces = mocks.listEventsSince.mock.calls.map((c) => c[3])
    expect(sinces).toEqual([0, 1])
  })
})
