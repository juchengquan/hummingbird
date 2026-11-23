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

describe("GET /api/tasks/:id/stream — a row that ended without saying so (B32)", () => {
  const queued = ev(1, { kind: "status", status: "queued" })
  const ends = (events: TaskEvent[]) =>
    events.map((e) => (e.kind === "status" || e.kind === "result" ? `${e.kind}:${e.status}` : e.kind))

  for (const [status, terminal] of [
    ["cancelled", "status:cancelled"],
    ["failed", "result:failed"],
    ["done", "result:done"],
  ] as const) {
    test(`a ${status} row with no terminal event ends the stream as ${status}`, async () => {
      mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status }))
      serveLog([queued])
      const { GET } = await import("./route")
      const events = await readStream(await GET(get(), { params }))
      expect(ends(events)).toEqual(["status:queued", terminal])
      expect(events[1].seq).toBe(2)
    })
  }

  test("cancelled while watched", async () => {
    let reads = 0
    mocks.getRun.mockImplementation(async () => ({
      id: RUN_ID,
      status: ++reads > 2 ? "cancelled" : "running",
    }))
    serveLog([queued, ev(2, { kind: "token", text: "partial" })])
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    expect(ends(events)).toEqual(["status:queued", "token", "status:cancelled"])
  })

  test("reconnecting at the end of an ended log still says how it ended", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "cancelled" }))
    serveLog([queued])
    const { GET } = await import("./route")
    const req = new NextRequest(get().url, { headers: { "last-event-id": "1" } })
    const events = await readStream(await GET(req, { params }))
    expect(ends(events)).toEqual(["status:cancelled"])
  })

  test("the row wins over a result a cancel beat", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "cancelled" }))
    serveLog([queued, ev(2, { kind: "result", status: "done", finalText: "late" })])
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    expect(ends(events)).toEqual(["status:queued", "status:cancelled"])
  })

  test("a pause written after the cancel doesn't leave the run paused", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "cancelled" }))
    serveLog([queued, ev(2, { kind: "status", status: "paused" })])
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    expect(ends(events).at(-1)).toBe("status:cancelled")
  })

  test("a row deleted while watched ends the stream, claiming no outcome", async () => {
    let reads = 0
    mocks.getRun.mockImplementation(async () => (++reads > 1 ? null : { id: RUN_ID, status: "running" }))
    serveLog([queued])
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    // The client's reconnect gets the 404 that says it's gone.
    expect(ends(events)).toEqual(["status:queued"])
  })
})

describe("GET /api/tasks/:id/stream — replay from 0 (B14)", () => {
  test("a finished log longer than PostgREST's max_rows is replayed whole", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "done" }))
    const log: TaskEvent[] = Array.from({ length: 2500 }, (_, i) =>
      ev(i + 1, { kind: "token", text: "x" })
    )
    log.push(ev(2501, { kind: "result", status: "done" }))
    mocks.listEventsSince.mockImplementation(async (_db, _id, _user, since) =>
      log.filter((e) => e.seq > since).slice(0, 1000)
    )
    const { GET } = await import("./route")
    const events = await readStream(await GET(get(), { params }))
    expect(events).toHaveLength(2501)
    expect(events.at(-1)?.kind).toBe("result")
  })
})

describe("GET /api/tasks/:id/stream — watching a paused task (Q66)", () => {
  test("polls the status alone, every 5 s while paused", async () => {
    mocks.getRun.mockImplementation(async () => ({ id: RUN_ID, status: "paused", step: 1 }))
    mocks.getRunStatus.mockImplementation(async () => "paused")
    serveLog([ev(1, { kind: "status", status: "queued" }), ev(2, { kind: "status", status: "paused" })])
    const { GET } = await import("./route")
    const controller = new AbortController()
    const req = new NextRequest(get().url, { signal: controller.signal })
    const res = await GET(req, { params })
    const reading = readStream(res)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    controller.abort()
    await reading.catch(() => {})
    // One whole-row read to start; after that the status only, and not
    // once a second.
    expect(mocks.getRun.mock.calls.length).toBe(1)
    expect(mocks.getRunStatus.mock.calls.length).toBeLessThanOrEqual(1)
  })
})

