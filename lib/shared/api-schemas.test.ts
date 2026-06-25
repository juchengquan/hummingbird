import { describe, expect, test } from "bun:test"

import {
  ChatRequestSchema,
  COMPLETE_BLOCK_MAX,
  COMPLETE_PREFIX_MAX,
  CompleteRequestSchema,
  ExtractTableRequestSchema,
  RefreshFileUrlRequestSchema,
  RefreshImageUrlRequestSchema,
  TaskChildrenResponseSchema,
} from "./api-schemas"

describe("RefreshImageUrlRequestSchema", () => {
  test("accepts a normal user-scoped storage path", () => {
    const r = RefreshImageUrlRequestSchema.safeParse({
      storagePath: "abc-123/generated/img-42.png",
    })
    expect(r.success).toBe(true)
  })

  test("rejects empty string", () => {
    expect(
      RefreshImageUrlRequestSchema.safeParse({ storagePath: "" }).success
    ).toBe(false)
  })

  test("rejects path traversal", () => {
    expect(
      RefreshImageUrlRequestSchema.safeParse({
        storagePath: "abc/../../etc/passwd",
      }).success
    ).toBe(false)
  })

  test("rejects leading-slash absolute path", () => {
    expect(
      RefreshImageUrlRequestSchema.safeParse({ storagePath: "/abc/x.png" })
        .success
    ).toBe(false)
  })

  test("rejects missing field", () => {
    expect(RefreshImageUrlRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe("RefreshFileUrlRequestSchema", () => {
  test("accepts a valid storage path", () => {
    const r = RefreshFileUrlRequestSchema.safeParse({
      storagePath: "user-123/generated/abc-report.csv",
    })
    expect(r.success).toBe(true)
  })
  test("rejects an empty path", () => {
    expect(RefreshFileUrlRequestSchema.safeParse({ storagePath: "" }).success).toBe(false)
  })
  test("rejects a path containing ..", () => {
    expect(
      RefreshFileUrlRequestSchema.safeParse({ storagePath: "user-123/../secret" }).success,
    ).toBe(false)
  })
  test("rejects a path starting with /", () => {
    expect(
      RefreshFileUrlRequestSchema.safeParse({ storagePath: "/abc/x.csv" }).success,
    ).toBe(false)
  })
  test("rejects a missing path", () => {
    expect(RefreshFileUrlRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe("CompleteRequestSchema", () => {
  test("accepts a minimal request (blockText only)", () => {
    const r = CompleteRequestSchema.safeParse({ blockText: "hello" })
    expect(r.success).toBe(true)
  })

  test("accepts a full request (prefix + blockText + model)", () => {
    const r = CompleteRequestSchema.safeParse({
      blockText: "and then",
      prefix: "earlier text",
      model: "google/gemini-2.5-flash",
    })
    expect(r.success).toBe(true)
  })

  test("rejects missing blockText", () => {
    expect(CompleteRequestSchema.safeParse({}).success).toBe(false)
  })

  test("rejects non-string blockText", () => {
    expect(
      CompleteRequestSchema.safeParse({ blockText: 42 }).success
    ).toBe(false)
  })

  test("rejects blockText longer than COMPLETE_BLOCK_MAX", () => {
    const over = "x".repeat(COMPLETE_BLOCK_MAX + 1)
    expect(
      CompleteRequestSchema.safeParse({ blockText: over }).success
    ).toBe(false)
  })

  test("accepts blockText at the COMPLETE_BLOCK_MAX boundary", () => {
    const max = "x".repeat(COMPLETE_BLOCK_MAX)
    expect(
      CompleteRequestSchema.safeParse({ blockText: max }).success
    ).toBe(true)
  })

  test("accepts a long-but-bounded prefix (within 4× the truncation cap)", () => {
    // The schema cap is 4× COMPLETE_PREFIX_MAX so legitimate clients
    // can send slack; the builder truncates to the trailing window.
    const long = "x".repeat(COMPLETE_PREFIX_MAX * 4)
    expect(
      CompleteRequestSchema.safeParse({ blockText: "a", prefix: long })
        .success
    ).toBe(true)
  })

  test("rejects a prefix past the schema's wire cap", () => {
    const tooLong = "x".repeat(COMPLETE_PREFIX_MAX * 4 + 1)
    expect(
      CompleteRequestSchema.safeParse({ blockText: "a", prefix: tooLong })
        .success
    ).toBe(false)
  })

  test("rejects a model id longer than 100 chars", () => {
    const long = "x".repeat(101)
    expect(
      CompleteRequestSchema.safeParse({ blockText: "a", model: long })
        .success
    ).toBe(false)
  })
})

describe("ChatRequestSchema.sandboxFiles", () => {
  const base = { messages: [{ role: "user", content: "hi" }] }
  test("accepts a manifest of local + cloud entries", () => {
    const r = ChatRequestSchema.safeParse({
      ...base,
      sandboxFiles: [
        { name: "data.csv", fileId: "f1", dataBase64: "YQ==" }, // local
        { name: "big.parquet", fileId: "f2" }, // cloud (no bytes)
      ],
    })
    expect(r.success).toBe(true)
  })
  test("absent is fine (back-compat)", () => {
    expect(ChatRequestSchema.safeParse(base).success).toBe(true)
  })
  test("rejects more than 10 entries", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}`,
      fileId: `id${i}`,
    }))
    expect(
      ChatRequestSchema.safeParse({ ...base, sandboxFiles: many }).success
    ).toBe(false)
  })
  test("rejects an over-cap dataBase64 blob", () => {
    const huge = "A".repeat(15_000_000) // ~11MB decoded > 10MB cap
    const r = ChatRequestSchema.safeParse({
      ...base,
      sandboxFiles: [{ name: "x", fileId: "f", dataBase64: huge }],
    })
    expect(r.success).toBe(false)
  })
})

describe("ExtractTableRequestSchema.columnHints accepts the full type set", () => {
  const base = {
    reportText: "r",
    sources: [{ title: "t", url: "https://s.test", snippet: "s" }],
  }
  test("accepts link + date typed hints", () => {
    const r = ExtractTableRequestSchema.safeParse({
      ...base,
      columnHints: [
        { label: "Home page", type: "link" },
        { label: "Launched", type: "date" },
      ],
    })
    expect(r.success).toBe(true)
  })
  test("still accepts legacy string hints", () => {
    const r = ExtractTableRequestSchema.safeParse({ ...base, columnHints: ["Drug", "N"] })
    expect(r.success).toBe(true)
  })
  test("rejects an unknown type", () => {
    const r = ExtractTableRequestSchema.safeParse({
      ...base,
      columnHints: [{ label: "X", type: "banana" }],
    })
    expect(r.success).toBe(false)
  })
})

describe("TaskChildrenResponseSchema", () => {
  test("parses a valid children response", () => {
    const r = TaskChildrenResponseSchema.safeParse({
      children: [{ id: "x", status: "running", goal: "g" }],
    })
    expect(r.success).toBe(true)
  })

  test("rejects a child missing the status field", () => {
    const r = TaskChildrenResponseSchema.safeParse({
      children: [{ id: "x" }],
    })
    expect(r.success).toBe(false)
  })
})

describe("ChatRequestSchema.memoryBypass", () => {
  const base = { messages: [{ role: "user", content: "hi" }] }
  test("accepts memoryBypass true/false/absent", () => {
    expect(
      ChatRequestSchema.safeParse({ ...base, memoryBypass: true }).success
    ).toBe(true)
    expect(
      ChatRequestSchema.safeParse({ ...base, memoryBypass: false }).success
    ).toBe(true)
    expect(ChatRequestSchema.safeParse(base).success).toBe(true)
  })
  test("rejects a non-boolean memoryBypass", () => {
    expect(
      ChatRequestSchema.safeParse({ ...base, memoryBypass: "yes" }).success
    ).toBe(false)
  })
})
