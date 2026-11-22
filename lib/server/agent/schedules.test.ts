import { describe, expect, test } from "bun:test"

import {
  SCHEDULE_DISPATCH_MIN_GAP_MS,
  cronPassesCoarseGuard,
  dispatchDueSchedules,
  nextRunFromCron,
  pickFairBatch,
  scheduleSkills,
  validateScheduleCron,
} from "./schedules"

describe("nextRunFromCron", () => {
  test("fires at the next matching minute in the given timezone", () => {
    // 2026-05-30 12:00:00 UTC is 05:00 in LA (PDT, UTC-7). The next
    // "08:00 LA" therefore lands at 15:00 UTC the same day.
    const after = new Date("2026-05-30T12:00:00Z")
    const next = nextRunFromCron("0 8 * * *", "America/Los_Angeles", after)
    expect(next).not.toBeNull()
    expect(next!.toISOString()).toBe("2026-05-30T15:00:00.000Z")
  })

  test("rolls into the next day when today's slot has passed", () => {
    // 2026-05-30 16:00:00 UTC is already 09:00 LA (past 08:00). Next
    // 08:00 LA fire is the following day → 2026-05-31T15:00:00Z.
    const after = new Date("2026-05-30T16:00:00Z")
    const next = nextRunFromCron("0 8 * * *", "America/Los_Angeles", after)
    expect(next!.toISOString()).toBe("2026-05-31T15:00:00.000Z")
  })

  test("strictly after — does not return `after` itself when it matches", () => {
    // The boundary at the top of an hour ("0 8 * * *"). If we pass
    // exactly 08:00 UTC as `after`, the next fire is 09:00 the day
    // after — not the same minute.
    const after = new Date("2026-05-30T08:00:00Z")
    const next = nextRunFromCron("0 8 * * *", "UTC", after)
    expect(next!.toISOString()).toBe("2026-05-31T08:00:00.000Z")
  })

  test("returns null on an unparseable cron", () => {
    expect(nextRunFromCron("not a cron", "UTC", new Date())).toBeNull()
  })

  test("returns null on an unknown timezone", () => {
    expect(
      nextRunFromCron("0 8 * * *", "Mars/Olympus_Mons", new Date())
    ).toBeNull()
  })

  test("supports common shorthand expressions", () => {
    // Every 5 minutes — well-defined; verify the next fire is within
    // 5 minutes of `after`.
    const after = new Date("2026-05-30T12:02:00Z")
    const next = nextRunFromCron("*/5 * * * *", "UTC", after)
    expect(next).not.toBeNull()
    const delta = next!.getTime() - after.getTime()
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(5 * 60 * 1000)
  })
})

