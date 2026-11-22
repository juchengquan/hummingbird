import { describe, expect, test } from "bun:test"

import {
  DEFAULT_NO_WORKER_TIMEOUT_MS,
  NO_WORKER_ERROR,
  appendSyntheticResult,
  getQuestionKind,
  noWorkerTimeoutMs,
  reconcileStaleRuns,
} from "./store"

/**
 * `reconcileStaleRuns` against a recording fake of the Supabase query
 * builder. Pins:
 *   - a run is only failed when it is both inactive AND has no live job
 *     (queued with attempts left, or running under an unexpired lease) —
 *     a worker mid-way through a long step heartbeats its lease without
 *     emitting events, and must not be killed;
 *   - the status flip is conditional on queued/running, and the
 *     synthetic `result` event is only appended when the flip happened.
 */

const USER = "user-1"
const RUN = "run-1"
const NOW = Date.parse("2026-11-20T12:00:00Z")
const MIN = 60_000

type Filter = [op: "eq" | "in", column: string, value: unknown]

interface Query {
  table: string
  op: "select" | "update" | "upsert"
  payload?: unknown
  filters: Filter[]
}

type Result = { data: unknown; error: { message: string } | null }

interface Scenario {
  /** Last event time for the run (null → no events, falls back to started_at). */
  lastEventAt: number | null
  /** Seq of the latest event (default 41 — a started run). */
  lastEventSeq?: number
  startedAt?: number
  /** Task row status (default `running`). */
  status?: string
  createdAt?: number
  jobs?: Array<{
    status: string
    lease_expires_at: string | null
    attempts: number
    max_attempts: number
  }>
  jobsError?: boolean
  /** Rows the conditional update reports as changed. */
  updatedRows?: number
  /** `task_worker_active_within` result (default false); "error" → RPC error. */
  workerActive?: boolean | "error"
}

function fakeDb(s: Scenario) {
  const queries: Query[] = []

  const handle = (q: Query): Result => {
    if (q.table === "tasks" && q.op === "select") {
      return {
        data: [
          {
            id: RUN,
            status: s.status ?? "running",
            started_at: new Date(s.startedAt ?? NOW - 60 * MIN).toISOString(),
            created_at: new Date(s.createdAt ?? s.startedAt ?? NOW - 60 * MIN).toISOString(),
          },
        ],
        error: null,
      }
    }
    if (q.table === "task_events" && q.op === "select") {
      return {
        data:
          s.lastEventAt === null
            ? null
            : {
                seq: s.lastEventSeq ?? 41,
                step: 6,
                created_at: new Date(s.lastEventAt).toISOString(),
              },
        error: null,
      }
    }
    if (q.table === "task_jobs" && q.op === "select") {
      return s.jobsError
        ? { data: null, error: { message: "boom" } }
        : { data: s.jobs ?? [], error: null }
    }
    if (q.table === "tasks" && q.op === "update") {
      const n = s.updatedRows ?? 1
      return { data: Array.from({ length: n }, () => ({ id: RUN })), error: null }
    }
    if (q.table === "task_events" && q.op === "upsert") {
      return { data: null, error: null }
    }
    throw new Error(`unexpected query ${q.op} ${q.table}`)
  }

  const builder = (q: Query) => {
    const b = {
      select: () => b,
      eq: (column: string, value: unknown) => {
        q.filters.push(["eq", column, value])
        return b
      },
      in: (column: string, value: unknown) => {
        q.filters.push(["in", column, value])
        return b
      },
      order: () => b,
      limit: () => b,
      maybeSingle: () => b,
      then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
        queries.push(q)
        try {
          return Promise.resolve(resolve(handle(q)))
        } catch (err) {
          return Promise.resolve(reject(err))
        }
      },
    }
    return b
  }

  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const db = {
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      if (fn !== "task_worker_active_within") throw new Error(`unexpected rpc ${fn}`)
      return s.workerActive === "error"
        ? { data: null, error: { message: "boom" } }
        : { data: s.workerActive ?? false, error: null }
    },
    from: (table: string) => ({
      select: () => builder({ table, op: "select", filters: [] }),
      update: (payload: unknown) => builder({ table, op: "update", payload, filters: [] }),
      upsert: (payload: unknown) => builder({ table, op: "upsert", payload, filters: [] }),
    }),
  }
  return { db: db as never, queries, rpcCalls }
}

const iso = (ms: number) => new Date(ms).toISOString()

