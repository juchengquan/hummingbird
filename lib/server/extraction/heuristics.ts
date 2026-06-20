import "server-only"

import type { ExtractionResult } from "../extraction"

/** Below this ratio of (extracted text length / file bytes) a PDF is
 *  likely scanned or image-heavy — the text pass found little. */
const LOW_YIELD_RATIO = 0.01
/** A PDF needs at least this many lines before the table-density signal
 *  is meaningful (avoids firing on tiny files). */
const MIN_TABLE_LINES = 20
/** Fraction of lines that look columnar (≥2 internal whitespace runs)
 *  above which the doc is treated as table-dense. */
const TABLE_LINE_RATIO = 0.5
/** Inline + full text budgets. Intentionally duplicated from
 *  `extraction.ts` rather than imported: `extraction.ts` imports the
 *  pure helpers from this file, so importing the budget *values* back
 *  would create a runtime circular import (the `ExtractionResult` import
 *  above is type-only and erased, so it's safe). The heuristics test
 *  pins these exact values, so drift is caught. */
const EXTRACTION_BUDGET = 100 * 1024
const FULL_EXTRACTION_BUDGET = 1024 * 1024

/** A line is "columnar" when it has ≥2 runs of 2+ spaces between
 *  non-space content — the shape a table collapses into as plain text. */
function isColumnarLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  const gaps = trimmed.match(/\S {2,}\S/g)
  return (gaps?.length ?? 0) >= 2
}

/**
 * Decide whether to run the (expensive) vision extraction pass. Pure.
 * Only PDFs qualify; within PDFs, fire when text yield is low (scanned /
 * image-heavy) OR the text is table-dense (a table the text pass
 * flattened). Everything else → false.
 */
export function shouldUseVision(
  result: ExtractionResult,
  fileSizeBytes: number
): boolean {
  if (result.kind !== "pdf") return false
  const text = result.fullText ?? result.text

  // Low text yield → likely scanned / image PDF.
  if (fileSizeBytes > 0 && text.length / fileSizeBytes < LOW_YIELD_RATIO) {
    return true
  }

  // Table density.
  const lines = text.split("\n")
  if (lines.length >= MIN_TABLE_LINES) {
    const columnar = lines.filter(isColumnarLine).length
    if (columnar / lines.length >= TABLE_LINE_RATIO) return true
  }

  return false
}

/**
 * Merge vision-extracted markdown into an extraction result, replacing
 * `text` / `fullText` (respecting the same budgets as `extraction.ts`)
 * and preserving `kind`. Pure.
 */
export function mergeVisionText(
  base: ExtractionResult,
  visionMarkdown: string
): ExtractionResult {
  if (visionMarkdown.length <= EXTRACTION_BUDGET) {
    return { ...base, text: visionMarkdown, truncated: false, fullText: undefined }
  }
  const text = visionMarkdown.slice(0, EXTRACTION_BUDGET)
  const fullText =
    visionMarkdown.length <= FULL_EXTRACTION_BUDGET
      ? visionMarkdown
      : visionMarkdown.slice(0, FULL_EXTRACTION_BUDGET)
  return { ...base, text, truncated: true, fullText }
}
