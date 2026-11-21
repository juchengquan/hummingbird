import { describe, expect, test } from "bun:test"

import { parseActiveRuns, serializeActiveRuns, type ActiveRunRecord } from "./active-run"
import { compareCursors, cursorSeq, isRunCursor } from "./cursor"
import { isUuid, mintRunId, threadIdFor } from "./ids"

describe("ids", () => {
  test("mintRunId is a UUIDv4", () => {
    const ids = new Set(Array.from({ length: 50 }, mintRunId))
    expect(ids.size).toBe(50)
    for (const id of ids) {
      expect(isUuid(id)).toBe(true)
      expect(id[14]).toBe("4")
      expect("89ab").toContain(id[19])
    }
  })

  test("threadIdFor keeps a UUID conversation id and maps any other id stably", () => {
    const uuid = "8A6E0804-2BD0-4672-B79D-D97027F9071A"
    expect(threadIdFor(uuid)).toBe(uuid.toLowerCase())
    const legacy = "lzx1abc-k3j4h5g6f-q9w8e7r6t"
    expect(isUuid(threadIdFor(legacy))).toBe(true)
    expect(threadIdFor(legacy)).toBe(threadIdFor(legacy))
    expect(threadIdFor(legacy)).not.toBe(threadIdFor(`${legacy}x`))
  })
})

describe("cursor", () => {
  test("format", () => {
    for (const c of ["0", "1", "42", "42.0", "42.13"]) expect(isRunCursor(c)).toBe(true)
    for (const c of ["", "01", "1.", "1.01", "a", "-1", "1.2.3"]) expect(isRunCursor(c)).toBe(false)
  })

  test("order: <seq>.<k> before the plain <seq>, by seq first", () => {
    const sorted = ["0", "1", "2.0", "2.1", "2", "3.0", "10"]
    const shuffled = [...sorted].reverse()
    expect(shuffled.sort(compareCursors)).toEqual(sorted)
    expect(compareCursors("4.1", "4.1")).toBe(0)
    expect(cursorSeq("12.3")).toBe(12)
  })
})

describe("active-run codec", () => {
  const record: ActiveRunRecord = {
    runId: "8a6e0804-2bd0-4672-b79d-d97027f9071a",
    threadId: "11111111-2222-4333-8444-555555555555",
    conversationId: "c1",
    messageId: "m1",
    status: "running",
    cursor: "12.1",
    anonymous: false,
    updatedAt: "2026-11-21T00:00:00.000Z",
  }

  test("round-trips", () => {
    expect(parseActiveRuns(serializeActiveRuns({ c1: record }))).toEqual({ c1: record })
  })

  test("drops malformed entries and garbage, never throws", () => {
    expect(parseActiveRuns("{nope")).toEqual({})
    expect(parseActiveRuns("[]")).toEqual({})
    expect(parseActiveRuns(null)).toEqual({})
    const bad = {
      c1: record,
      c2: { ...record, conversationId: "c2", cursor: "x" },
      c3: { ...record, conversationId: "c3", runId: "not-a-uuid" },
      c4: { ...record }, // keyed under another conversation
    }
    expect(parseActiveRuns(JSON.stringify(bad))).toEqual({ c1: record })
  })
})