describe("reconcileStaleRuns", () => {
  test("a recently active run is left alone without probing jobs", async () => {
    const { db, queries } = fakeDb({ lastEventAt: NOW - 1 * MIN })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(0)
    expect(queries.some((q) => q.table === "task_jobs")).toBe(false)
    expect(queries.some((q) => q.op === "update")).toBe(false)
  })

  test("an inactive run whose worker holds an unexpired lease is NOT failed", async () => {
    // Long reasoning / sandbox step: no events for 10 min, but the worker
    // keeps heartbeating its lease.
    const { db, queries } = fakeDb({
      lastEventAt: NOW - 10 * MIN,
      jobs: [
        { status: "running", lease_expires_at: iso(NOW + 90_000), attempts: 1, max_attempts: 3 },
      ],
    })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(0)
    expect(queries.some((q) => q.op === "update" || q.op === "upsert")).toBe(false)
    const jobQuery = queries.find((q) => q.table === "task_jobs")!
    expect(jobQuery.filters).toContainEqual(["eq", "task_id", RUN])
    expect(jobQuery.filters).toContainEqual(["eq", "user_id", USER])
  })

  test("an inactive run with a queued job (still claimable) is NOT failed", async () => {
    const { db, queries } = fakeDb({
      lastEventAt: NOW - 10 * MIN,
      jobs: [{ status: "queued", lease_expires_at: null, attempts: 0, max_attempts: 3 }],
    })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(0)
    expect(queries.some((q) => q.op === "update")).toBe(false)
  })

  test("an unreadable job table counts as live (never fail on a guess)", async () => {
    const { db, queries } = fakeDb({ lastEventAt: NOW - 10 * MIN, jobsError: true })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(0)
    expect(queries.some((q) => q.op === "update")).toBe(false)
  })

  test.each([
    [
      "lease expired (dead worker)",
      [{ status: "running", lease_expires_at: iso(NOW - 1_000), attempts: 1, max_attempts: 3 }],
    ],
    [
      "running without a lease (legacy)",
      [{ status: "running", lease_expires_at: null, attempts: 1, max_attempts: 3 }],
    ],
    [
      "queued but out of attempts",
      [{ status: "queued", lease_expires_at: null, attempts: 3, max_attempts: 3 }],
    ],
    ["no job at all", []],
  ])("an inactive run with no live job is failed — %s", async (_label, jobs) => {
    const { db, queries } = fakeDb({ lastEventAt: NOW - 10 * MIN, jobs })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(1)

    const update = queries.find((q) => q.table === "tasks" && q.op === "update")!
    expect(update.payload).toMatchObject({ status: "failed" })
    // Conditional: can't overwrite a run that settled (or was cancelled /
    // paused) in the meantime.
    expect(update.filters).toContainEqual(["in", "status", ["queued", "running"]])
    expect(update.filters).toContainEqual(["eq", "user_id", USER])

    const upsert = queries.find((q) => q.op === "upsert")!
    expect(upsert.table).toBe("task_events")
    expect(upsert.payload).toMatchObject({ task_id: RUN, seq: 42, kind: "result" })
    // Settle first, then the event.
    expect(queries.indexOf(update)).toBeLessThan(queries.indexOf(upsert))
  })

  test("a run that settled concurrently gets no stray result event", async () => {
    const { db, queries } = fakeDb({ lastEventAt: NOW - 10 * MIN, jobs: [], updatedRows: 0 })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(0)
    expect(queries.some((q) => q.op === "upsert")).toBe(false)
  })

  test("falls back to started_at when the run has no events", async () => {
    const { db } = fakeDb({ lastEventAt: null, startedAt: NOW - 10 * MIN, jobs: [] })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(1)
  })

  test("only reads and settles background runs (interactive runs have their own reaper — 0041)", async () => {
    const { db, queries } = fakeDb({ lastEventAt: NOW - 10 * MIN, jobs: [] })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW)).toBe(1)
    const taskQueries = queries.filter((q) => q.table === "tasks")
    expect(taskQueries.map((q) => q.op)).toEqual(["select", "update"])
    for (const q of taskQueries) expect(q.filters).toContainEqual(["eq", "mode", "background"])
  })
})

