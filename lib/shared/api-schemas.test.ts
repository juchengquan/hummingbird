import { describe, expect, test } from "bun:test"

import {
  AiCommandRequestSchema,
  CHAT_MESSAGES_MAX,
  ChatRequestSchema,
  COMPLETE_BLOCK_MAX,
  COMPLETE_PREFIX_MAX,
  CompleteRequestSchema,
  ExtractTableRequestSchema,
  RefreshFileUrlRequestSchema,
  RefreshImageUrlRequestSchema,
  SANDBOX_FILE_BASE64_MAX,
  SANDBOX_FILES_TOTAL_BASE64_MAX,
  TaskChildrenResponseSchema,
  TaskRequestSchema,
} from "./api-schemas"
import { FILE_SIZE_LIMIT } from "./upload-config"

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

describe("ChatRequestSchema bounds", () => {
  const msg = { role: "user", content: "hi" }
  test("accepts a long-but-real history; rejects one over CHAT_MESSAGES_MAX", () => {
    const at = Array.from({ length: CHAT_MESSAGES_MAX }, () => msg)
    expect(ChatRequestSchema.safeParse({ messages: at }).success).toBe(true)
    expect(
      ChatRequestSchema.safeParse({ messages: [...at, msg] }).success
    ).toBe(false)
    expect(
      TaskRequestSchema.safeParse({ messages: [...at, msg], conversationId: "c" })
        .success
    ).toBe(false)
  })

  test("per-file cap matches the client's 10 MB local-file cap", () => {
    // A 10,000,000-byte file encodes to exactly SANDBOX_FILE_BASE64_MAX chars.
    expect(SANDBOX_FILE_BASE64_MAX).toBe(
      Buffer.alloc(10_000_000).toString("base64").length
    )
  })

  test("accepts 10 local files at the upload cap (the client's real maximum)", () => {
    const b64 = "A".repeat(Math.ceil(FILE_SIZE_LIMIT / 3) * 4)
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      fileId: `id${i}`,
      dataBase64: b64,
    }))
    expect(
      ChatRequestSchema.safeParse({ messages: [msg], sandboxFiles: files }).success
    ).toBe(true)
  })

  test("rejects a manifest whose total inline data exceeds the cap", () => {
    // Each entry is under the per-file cap, but 10 of them blow the total.
    const each = Math.floor(SANDBOX_FILES_TOTAL_BASE64_MAX / 10) + 4
    expect(each).toBeLessThanOrEqual(SANDBOX_FILE_BASE64_MAX)
    const files = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      fileId: `id${i}`,
      dataBase64: "A".repeat(each),
    }))
    expect(
      ChatRequestSchema.safeParse({ messages: [msg], sandboxFiles: files }).success
    ).toBe(false)
  })
})

describe("AiCommandRequestSchema", () => {
  // Shape the AI SDK DefaultChatTransport + Plate's AIChatPlugin send.
  const valid = {
    id: "editor",
    trigger: "submit-message",
    apiKey: "",
    ctx: {
      children: [{ type: "p", id: "b1", children: [{ text: "Hello" }] }],
      selection: {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 5 },
      },
      toolName: "edit",
    },
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "Make it formal" }],
        metadata: {},
      },
    ],
  }

  test("accepts the real client payload (and null selection / absent toolName)", () => {
    expect(AiCommandRequestSchema.safeParse(valid).success).toBe(true)
    expect(
      AiCommandRequestSchema.safeParse({
        ...valid,
        ctx: { ...valid.ctx, selection: null, toolName: undefined },
      }).success
    ).toBe(true)
  })

  test("rejects a missing ctx (previously a TypeError → 500)", () => {
    const { ctx: _ctx, ...noCtx } = valid
    expect(AiCommandRequestSchema.safeParse(noCtx).success).toBe(false)
  })

  test("rejects non-array children, bad selection and unknown toolName", () => {
    for (const ctx of [
      { ...valid.ctx, children: "nope" },
      { ...valid.ctx, selection: { anchor: { path: "x", offset: 0 } } },
      { ...valid.ctx, toolName: "delete-everything" },
    ]) {
      expect(AiCommandRequestSchema.safeParse({ ...valid, ctx }).success).toBe(false)
    }
  })

  test("rejects messages without parts, empty messages, non-string model", () => {
    expect(
      AiCommandRequestSchema.safeParse({ ...valid, messages: [{ role: "user" }] })
        .success
    ).toBe(false)
    expect(AiCommandRequestSchema.safeParse({ ...valid, messages: [] }).success).toBe(
      false
    )
    expect(AiCommandRequestSchema.safeParse({ ...valid, model: 42 }).success).toBe(false)
  })
})
