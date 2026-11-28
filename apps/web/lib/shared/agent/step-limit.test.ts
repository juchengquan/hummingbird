import { describe, expect, test } from "bun:test"

import { stepLimitNote, stoppedAtStepLimit, withStepLimitNote } from "./step-limit"

describe("the step-limit note (Q81)", () => {
  test("reads RunResult.stoppedAt", () => {
    expect(stoppedAtStepLimit({ text: "x", stoppedAt: "max_steps" })).toBe(true)
    expect(stoppedAtStepLimit({ text: "x" })).toBe(false)
    expect(stoppedAtStepLimit({ stoppedAt: "other" })).toBe(false)
    expect(stoppedAtStepLimit(null)).toBe(false)
    expect(stoppedAtStepLimit(undefined)).toBe(false)
  })

  test("names the limit when known", () => {
    expect(stepLimitNote(25)).toContain("25 steps")
    expect(stepLimitNote(null)).toContain("Stopped at the step limit")
  })

  test("the delivered message ends with the note, once", () => {
    const once = withStepLimitNote("Partial report.", 25)
    expect(once.startsWith("Partial report.")).toBe(true)
    expect(once.endsWith(`_${stepLimitNote(25)}_`)).toBe(true)
    expect(withStepLimitNote(once, 25)).toBe(once)
    expect(withStepLimitNote("", 25)).toBe(`_${stepLimitNote(25)}_`)
  })
})
