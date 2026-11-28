import { describe, expect, test } from "bun:test"

import {
  parseActiveTask,
  serializeActiveTask,
  type ActiveTaskRecord,
} from "./active-task"

const sample: ActiveTaskRecord = {
  runId: "r1",
  conversationId: "c1",
  cursor: 12,
  status: "running",
  title: "Research task",
  updatedAt: new Date(1).toISOString(),
}

describe("active-task codec", () => {
  test("round-trips a record", () => {
    expect(parseActiveTask(serializeActiveTask(sample))).toEqual(sample)
  })

  test("round-trips a research-mode record", () => {
    const withMode: ActiveTaskRecord = { ...sample, mode: "research" }
    expect(parseActiveTask(serializeActiveTask(withMode))).toEqual(withMode)
  })

  test("older pointers without `mode` still parse", () => {
    // Forward-compat: a pointer persisted by a Phase 1 client must still
    // load on a Phase 2 client (research-mode auto-handoff just won't fire).
    const legacy = JSON.stringify({
      runId: "r1",
      conversationId: "c1",
      cursor: 0,
      status: "running",
      updatedAt: new Date(0).toISOString(),
    })
    const parsed = parseActiveTask(legacy)
    expect(parsed).not.toBeNull()
    expect(parsed?.mode).toBeUndefined()
  })

  test("rejects an unknown mode value", () => {
    expect(
      parseActiveTask(JSON.stringify({ ...sample, mode: "bogus" }))
    ).toBeNull()
  })

  test("returns null for empty / corrupt / foreign input", () => {
    expect(parseActiveTask(null)).toBeNull()
    expect(parseActiveTask("")).toBeNull()
    expect(parseActiveTask("{ not json")).toBeNull()
    expect(parseActiveTask(JSON.stringify({ runId: "r1" }))).toBeNull()
    expect(
      parseActiveTask(JSON.stringify({ ...sample, status: "bogus" }))
    ).toBeNull()
  })
})
