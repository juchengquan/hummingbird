import { z } from "zod"

export const CitationSchema = z.object({
  sourceId: z.string().min(1),
  quote: z.string().max(2000),
})

export const CellSchema = z.object({
  value: z.string().max(4000),
  /** Quote-cited support for this cell's value. May be empty (an
   *  un-cited cell is allowed; the renderer just shows no chip). */
  citations: z.array(CitationSchema).max(8).default([]),
})

export const CitationTableSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  url: z.string().max(2000).optional(),
  snippet: z.string().max(1000).optional(),
})

export const CitationTableColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
})

export const CitationTableSchema = z.object({
  columns: z.array(CitationTableColumnSchema).min(1).max(12),
  /** One row = a map of columnId → cell. A column with no entry in a
   *  row renders as an empty cell. */
  rows: z.array(z.record(z.string(), CellSchema)).max(200),
  sources: z.array(CitationTableSourceSchema).max(100),
})

export type CitationTable = z.infer<typeof CitationTableSchema>
export type CitationTableCell = z.infer<typeof CellSchema>

/** Parse an artifact's `content` string into a CitationTable, or null
 *  when it isn't valid citation-table JSON (bad JSON or shape). The
 *  Artifacts-tab dispatch falls back to the plain `<pre>` view on null.
 *  Never throws. A citation whose `sourceId` isn't in `sources` is
 *  tolerated — the renderer resolves leniently. */
export function parseCitationTable(content: string): CitationTable | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const result = CitationTableSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** 1-based index of `sourceId` in `data.sources`, or null when absent.
 *  Used by the renderer to number citation chips. */
export function sourceIndex(data: CitationTable, sourceId: string): number | null {
  const i = data.sources.findIndex((s) => s.id === sourceId)
  return i === -1 ? null : i + 1
}
