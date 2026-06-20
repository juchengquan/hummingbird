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

describe("chunkText — markdown tables", () => {
  const HEADER = "| Name | Score |"
  const SEP = "|------|-------|"
  function table(rows: string[]): string {
    return [HEADER, SEP, ...rows].join("\n")
  }
  const ROWS = [
    "| Alice | 100 |",
    "| Bob | 95 |",
    "| Carol | 88 |",
    "| Dave | 77 |",
    "| Eve | 66 |",
    "| Frank | 55 |",
  ]

  test("oversized table splits at row boundaries, header repeated, each ≤ maxChars", () => {
    const chunks = chunkText(table(ROWS), { maxChars: 60, overlapChars: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.startsWith(HEADER + "\n" + SEP)).toBe(true)
      expect(c.length).toBeLessThanOrEqual(60)
      for (const line of c.split("\n")) {
        if (line.trim() === "") continue
        expect(line.startsWith("|") && line.endsWith("|")).toBe(true)
      }
    }
    const joined = chunks.join("\n")
    for (const r of ROWS) expect(joined).toContain(r)
  })

  test("table that fits → single unmodified chunk", () => {
    const t = table(["| Alice | 100 |", "| Bob | 95 |"])
    expect(chunkText(t, { maxChars: 1000 })).toEqual([t])
  })

  test("prose with pipes but no separator row is NOT treated as a table", () => {
    const prose =
      "Intro | with | pipes that goes on.\n" +
      "Second | line | also has pipes but no separator.\n" +
      "x".repeat(200)
    const chunks = chunkText(prose, { maxChars: 80, overlapChars: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[1].startsWith("Intro | with | pipes")).toBe(false)
  })

  test("degenerate: header+first row wider than maxChars → splitLong fallback, no hang", () => {
    const wide = ["| AAAAAAAAAA | BBBBBBBBBB |", "|------------|------------|", "| 1 | 2 |"].join(
      "\n"
    )
    const chunks = chunkText(wide, { maxChars: 20, overlapChars: 5 })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    if (chunks.length > 1) {
      expect(chunks[1].startsWith("| AAAAAAAAAA | BBBBBBBBBB |")).toBe(false)
    }
  })

  test("non-table oversized paragraph unchanged (regression: splitLong)", () => {
    const prose = "word ".repeat(100).trim()
    const chunks = chunkText(prose, { maxChars: 100, overlapChars: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(prose.startsWith(chunks[0])).toBe(true)
  })
})
