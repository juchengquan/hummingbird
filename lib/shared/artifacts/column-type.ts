import { z } from "zod"

import type { CitationTableCell } from "./citation-table"

/** The set of column types shipped in slice 1. Slice 2 adds "link"
 *  and "date". */
export const COLUMN_TYPES = ["text", "number"] as const
export const ColumnTypeSchema = z.enum(COLUMN_TYPES)
export type ColumnType = (typeof COLUMN_TYPES)[number]

/** Resolve a column's effective type. Defaults to "text" when type
 *  is absent or unknown. Pure, never throws. */
export function resolveColumnType(col: { type?: string }): ColumnType {
  return (COLUMN_TYPES as readonly string[]).includes(col.type ?? "")
    ? (col.type as ColumnType)
    : "text"
}

/** Coerce a cell's string value to a sortable scalar for `type`.
 *  - "number" → Number.parseFloat(value), or NaN if not finite
 *  - "text" → raw string (passthrough)
 *  Empty string yields NaN for number and "" for text. Never throws. */
export function parseCellValue(value: string, type: ColumnType): number | string {
  if (type === "number") {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : NaN
  }
  return value
}

/** Return a warning message when the cell value doesn't fit the
 *  declared type, or null when it does. Returns null for empty /
 *  missing cells (no warning to show for an empty cell). */
export function validateCell(
  cell: CitationTableCell | undefined,
  type: ColumnType,
): string | null {
  if (!cell || cell.value === "") return null
  if (type === "number") {
    const n = Number.parseFloat(cell.value)
    if (Number.isFinite(n)) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a number: "${display}"`
  }
  return null
}

/** Type-aware comparator for sortRowOrder. NaN / empty sort last in
 *  BOTH directions (matches today's "empty cells sort last" rule).
 *  Stable for equal keys. "text" delegates to localeCompare. */
export function compareForSort(
  a: CitationTableCell | undefined,
  b: CitationTableCell | undefined,
  type: ColumnType,
  dir: "asc" | "desc",
): number {
  const sign = dir === "asc" ? 1 : -1
  const va = a?.value ?? ""
  const vb = b?.value ?? ""
  if (va === "" && vb === "") return 0
  if (va === "") return 1
  if (vb === "") return -1
  if (type === "number") {
    const na = Number.parseFloat(va)
    const nb = Number.parseFloat(vb)
    const aBad = !Number.isFinite(na)
    const bBad = !Number.isFinite(nb)
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return na === nb ? 0 : (na < nb ? -1 : 1) * sign
  }
  return va.localeCompare(vb) * sign
}
