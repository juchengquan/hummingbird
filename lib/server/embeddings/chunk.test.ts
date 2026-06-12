import { describe, expect, test } from "bun:test"

import { chunkText } from "./chunk"

describe("chunkText", () => {
  test("empty / whitespace → []", () => {
    expect(chunkText("")).toEqual([])
    expect(chunkText("   \n\n  ")).toEqual([])
  })

  test("text within the cap → a single chunk (trimmed)", () => {
    expect(chunkText("  hello world  ", { maxChars: 50 })).toEqual([
      "hello world",
    ])
  })

  test("multi-paragraph text packs into overlapping windows under the cap", () => {
    const text = [
      "PARA1 " + "a".repeat(24),
      "PARA2 " + "b".repeat(24),
      "PARA3 " + "c".repeat(24),
    ].join("\n\n")
    const chunks = chunkText(text, { maxChars: 50, overlapChars: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk respects the cap.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50)
    // Every paragraph's marker survives somewhere.
    const joined = chunks.join(" || ")
    expect(joined).toContain("PARA1")
    expect(joined).toContain("PARA2")
    expect(joined).toContain("PARA3")
  })

  test("a single oversized paragraph is hard-split into overlapping windows", () => {
    const chunks = chunkText("x".repeat(120), { maxChars: 50, overlapChars: 10 })
    expect(chunks.length).toBe(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50)
    // Overlap: consecutive windows share their boundary region.
    expect(chunks[0].slice(-10)).toBe(chunks[1].slice(0, 10))
  })

  test("no duplicate adjacent chunks from the overlap seed", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Section ${i} ` + "z".repeat(40)).join("\n\n")
    const chunks = chunkText(text, { maxChars: 60, overlapChars: 15 })
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]).not.toBe(chunks[i - 1])
    }
  })
})
