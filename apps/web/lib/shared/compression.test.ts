import { describe, expect, test } from "bun:test"
import type { Message } from "@/shared/types"
import {
  buildCompressedMessages,
  pickCompressionRange,
  priorRecapsBefore,
  MIN_MESSAGES_TO_COMPRESS,
} from "./compression"

function msg(
  i: number,
  overrides: Partial<Message> = {}
): Message {
  return {
    id: `m-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    timestamp: new Date(2026, 0, 1, 0, i),
    ...overrides,
  }
}

describe("pickCompressionRange", () => {
  test("returns null when there are too few eligible messages", () => {
    const messages = Array.from({ length: 3 }, (_, i) => msg(i))
    expect(pickCompressionRange(messages)).toBeNull()
  })

  test("compresses the oldest 60% of a 10-message conversation", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg(i))
    const result = pickCompressionRange(messages)
    expect(result).not.toBeNull()
    expect(result!.toCompress).toHaveLength(6)
    expect(result!.retainedCount).toBe(4)
    expect(result!.toCompress[0].id).toBe("m-0")
    expect(result!.toCompress[5].id).toBe("m-5")
  })

  test("excludes already-compressed messages from eligible pool", () => {
    const messages: Message[] = [
      msg(0, { compressed: true }),
      msg(1, { compressed: true }),
      msg(2, { compressed: true }),
      msg(3, { compressed: true }),
      ...Array.from({ length: 5 }, (_, i) => msg(i + 4)),
    ]
    const result = pickCompressionRange(messages)
    // 5 eligible (the non-compressed). 5 < MIN*2 (4), so 5 is the
    // borderline case — actually 5 >= 4, so eligible. cut = max(2, floor(5*0.6))
    // = max(2, 3) = 3. So 3 to compress, 2 retained.
    expect(result).not.toBeNull()
    expect(result!.toCompress).toHaveLength(3)
    expect(result!.toCompress[0].id).toBe("m-4")
  })

  test("excludes existing recap messages", () => {
    const messages: Message[] = [
      msg(0, { kind: "recap", content: "(recap)" }),
      ...Array.from({ length: 6 }, (_, i) => msg(i + 1)),
    ]
    const result = pickCompressionRange(messages)
    // 6 eligible. cut = max(2, 3) = 3. 3 compress, 3 retained.
    expect(result).not.toBeNull()
    expect(result!.toCompress).toHaveLength(3)
    expect(result!.toCompress[0].id).toBe("m-1")
    // Recap shouldn't appear in the compress slice.
    expect(result!.toCompress.every((m) => m.kind !== "recap")).toBe(true)
  })

  test("excludes error messages", () => {
    const messages: Message[] = [
      ...Array.from({ length: 4 }, (_, i) => msg(i)),
      msg(4, { error: { code: "provider", detail: "boom" } }),
      ...Array.from({ length: 4 }, (_, i) => msg(i + 5)),
    ]
    const result = pickCompressionRange(messages)
    // 8 eligible (the error one drops out). cut = max(2, floor(8*0.6))
    // = max(2, 4) = 4. So 4 compress, 4 retained. Error message
    // shouldn't be in the compress slice.
    expect(result).not.toBeNull()
    expect(result!.toCompress).toHaveLength(4)
    expect(result!.toCompress.every((m) => !m.error)).toBe(true)
  })

  test("excludes empty messages", () => {
    const messages: Message[] = [
      ...Array.from({ length: 3 }, (_, i) => msg(i)),
      msg(3, { content: "" }),
      ...Array.from({ length: 4 }, (_, i) => msg(i + 4)),
    ]
    const result = pickCompressionRange(messages)
    // 7 eligible. cut = max(2, floor(7*0.6)) = max(2, 4) = 4.
    expect(result).not.toBeNull()
    expect(result!.toCompress).toHaveLength(4)
    expect(result!.toCompress.every((m) => m.content !== "")).toBe(true)
  })

  test("requires at least MIN_MESSAGES_TO_COMPRESS in the compress slice", () => {
    // 4 eligible -> 4 >= MIN*2 boundary -> cut = max(2, floor(4*0.6))
    // = max(2, 2) = 2. 2 compress, 2 retained. Returns non-null.
    const messages = Array.from({ length: 4 }, (_, i) => msg(i))
    const result = pickCompressionRange(messages)
    expect(result).not.toBeNull()
    expect(result!.toCompress.length).toBeGreaterThanOrEqual(
      MIN_MESSAGES_TO_COMPRESS
    )
  })
})

describe("priorRecapsBefore", () => {
  test("returns recaps positioned before the anchor", () => {
    const messages = [
      msg(0, { kind: "recap", content: "R0", recapMessageIds: ["x"] }),
      msg(1, { compressed: true }),
      msg(2),
      msg(3),
    ]
    expect(priorRecapsBefore(messages, "m-2").map((m) => m.id)).toEqual([
      "m-0",
    ])
  })

  test("no recap before the anchor → empty", () => {
    expect(priorRecapsBefore([msg(0), msg(1, { kind: "recap" })], "m-0")).toEqual(
      []
    )
  })

  test("unknown anchor id → empty", () => {
    expect(priorRecapsBefore([msg(0)], "nope")).toEqual([])
  })
})

describe("buildCompressedMessages", () => {
  const NOW = new Date(2026, 0, 2)

  test("first compress: inserts recap, flags the slice, no inheritance", () => {
    const messages = Array.from({ length: 6 }, (_, i) => msg(i))
    const r = buildCompressedMessages(
      messages,
      ["m-0", "m-1", "m-2"],
      "recap-1",
      "RECAP BODY",
      NOW
    )
    expect(r).not.toBeNull()
    const out = r!.messages
    expect(out[0].id).toBe("recap-1")
    expect(out[0].kind).toBe("recap")
    expect(r!.recap.recapMessageIds).toEqual(["m-0", "m-1", "m-2"])
    expect(out.slice(1, 4).every((m) => m.compressed)).toBe(true)
    expect(out.slice(4).every((m) => !m.compressed)).toBe(true)
    expect(out).toHaveLength(messages.length + 1)
  })

  test("re-compress fold: drops the prior recap and inherits its ids", () => {
    const messages: Message[] = [
      msg(100, {
        kind: "recap",
        content: "R1",
        recapMessageIds: ["m-0", "m-1", "m-2"],
      }),
      msg(0, { compressed: true }),
      msg(1, { compressed: true }),
      msg(2, { compressed: true }),
      msg(3),
      msg(4),
      msg(5),
    ]
    const r = buildCompressedMessages(
      messages,
      ["m-3", "m-4"],
      "recap-2",
      "MERGED RECAP",
      NOW
    )
    expect(r).not.toBeNull()
    const out = r!.messages
    expect(out.some((m) => m.id === "m-100")).toBe(false)
    expect(out.filter((m) => m.kind === "recap")).toHaveLength(1)
    expect(r!.recap.recapMessageIds).toEqual([
      "m-0",
      "m-1",
      "m-2",
      "m-3",
      "m-4",
    ])
    expect(out.find((m) => m.id === "m-0")!.compressed).toBe(true)
    expect(out.find((m) => m.id === "m-3")!.compressed).toBe(true)
    expect(out.find((m) => m.id === "m-5")!.compressed).toBeFalsy()
  })

  test("stale ids (none present) → null", () => {
    expect(buildCompressedMessages([msg(0)], ["nope"], "r", "x", NOW)).toBeNull()
  })
})
