import { describe, expect, test } from "bun:test"

import { parseActiveRuns, serializeActiveRuns, type ActiveRunRecord } from "./active-run"
import { compareCursors, cursorSeq, isRunCursor } from "./cursor"
import { isUuid, mintRunId, resultIdsFor, threadIdFor, uuidV5 } from "./ids"

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

  test("uuidV5 is RFC 9562's name-based UUID (Python's uuid.uuid5)", () => {
    // uuid.uuid5(uuid.NAMESPACE_DNS, "python.org")
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    )
    // Multi-byte UTF-8, several SHA-1 blocks.
    expect(uuidV5("79bb547a-2a52-4e57-b1d8-78c6e8a369c4", "é".repeat(100))).toBe(
      "120464bb-48a1-5721-80b0-22d8b93a2e0f",
    )
    expect(() => uuidV5("not-a-uuid", "x")).toThrow()
  })

  test("resultIdsFor derives a task's result ids, the same everywhere (Q70)", () => {
    const user = "0b9c6a2e-6f1d-4c55-9a4e-3f2d1c0b9a87"
    const root = "8a6e0804-2bd0-4672-b79d-d97027f9071a"
    // uuid.uuid5(TASK_RESULT_NAMESPACE, f"task-result:{kind}:{user}:{root}")
    const ids = {
      messageId: "97884607-5576-50dc-a73e-20be0ff038f4",
      documentId: "b23cc834-85e6-5046-9cdd-f355bc2deae4",
      artifactId: "dd086f10-e704-5d44-a1f6-377dffe4e2fc",
    }
    expect(resultIdsFor(user, root)).toEqual(ids)
    expect(resultIdsFor(user.toUpperCase(), root.toUpperCase())).toEqual(ids)
    for (const id of Object.values(ids)) {
      expect(isUuid(id)).toBe(true)
      expect(id[14]).toBe("5")
    }
    const otherUser = resultIdsFor("1b9c6a2e-6f1d-4c55-9a4e-3f2d1c0b9a87", root)
    const otherTask = resultIdsFor(user, "9a6e0804-2bd0-4672-b79d-d97027f9071a")
    for (const other of [otherUser, otherTask]) {
      expect(other.messageId).not.toBe(ids.messageId)
      expect(other.documentId).not.toBe(ids.documentId)
    }
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
