import { describe, expect, test } from "bun:test"

import { e2eTasksFakeAllowed } from "./use-tasks-value"

describe("the e2e tasks fake", () => {
  test("is off unless the build sets NEXT_PUBLIC_E2E_TASKS_FAKE=1", () => {
    expect(e2eTasksFakeAllowed(undefined)).toBe(false)
    expect(e2eTasksFakeAllowed("")).toBe(false)
    expect(e2eTasksFakeAllowed("0")).toBe(false)
    expect(e2eTasksFakeAllowed("true")).toBe(false)
    expect(e2eTasksFakeAllowed("1")).toBe(true)
  })

  test("is off in this process (no build flag set)", () => {
    expect(e2eTasksFakeAllowed(process.env.NEXT_PUBLIC_E2E_TASKS_FAKE)).toBe(false)
  })
})