describe("reconcileStaleRuns — never-started runs (no task worker)", () => {
  const neverStarted = (over: Partial<Scenario> = {}): Scenario => ({
    status: "queued",
    lastEventAt: NOW - 30 * MIN,
    lastEventSeq: 1, // only the route's `status: queued` marker
    createdAt: NOW - 30 * MIN,
    ...over,
  })

  test("is failed with the no-worker error despite a claimable queued job", async () => {
    // No worker executed anything in the window (agent-py down or in
    // dry-run, which releases + refunds the claim), so the job sits
    // `queued` with attempts left forever.
    const { db, queries, rpcCalls } = fakeDb(
      neverStarted({
        jobs: [{ status: "queued", lease_expires_at: null, attempts: 0, max_attempts: 3 }],
      })
    )
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(1)
    const upsert = queries.find((q) => q.op === "upsert")!
    expect(JSON.stringify(upsert.payload)).toContain(NO_WORKER_ERROR)
    const update = queries.find((q) => q.table === "tasks" && q.op === "update")!
    expect(update.filters).toContainEqual(["in", "status", ["queued", "running"]])
    expect(rpcCalls).toEqual([
      { fn: "task_worker_active_within", args: { p_seconds: 600 } },
    ])
  })

  test("a busy worker elsewhere (backlog) keeps a long-queued run waiting", async () => {
    const { db, queries } = fakeDb(
      neverStarted({
        workerActive: true,
        jobs: [{ status: "queued", lease_expires_at: null, attempts: 0, max_attempts: 3 }],
      })
    )
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(0)
    expect(queries.some((q) => q.op === "update")).toBe(false)
  })

  test("a liveness probe error never fails the run", async () => {
    const { db } = fakeDb(neverStarted({ workerActive: "error", jobs: [] }))
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(0)
  })

  test("a run with no events at all (child task) counts as never started", async () => {
    const { db } = fakeDb(neverStarted({ lastEventAt: null, jobs: [] }))
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(1)
  })

  test("waits the full no-worker window, not the 3-min inactivity window", async () => {
    const { db, queries } = fakeDb(
      neverStarted({ createdAt: NOW - 5 * MIN, lastEventAt: NOW - 5 * MIN, jobs: [] })
    )
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(0)
    expect(queries.some((q) => q.op === "update")).toBe(false)
  })

  test("a worker holding the job's lease (first step, no event yet) keeps it alive", async () => {
    const { db, queries } = fakeDb(
      neverStarted({
        jobs: [
          { status: "running", lease_expires_at: iso(NOW + 60_000), attempts: 1, max_attempts: 3 },
        ],
      })
    )
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(0)
    expect(queries.some((q) => q.op === "update")).toBe(false)
  })

  test("a started run keeps the lease-aware rule: its queued job keeps it alive", async () => {
    const { db } = fakeDb({
      status: "queued",
      lastEventAt: NOW - 30 * MIN,
      lastEventSeq: 7,
      jobs: [{ status: "queued", lease_expires_at: null, attempts: 0, max_attempts: 3 }],
    })
    expect(await reconcileStaleRuns(db, USER, 3 * MIN, NOW, 10 * MIN)).toBe(0)
  })
})

describe("appendSyntheticResult", () => {
  test("`from` narrows what it may settle: a run a worker took is left alone", async () => {
    const { db, queries } = fakeDb({ lastEventAt: null, updatedRows: 0 })
    const settled = await appendSyntheticResult(db, RUN, USER, { status: "failed", from: ["queued"] })
    expect(settled).toBe(false)
    const update = queries.find((q) => q.op === "update")
    expect(update?.filters).toContainEqual(["in", "status", ["queued"]])
    expect(queries.some((q) => q.op === "upsert")).toBe(false)
  })
})

describe("getQuestionKind", () => {
  const interrupt = (id: string, reason?: string) => ({
    id: RUN,
    outcome: { type: "interrupt", interrupts: [{ id, ...(reason ? { reason } : {}) }] },
  })

  /** A client whose only surface is the approval-entry read. */
  function logDb(payload: unknown) {
    const filters: unknown[][] = []
    const q = {
      select: () => q,
      eq: (...f: unknown[]) => {
        filters.push(f)
        return q
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: payload === null ? null : { payload }, error: null }),
    }
    return { db: { from: () => q } as never, filters }
  }

  test("from the row's open interrupts, without reading the log", async () => {
    const db = { from: () => expect.unreachable() } as never
    expect(await getQuestionKind(db, interrupt("q", "choice") as never, USER, "q")).toBe("choice")
    expect(await getQuestionKind(db, interrupt("q") as never, USER, "q")).toBe("approval")
    expect(await getQuestionKind(db, interrupt("other") as never, USER, "q")).toBeNull()
  })

  test("a row paused before 0045: from the request entry", async () => {
    const { db, filters } = logDb({ phase: "request", approvalId: "q", requestKind: "input" })
    expect(await getQuestionKind(db, { id: RUN, outcome: null } as never, USER, "q")).toBe("input")
    expect(filters).toContainEqual(["user_id", USER])
    expect(filters).toContainEqual(["payload->>approvalId", "q"])
    const bare = logDb({ phase: "request", approvalId: "q" })
    expect(await getQuestionKind(bare.db, { id: RUN, outcome: null } as never, USER, "q")).toBe(
      "approval"
    )
    const none = logDb(null)
    expect(await getQuestionKind(none.db, { id: RUN, outcome: null } as never, USER, "q")).toBeNull()
  })
})

describe("noWorkerTimeoutMs", () => {
  test.each([
    [undefined, DEFAULT_NO_WORKER_TIMEOUT_MS],
    ["", DEFAULT_NO_WORKER_TIMEOUT_MS],
    ["abc", DEFAULT_NO_WORKER_TIMEOUT_MS],
    ["0", DEFAULT_NO_WORKER_TIMEOUT_MS],
    ["-2", DEFAULT_NO_WORKER_TIMEOUT_MS],
    ["15", 15 * MIN],
    ["0.5", 30_000],
  ] as const)("%p → %p", (raw, expected) => {
    expect(noWorkerTimeoutMs(raw)).toBe(expected)
  })
})