describe("validateScheduleCron (≥ 5 min between fires)", () => {
  const after = new Date("2026-05-30T12:02:00Z")

  test.each(["0 8 * * *", "*/5 * * * *", "0,30 * * * *", "5-55/10 9-17 * * 1-5", "0 */2 * * *"])(
    "accepts %s",
    (cron) => {
      expect(validateScheduleCron(cron, "UTC", after).ok).toBe(true)
    }
  )

  test.each([
    "* * * * *", // every minute
    "*/2 * * * *",
    "0-59 * * * *", // range without a step
    "0,1 * * * *", // two fires a minute apart
    "0,59 * * * *", // 1-minute gap across the hour boundary
    "0,3,10 8 * * *", // passes the coarse guard, 3-minute gap
  ])("rejects %s as too frequent", (cron) => {
    const res = validateScheduleCron(cron, "UTC", after)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toMatch(/more often than every 5 minutes/)
  })

  test("unparseable cron / unknown tz → parse error message", () => {
    const bad = validateScheduleCron("not a cron", "UTC", after)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toMatch(/Couldn't parse/)
    expect(validateScheduleCron("0 8 * * *", "Mars/Olympus_Mons", after).ok).toBe(false)
  })

  test("returns the first fire after `after`", () => {
    const res = validateScheduleCron("0 8 * * *", "UTC", after)
    expect(res.ok && res.next.toISOString()).toBe("2026-05-31T08:00:00.000Z")
  })
})

describe("cronPassesCoarseGuard (mirror of the 0035 DB guard)", () => {
  test.each([
    ["0 8 * * *", true],
    ["*/5 * * * *", true],
    ["0/15 * * * *", true],
    ["0,5,10,15,20,25,30,35,40,45,50,55 * * * *", true], // 12 entries
    ["0,5,10,15,20,25,30,35,40,45,50,55,58 * * * *", false], // 13 entries
    ["* * * * *", false],
    ["*/4 * * * *", false],
    ["0 0 8 * * *", false], // six fields (seconds) not allowed
    ["@hourly", false],
  ] as const)("%s → %p", (cron, ok) => {
    expect(cronPassesCoarseGuard(cron)).toBe(ok)
  })
})

describe("pickFairBatch", () => {
  const row = (user: string, n: number) => ({ id: `${user}-${n}`, user_id: user })

  test("one user's backlog can't fill the batch", () => {
    // 60 due rows from `hog` (earliest), then one each from two others.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row("hog", i)),
      row("alice", 0),
      row("bob", 0),
    ]
    const picked = pickFairBatch(rows, { maxTotal: 50, maxPerUser: 5 })
    expect(picked.filter((r) => r.user_id === "hog")).toHaveLength(5)
    expect(picked.map((r) => r.id)).toContain("alice-0")
    expect(picked.map((r) => r.id)).toContain("bob-0")
    expect(picked).toHaveLength(7)
  })

  test("round-robin order: earliest-due user first, oldest row first", () => {
    const rows = [row("a", 0), row("a", 1), row("b", 0), row("a", 2), row("b", 1)]
    const picked = pickFairBatch(rows, { maxTotal: 10, maxPerUser: 2 })
    expect(picked.map((r) => r.id)).toEqual(["a-0", "b-0", "a-1", "b-1"])
  })

  test("caps the total across many users", () => {
    const rows = Array.from({ length: 80 }, (_, i) => row(`u${i}`, 0))
    const picked = pickFairBatch(rows, { maxTotal: 50, maxPerUser: 5 })
    expect(picked).toHaveLength(50)
    expect(picked[0].id).toBe("u0-0")
    expect(picked[49].id).toBe("u49-0")
  })

  test("empty input → empty batch", () => {
    expect(pickFairBatch([], { maxTotal: 50, maxPerUser: 5 })).toEqual([])
  })
})

describe("dispatchDueSchedules — minimum-gap throttle", () => {
  test("a row that fired < 4 min ago is deferred, not fired", async () => {
    const now = Date.now()
    const lastRun = new Date(now - 60_000).toISOString()
    const dueRow = {
      id: "s-1",
      user_id: "u-1",
      cron: "* * * * *", // legacy / direct-PostgREST row
      timezone: "UTC",
      next_run_at: new Date(now - 1_000).toISOString(),
      last_run_at: lastRun,
    }
    const updates: Array<{ patch: Record<string, unknown>; filters: [string, unknown][] }> = []
    const inserts: string[] = []
    const db = {
      from(table: string) {
        return {
          select: () => ({
            eq: () => ({
              lte: () => ({
                order: () => ({ limit: async () => ({ data: [dueRow], error: null }) }),
              }),
            }),
          }),
          update(patch: Record<string, unknown>) {
            const entry = { patch, filters: [] as [string, unknown][] }
            updates.push(entry)
            const chain = {
              eq(col: string, val: unknown) {
                entry.filters.push([col, val])
                return chain
              },
              then(resolve: (v: { error: null }) => void) {
                resolve({ error: null })
              },
            }
            return chain
          },
          insert() {
            inserts.push(table)
            return Promise.resolve({ error: null })
          },
        }
      },
      rpc() {
        throw new Error("should not enqueue")
      },
    }
    const fired = await dispatchDueSchedules(
      db as unknown as Parameters<typeof dispatchDueSchedules>[0]
    )
    expect(fired).toBe(0)
    expect(inserts).toEqual([])
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.next_run_at).toBe(
      new Date(Date.parse(lastRun) + SCHEDULE_DISPATCH_MIN_GAP_MS).toISOString()
    )
    // Guarded on the row we read, so a racing tick can't double-defer.
    expect(updates[0].filters).toContainEqual(["next_run_at", dueRow.next_run_at])
  })
})

describe("scheduleSkills", () => {
  test("unset (what the editor saves) keeps every skill the executor runs", () => {
    expect(scheduleSkills(null)).toEqual([
      { id: "webSearch" },
      { id: "webFetch" },
      { id: "searchFiles" },
      { id: "imageGen" },
    ])
  })

  test("an explicit choice is kept, including none", () => {
    expect(scheduleSkills([])).toEqual([])
    expect(scheduleSkills([{ id: "webSearch" }])).toEqual([{ id: "webSearch" }])
  })
})
