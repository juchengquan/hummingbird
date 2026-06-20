import { describe, expect, test } from "bun:test"

import type { ExtractionResult } from "../extraction"
import { mergeVisionText, shouldUseVision } from "./heuristics"

function pdfResult(text: string): ExtractionResult {
  return { kind: "pdf", text, truncated: false }
}

describe("shouldUseVision", () => {
  test("scanned/low-yield PDF (little text for its size) → true", () => {
    // 50 bytes of text from a 200 KB file → very low yield.
    expect(shouldUseVision(pdfResult("x".repeat(50)), 200 * 1024)).toBe(true)
  })

  test("table-dense PDF (many columnar lines) → true", () => {
    const lines = Array.from({ length: 40 }, () => "A   1   2   3").join("\n")
    expect(shouldUseVision(pdfResult(lines), 4 * 1024)).toBe(true)
  })

  test("clean prose PDF → false", () => {
    const prose = "This is a normal paragraph of prose. ".repeat(200)
    expect(shouldUseVision(pdfResult(prose), 8 * 1024)).toBe(false)
  })

  test("non-PDF kinds → false", () => {
    expect(shouldUseVision({ kind: "markdown", text: "x", truncated: false }, 10)).toBe(false)
    expect(shouldUseVision({ kind: "csv", text: "a,b", truncated: false }, 10)).toBe(false)
    expect(shouldUseVision({ kind: "image", text: "", truncated: false }, 10)).toBe(false)
  })
})

describe("mergeVisionText", () => {
  test("vision markdown replaces text/fullText, kind preserved", () => {
    const base = pdfResult("flattened text")
    const merged = mergeVisionText(base, "# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |")
    expect(merged.kind).toBe("pdf")
    expect(merged.text).toContain("| A | B |")
    expect(merged.text).not.toBe("flattened text")
  })

  test("over-budget vision markdown is truncated into text + fullText", () => {
    const big = "y".repeat(2 * 1024 * 1024) // 2 MB > FULL_EXTRACTION_BUDGET
    const merged = mergeVisionText(pdfResult("small"), big)
    expect(merged.truncated).toBe(true)
    expect(merged.text.length).toBe(100 * 1024) // EXTRACTION_BUDGET
    expect(merged.fullText?.length).toBe(1024 * 1024) // FULL_EXTRACTION_BUDGET
  })
})
