import { describe, expect, test } from "bun:test"

import { nextRunFromCron } from "./schedules"

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
