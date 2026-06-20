import "server-only"

import { RESULT_CAP, STDOUT_CAP, TABLE_CELL_MAX, TABLE_MAX_COLS, TABLE_MAX_ROWS } from "./config"
import type { CodeResult, CodeRunResult } from "./types"

/** The shape the microsandbox client hands the pure mapper. */
export interface RawRun {
  stdout: string
  stderr: string
  exitCode: number
  images: { format: "png" | "svg"; data: string }[]
  timedOut: boolean
  /** Set when the runtime itself failed to boot/exec (not the user code). */
  upstreamError?: string
  /** Raw JSON values parsed from /tmp/*.table.json (PR-3). Interpreted
   *  + capped here so the client stays parse-only. */
  tables?: unknown[]
}

function truncate(s: string): string {
  if (s.length <= STDOUT_CAP) return s
  return `${s.slice(0, STDOUT_CAP)}\n…[truncated ${s.length - STDOUT_CAP} chars]`
}

function cellToString(v: unknown): string {
  if (typeof v === "string") return v
  if (v === null || v === undefined) return ""
  if (typeof v === "object") {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/** Normalize a parsed /tmp/*.table.json value into a string table, or
 *  null if it isn't a recognizable table. Accepts `{columns, rows}` and
 *  pandas `orient="split"` `{columns, data, index?}`. Pure. */
export function normalizeTable(parsed: unknown): { columns: string[]; rows: string[][] } | null {
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.columns)) return null
  const rowsRaw = Array.isArray(obj.rows) ? obj.rows : Array.isArray(obj.data) ? obj.data : null
  if (!rowsRaw) return null
  const columns = obj.columns.map(cellToString)
  const rows = rowsRaw.map((row) =>
    Array.isArray(row) ? row.map(cellToString) : [cellToString(row)],
  )
  return { columns, rows }
}

/** Apply the col/row/cell caps; returns the (possibly clipped) table and
 *  whether anything was truncated. */
function capTable(t: { columns: string[]; rows: string[][] }): {
  table: { columns: string[]; rows: string[][] }
  truncated: boolean
} {
  let truncated = false
  let columns = t.columns
  if (columns.length > TABLE_MAX_COLS) {
    columns = columns.slice(0, TABLE_MAX_COLS)
    truncated = true
  }
  let rows = t.rows
  if (rows.length > TABLE_MAX_ROWS) {
    rows = rows.slice(0, TABLE_MAX_ROWS)
    truncated = true
  }
  rows = rows.map((row) => {
    const clipped = row.slice(0, columns.length).map((c) => {
      if (c.length > TABLE_CELL_MAX) {
        truncated = true
        return `${c.slice(0, TABLE_CELL_MAX)}…`
      }
      return c
    })
    return clipped
  })
  return { table: { columns, rows }, truncated }
}

/** Approx serialized size of a table = sum of header + cell string lengths.
 *  Used to charge tables against the shared RESULT_CAP budget. */
function tableBytes(t: { columns: string[]; rows: string[][] }): number {
  let n = 0
  for (const c of t.columns) n += c.length
  for (const row of t.rows) for (const cell of row) n += cell.length
  return n
}

export function toCodeRunResult(raw: RawRun): CodeRunResult {
  const stdout = truncate(raw.stdout)
  const stderr = truncate(raw.stderr)

  const results: CodeResult[] = []
  // Bound the TOTAL result payload (text + images + tables) by RESULT_CAP —
  // not just images — so a large table or stdout can't blow the response /
  // persisted-store budget. Whole items that don't fit are dropped (never a
  // partial blob); each drop is noted so the model knows output was elided.
  let used = 0

  // Text (stdout) first: the primary output, already STDOUT_CAP-bounded.
  if (stdout) {
    used += stdout.length
    results.push({ type: "text", value: stdout })
  }

  for (const img of raw.images) {
    if (used + img.data.length > RESULT_CAP) continue
    used += img.data.length
    results.push({ type: "image", format: img.format, data: img.data })
  }

  let tablesTruncated = false
  let tablesDropped = false
  for (const rawTable of raw.tables ?? []) {
    const norm = normalizeTable(rawTable)
    if (!norm) continue
    const { table, truncated } = capTable(norm)
    if (truncated) tablesTruncated = true
    if (used + tableBytes(table) > RESULT_CAP) {
      tablesDropped = true
      continue
    }
    used += tableBytes(table)
    results.push({ type: "table", columns: table.columns, rows: table.rows })
  }
  if (tablesTruncated) {
    results.push({ type: "text", value: "⚠ A returned table was truncated to fit display limits." })
  }
  if (tablesDropped) {
    results.push({ type: "text", value: "⚠ A returned table was dropped to stay within the result size limit." })
  }

  if (raw.upstreamError !== undefined) {
    return { ok: false, stdout, stderr, results, error: { code: "upstream", message: raw.upstreamError } }
  }
  if (raw.timedOut) {
    return { ok: false, stdout, stderr, results, error: { code: "timeout", message: "Execution exceeded the time limit." } }
  }
  if (raw.exitCode !== 0) {
    return { ok: false, stdout, stderr, results, error: { code: "runtime", message: stderr || `Exited with code ${raw.exitCode}.` } }
  }
  return { ok: true, stdout, stderr, results }
}
