import { z } from "zod"

import type { ColumnType } from "./column-type"
import { compareForSort } from "./column-type"

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
  /** Slice 1: "text" | "number". Absent = "text". Slice 2 extends
   *  the union with "link" | "date". Existing un-typed blobs
   *  validate unchanged. */
  type: z.enum(["text", "number"]).optional(),
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
export type Citation = z.infer<typeof CitationSchema>

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

/** Display order (array of original row indices) when sorting by
 *  `columnId`. Numeric-aware: when both cell values parse as finite
 *  numbers, compare numerically; otherwise `localeCompare`. Empty /
 *  missing cells sort last in BOTH directions. Stable for equal keys
 *  (preserves original order). Does NOT mutate `data`. */
export function sortRowOrder(
  data: CitationTable,
  columnId: string,
  dir: "asc" | "desc",
  type: ColumnType = "text",
): number[] {
  return data.rows
    .map((_, i) => i)
    .sort((a, b) =>
      compareForSort(data.rows[a]?.[columnId], data.rows[b]?.[columnId], type, dir),
    )
}

/** Return a NEW CitationTable with `rows[rowIndex][columnId].value`
 *  replaced by `value` (the cell's citations are preserved; an absent
 *  cell is created with empty citations). Out-of-range `rowIndex`
 *  returns `data` unchanged. Pure — never mutates the input. */
export function setCellValue(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  value: string,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const rows = data.rows.map((row, i) => {
    if (i !== rowIndex) return row
    const existing = row[columnId]
    return { ...row, [columnId]: { value, citations: existing?.citations ?? [] } }
  })
  return { ...data, rows }
}

/** Return a NEW CitationTable with one empty row appended. The new
 *  row has no column entries at all — the renderer tolerates missing
 *  columnIds by rendering an em-dash. Capped at 200 rows (matches
 *  the schema); returns `data` unchanged when at cap. Pure; never
 *  mutates the input. */
export function addRow(data: CitationTable): CitationTable {
  if (data.rows.length >= 200) return data
  return { ...data, rows: [...data.rows, {}] }
}

/** Return a NEW CitationTable with one new column appended. `label` is
 *  the human label (≤120 chars); `columnId` is the slug (≤60 chars).
 *  The `columnId` must not collide with an existing column id —
 *  returns `data` unchanged on collision. Capped at 12 columns
 *  (matches the schema); returns `data` unchanged when at cap. Pure;
 *  never mutates the input. */
export function addColumn(
  data: CitationTable,
  label: string,
  columnId: string,
  type: ColumnType = "text",
): CitationTable {
  if (data.columns.length >= 12) return data
  if (data.columns.some((c) => c.id === columnId)) return data
  const newColumn: CitationTable["columns"][number] = { id: columnId, label }
  if (type !== "text") newColumn.type = type
  return { ...data, columns: [...data.columns, newColumn] }
}

/** Return a NEW CitationTable with `rows[rowIndex]` removed. Out-of-range
 *  `rowIndex` (negative or `>= data.rows.length`) returns `data`
 *  unchanged. Pure; never mutates the input. */
export function removeRow(data: CitationTable, rowIndex: number): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  return { ...data, rows: data.rows.filter((_, i) => i !== rowIndex) }
}

/** Return a NEW CitationTable with the column at `columnId` and every
 *  cell tagged with that column id removed. Unknown `columnId`
 *  returns `data` unchanged. Pure; never mutates the input. */
export function removeColumn(data: CitationTable, columnId: string): CitationTable {
  if (!data.columns.some((c) => c.id === columnId)) return data
  return {
    ...data,
    columns: data.columns.filter((c) => c.id !== columnId),
    rows: data.rows.map((row) => {
      if (!(columnId in row)) return row
      const { [columnId]: _removed, ...rest } = row
      void _removed
      return rest
    }),
  }
}

/** Return a NEW CitationTable with `citation` appended to
 *  `rows[rowIndex][columnId].citations`. Creates the cell
 *  (`{ value: "", citations: [citation] }`) when absent. Capped at 8
 *  citations per cell (returns `data` unchanged at cap). Out-of-range
 *  `rowIndex` returns `data` unchanged. Pure; never mutates the input. */
export function addCitation(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  citation: Citation,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const existing = data.rows[rowIndex]?.[columnId]
  const citations = existing?.citations ?? []
  if (citations.length >= 8) return data
  const rows = data.rows.map((row, i) =>
    i === rowIndex
      ? { ...row, [columnId]: { value: existing?.value ?? "", citations: [...citations, citation] } }
      : row,
  )
  return { ...data, rows }
}

/** Return a NEW CitationTable with the citation at `citIndex` of
 *  `rows[rowIndex][columnId]` patched (`sourceId` and/or `quote`).
 *  Missing cell, empty citations, or out-of-range `citIndex` returns
 *  `data` unchanged. Out-of-range `rowIndex` returns `data` unchanged.
 *  Pure; never mutates the input. */
export function updateCitation(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  citIndex: number,
  patch: Partial<Citation>,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const cell = data.rows[rowIndex]?.[columnId]
  if (!cell || citIndex < 0 || citIndex >= cell.citations.length) return data
  const citations = cell.citations.map((c, i) => (i === citIndex ? { ...c, ...patch } : c))
  const rows = data.rows.map((row, i) =>
    i === rowIndex ? { ...row, [columnId]: { ...cell, citations } } : row,
  )
  return { ...data, rows }
}

/** Return a NEW CitationTable with the citation at `citIndex` of
 *  `rows[rowIndex][columnId]` removed. Missing cell or out-of-range
 *  `citIndex` returns `data` unchanged. Out-of-range `rowIndex` returns
 *  `data` unchanged. Pure; never mutates the input. */
export function removeCitation(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  citIndex: number,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const cell = data.rows[rowIndex]?.[columnId]
  if (!cell || citIndex < 0 || citIndex >= cell.citations.length) return data
  const citations = cell.citations.filter((_, i) => i !== citIndex)
  const rows = data.rows.map((row, i) =>
    i === rowIndex ? { ...row, [columnId]: { ...cell, citations } } : row,
  )
  return { ...data, rows }
}

/** Return a NEW CitationTable with the column at `fromIndex` moved to
 *  `toIndex` (spliced out, then spliced back in at `toIndex`), shifting
 *  the others. Out-of-range `fromIndex`/`toIndex` or
 *  `fromIndex === toIndex` returns `data` unchanged. Rows are untouched
 *  — cells are keyed by columnId, so they follow the new column order.
 *  Pure; never mutates the input. */
export function moveColumn(
  data: CitationTable,
  fromIndex: number,
  toIndex: number,
): CitationTable {
  const n = data.columns.length
  if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n) return data
  if (fromIndex === toIndex) return data
  const cols = [...data.columns]
  const [moved] = cols.splice(fromIndex, 1)
  cols.splice(toIndex, 0, moved)
  return { ...data, columns: cols }
}
