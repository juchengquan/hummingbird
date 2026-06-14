import { z } from "zod"

import type { CitationTable } from "./citation-table"

export const ExtractionCitationSchema = z.object({
  /** 1-based index into the sources list the prompt presented. */
  source: z.number().int().min(1),
  quote: z.string().max(2000),
})

export const ExtractionCellSchema = z.object({
  /** Which column this cell fills — must match a `columns[].id`. */
  columnId: z.string().min(1).max(60),
  value: z.string().max(4000),
  citations: z.array(ExtractionCitationSchema).max(8).default([]),
})

export const ExtractionColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
})

export const ExtractionRowSchema = z.object({
  cells: z.array(ExtractionCellSchema).max(12),
})

/** What the model fills in. Rows are a CLOSED array of column-tagged cells
 *  (NOT an open `Record<colId, …>` — JSON-Schema `additionalProperties`
 *  isn't reliable under strict structured output). No `sources` (the
 *  prompt supplies them); cells cite by source NUMBER. */
export const ExtractionSchema = z.object({
  columns: z.array(ExtractionColumnSchema).min(1).max(12),
  rows: z.array(ExtractionRowSchema).max(200),
})
export type Extraction = z.infer<typeof ExtractionSchema>

type NumberedSource = { id: string; title: string; url?: string; snippet?: string }

/** Build the storage CitationTable from the model's extraction + the
 *  numbered sources (with stable ids). Maps each citation's 1-based
 *  `source` → `sources[source-1].id`; an out-of-range number drops that
 *  citation. Ignores a cell tagged with an undeclared column. Embeds
 *  `sources` so the artifact is self-contained. Never throws. */
export function extractionToCitationTable(
  extraction: Extraction,
  sources: NumberedSource[],
): CitationTable {
  const colIds = new Set(extraction.columns.map((c) => c.id))
  const rows = extraction.rows.map((row) => {
    const out: CitationTable["rows"][number] = {}
    for (const cell of row.cells) {
      if (!colIds.has(cell.columnId)) continue
      const citations = cell.citations
        .filter((c) => c.source >= 1 && c.source <= sources.length)
        .map((c) => ({ sourceId: sources[c.source - 1].id, quote: c.quote }))
      out[cell.columnId] = { value: cell.value, citations }
    }
    return out
  })
  const safeSources = sources.map((s) => ({
    id: s.id,
    title: (s.title || s.url || "Source").slice(0, 300),
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.snippet !== undefined ? { snippet: s.snippet.slice(0, 1000) } : {}),
  }))
  return { columns: extraction.columns, rows, sources: safeSources }
}

/** Pure prompt: the report body + a numbered sources list + optional
 *  column hints. The model cites cells by the source NUMBER shown here.
 *  When `hints` is non-empty, the prompt steers the model to use those
 *  column labels verbatim (and leaves cells empty rather than inventing
 *  a different column when the report doesn't support one). When
 *  `hints` is `undefined` or empty, the model is free to choose 3–6
 *  columns — identical to the pre-hints behavior (regression guard). */
export function buildExtractTablePrompt(
  reportText: string,
  sources: NumberedSource[],
  hints?: string[],
): string {
  const sourceLines = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}${s.url ? ` — ${s.url}` : ""}${s.snippet ? `\n    ${s.snippet}` : ""}`,
    )
    .join("\n")
  const hintBlock =
    hints && hints.length > 0
      ? [
          "",
          `Required columns (use these labels exactly): ${hints.map((h) => `\`${h}\``).join(", ")}.`,
          "If the report doesn't support one of these, leave that cell empty (do NOT invent a different column).",
        ].join("\n")
      : ""
  return [
    "You extract a structured comparison table from a research report.",
    "",
    "REPORT:",
    reportText,
    "",
    "SOURCES (cite by number):",
    sourceLines,
    "",
    hints && hints.length > 0
      ? `Build a table with EXACTLY these columns (one per hint, in the order given):`
      : "Build a table capturing the key comparable attributes across the entities the report discusses:",
    hints && hints.length > 0
      ? ""
      : "- Choose 3–6 columns (the comparable attributes). Each column has a short slug `id` and a human `label`.",
    "- One row per entity/item the report compares. Each row is a list of `cells`; each cell has the column's `columnId`, the extracted `value`, and `citations`.",
    "- Back each value with `citations` referencing the SOURCE NUMBER above plus the exact supporting quote. Only cite what the report/sources actually state; leave `citations` empty when a value isn't directly supported.",
    "- Keep values concise.",
    hintBlock,
  ]
    .filter((s) => s !== "")
    .join("\n")
}
