/**
 * Queue SQL — `src/jobs.ts`.
 *
 * The previous port targeted columns `task_jobs` never had
 * (`scheduled_for`, `priority`, `claimed_at`, `claimed_by`, `attempt`,
 * `last_error`) and a status (`'claimed'`) the CHECK constraint rejects,
 * so every claim failed. These tests pin the real schema (0014 + 0032)
 * and statement-for-statement parity with agent-py's `jobs.py`, using a
 * recording fake of the `postgres` driver's `sql.unsafe`.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  CLAIM_SQL,
  EXTEND_LEASE_SQL,
  HAND_BACK_SQL,
  MARK_DONE_SQL,
  MARK_FAILED_SQL,
  RELEASE_SQL,
  claimNextJob,
  extendLease,
  handBackJob,
  markJobDone,
  markJobFailed,
  releaseJobToQueue,
} from "../src/jobs"

interface Call {
  stmt: string
  params: unknown[]
}

/** Fake `Sql`: records every `unsafe` call and resolves with `rows`
 *  (`count` mimics the driver's affected-row count on an UPDATE). */
function fakeSql(rows: unknown[] = [], count = rows.length) {
  const calls: Call[] = []
  const sql = {
    unsafe: async (stmt: string, params: unknown[] = []) => {
      calls.push({ stmt, params })
      return Object.assign([...rows], { count })
    },
  }
  return { sql: sql as never, calls }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

const ALL_SQL: Array<[string, string]> = [
  ["CLAIM_SQL", CLAIM_SQL],
  ["RELEASE_SQL", RELEASE_SQL],
  ["MARK_DONE_SQL", MARK_DONE_SQL],
  ["MARK_FAILED_SQL", MARK_FAILED_SQL],
  ["EXTEND_LEASE_SQL", EXTEND_LEASE_SQL],
  ["HAND_BACK_SQL", HAND_BACK_SQL],
]

describe("queue SQL matches the real task_jobs schema", () => {
  test.each(ALL_SQL)("%s uses no phantom columns", (_name, stmt) => {
    for (const phantom of [
      "scheduled_for",
      "priority",
      "claimed_at",
      "claimed_by",
      "last_error",
    ]) {
      expect(stmt).not.toContain(phantom)
    }
    // `attempts` (plural) is the column; a bare `attempt` is not.
    expect(stmt).not.toMatch(/\battempt\b/)
  })

  test.each(ALL_SQL)("%s only uses statuses the CHECK allows", (_name, stmt) => {
    // Quoted lowercase words are status literals — plus the jsonb key
    // `'message'` in the failed-error object.
    const literals = [...stmt.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    for (const literal of literals) {
      expect(["queued", "running", "done", "failed", "message"]).toContain(literal)
    }
  })
})

describe("parity with agent-py jobs.py", () => {
  const py = readFileSync(
    join(import.meta.dir, "..", "..", "agent-py", "src", "agent_py", "jobs.py"),
    "utf8",
  )
  const pySql = (name: string): string => {
    const m = py.match(new RegExp(`^${name} = """([\\s\\S]*?)"""`, "m"))
    if (!m) throw new Error(`${name} not found in jobs.py`)
    return m[1]
  }

  test.each(ALL_SQL)("%s is statement-for-statement identical", (name, tsSql) => {
    expect(norm(tsSql)).toBe(norm(pySql(`_${name}`)))
  })
})

describe("claimNextJob", () => {
  const row = {
    id: "job-1",
    task_id: "task-1",
    user_id: "user-1",
    action: "respond",
    payload: '{"requestId":"tu_1"}',
    attempts: 2,
    max_attempts: 3,
    reclaimed: true,
  }

  test("stamps the lease and honours max_attempts", async () => {
    const { sql, calls } = fakeSql([])
    expect(await claimNextJob(sql, { leaseSeconds: 90, reclaimExpired: false })).toBeNull()
    const flat = norm(calls[0].stmt)
    expect(flat).toContain("SET status = 'running'")
    expect(flat).toContain("attempts = t.attempts + 1")
    expect(flat).toContain("attempts < max_attempts")
    expect(flat).toContain("(status = 'queued' AND scheduled_at <= now())")
    expect(flat).toContain(
      "($2::boolean AND status = 'running' AND lease_expires_at < now())",
    )
    expect(flat).toContain(
      "lease_expires_at = now() + $1::double precision * interval '1 second'",
    )
    expect(flat).toContain("FOR UPDATE SKIP LOCKED")
    expect(calls[0].params).toEqual([90, false])
  })

  test("defaults: 120 s lease, reclaim expired leases", async () => {
    const { sql, calls } = fakeSql([])
    await claimNextJob(sql)
    expect(calls[0].params).toEqual([120, true])
  })

  test("maps the row (incl. string payload + reclaimed flag)", async () => {
    const { sql } = fakeSql([row])
    expect(await claimNextJob(sql)).toEqual({
      id: "job-1",
      taskId: "task-1",
      userId: "user-1",
      action: "respond",
      payload: { requestId: "tu_1" },
      attempts: 2,
      maxAttempts: 3,
      reclaimed: true,
    })
  })
})

describe("release / settle / lease", () => {
  test("release backs off, refunds the attempt, clears the lease", async () => {
    const { sql, calls } = fakeSql([], 1)
    expect(await releaseJobToQueue(sql, "job-1")).toBe(true)
    const flat = norm(calls[0].stmt)
    expect(flat).toContain("SET status = 'queued'")
    expect(flat).toContain("attempts = GREATEST(attempts - 1, 0)")
    expect(flat).toContain("lease_expires_at = NULL")
    expect(flat).toContain("GREATEST(interval '5 seconds', (now() - created_at) / 2)")
    expect(flat).toContain("AND status = 'running'")
    expect(calls[0].params).toEqual(["job-1"])
  })

  test("release reports a row that was no longer running", async () => {
    const { sql } = fakeSql([], 0)
    expect(await releaseJobToQueue(sql, "job-1")).toBe(false)
  })

  test("markJobDone is unfenced by default, fenced when given attempts", async () => {
    const { sql, calls } = fakeSql([], 1)
    expect(await markJobDone(sql, "job-1")).toBe(true)
    expect(await markJobDone(sql, "job-1", 2)).toBe(true)
    expect(calls.map((c) => c.params)).toEqual([
      ["job-1", null],
      ["job-1", 2],
    ])
    expect(norm(calls[0].stmt)).toContain("SET status = 'done'")
  })

  test("markJobFailed writes the error into the jsonb error column", async () => {
    const { sql, calls } = fakeSql([], 1)
    await markJobFailed(sql, "job-1", "boom", 2)
    expect(norm(calls[0].stmt)).toContain(
      "error = jsonb_build_object('message', $2::text)",
    )
    expect(calls[0].params).toEqual(["job-1", "boom", 2])
  })

  test("extendLease is fenced on attempts and reports a lost claim", async () => {
    const { sql, calls } = fakeSql([], 0)
    expect(await extendLease(sql, "job-1", 2, 60)).toBe(false)
    expect(calls[0].params).toEqual(["job-1", 2, 60])
  })

  test("handBackJob expires the lease and refunds the attempt", async () => {
    const { sql, calls } = fakeSql([], 1)
    expect(await handBackJob(sql, "job-1", 2)).toBe(true)
    const flat = norm(calls[0].stmt)
    expect(flat).toContain("lease_expires_at = now() - interval '1 second'")
    expect(flat).toContain("attempts = GREATEST(attempts - 1, 0)")
    expect(calls[0].params).toEqual(["job-1", 2])
  })
})
