import { z } from "zod"

import type { CitationTableCell } from "./citation-table"

/** The full Core column-type set. Slice 1 shipped text + number;
 *  slice 2 adds link + date. */
export const COLUMN_TYPES = ["text", "number", "link", "date"] as const
export const ColumnTypeSchema = z.enum(COLUMN_TYPES)
export type ColumnType = (typeof COLUMN_TYPES)[number]

/** Human labels for the type picker / radios / chips. */
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  text: "Text",
  number: "Number",
  link: "Link",
  date: "Date",
}

/** Short glyphs for the inline type pills. */
export const COLUMN_TYPE_GLYPHS: Record<ColumnType, string> = {
  text: "Aa",
  number: "#",
  link: "↗",
  date: "🗓",
}

/** Resolve a column's effective type. Defaults to "text" when type
 *  is absent or unknown. Pure, never throws. */
export function resolveColumnType(col: { type?: string }): ColumnType {
  return (COLUMN_TYPES as readonly string[]).includes(col.type ?? "")
    ? (col.type as ColumnType)
    : "text"
}

/** Strict ISO date parser. Accepts only `YYYY-MM-DD` that is also a
 *  real calendar date (rejects 2024-13-40, 2024-02-30). Returns a
 *  UTC-midnight timestamp (ms) or null. Never throws. */
function parseIsoDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const ts = Date.UTC(year, month - 1, day)
  const dt = new Date(ts)
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null
  }
  return ts
}

/** True only for `http://` / `https://` URLs. Never throws. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
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
  if (type === "date") {
    return parseIsoDate(value) ?? NaN
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
  if (type === "date") {
    if (parseIsoDate(cell.value) !== null) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a date: "${display}"`
  }
  if (type === "link") {
    if (isHttpUrl(cell.value)) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a URL: "${display}"`
  }
  return null
}

/** Type-aware comparator for sortRowOrder. NaN / empty sort last in
 *  BOTH directions (matches today's "empty cells sort last" rule).
 *  Stable for equal keys. "text" preserves the historical
 *  numeric-sniff behavior (try numeric first, fall back to
 *  localeCompare) — this is the behavior un-typed columns have
 *  always had, so opting a column OUT of the sniff requires an
 *  explicit `type: "number"`. "number" is strict numeric (NaN /
 *  bad input sorts last). */
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
  if (type === "date") {
    const ta = parseIsoDate(va)
    const tb = parseIsoDate(vb)
    const aBad = ta === null
    const bBad = tb === null
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return ta === tb ? 0 : (ta < tb ? -1 : 1) * sign
  }
  if (type === "link") {
    return va.localeCompare(vb) * sign
  }
  // type === "text": preserve the historical numeric-sniff behavior.
  // Both finite → numeric. Otherwise localeCompare. Stable for equal
  // keys via the outer sort.
  const na = Number.parseFloat(va)
  const nb = Number.parseFloat(vb)
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb ? 0 : (na < nb ? -1 : 1) * sign
  }
  return va.localeCompare(vb) * sign
}
