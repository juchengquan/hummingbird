import { describe, expect, test } from "bun:test"

import { subagentPillLabel } from "./subagent-pill-label"

describe("subagentPillLabel", () => {
  test("returns the status when childTaskId is found in statuses", () => {
    const statuses = { c1: "running", c2: "done" }
    expect(subagentPillLabel("c1", statuses)).toBe("running")
    expect(subagentPillLabel("c2", statuses)).toBe("done")
  })

  test("returns 'queued' when childTaskId is not in statuses", () => {
    const statuses = { c1: "running" }
    expect(subagentPillLabel("unknown", statuses)).toBe("queued")
  })

  test("returns 'queued' for empty statuses map", () => {
    expect(subagentPillLabel("c1", {})).toBe("queued")
  })
})
