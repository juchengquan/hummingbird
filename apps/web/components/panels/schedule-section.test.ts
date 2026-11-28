import { describe, expect, test } from "bun:test"

import { schedulesReadable } from "./schedule-section"

describe("the schedules section reads schedules only signed in (Q123)", () => {
  test("signed out (or no Supabase) nothing is requested: no `/api/tasks/schedules` call", () => {
    expect(schedulesReadable("signed-in")).toBe(true)
    expect(schedulesReadable("signed-out")).toBe(false)
    expect(schedulesReadable("unconfigured")).toBe(false)
    expect(schedulesReadable("loading")).toBe(false)
  })
})
