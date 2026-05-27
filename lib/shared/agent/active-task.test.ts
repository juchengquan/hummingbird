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
