import "server-only"

import type { RateLimitVerdict } from "@/server/rate-limit"

import { shouldUseVision, mergeVisionText } from "./extraction/heuristics"
import { resolveVisionModel } from "./extraction/vision-model"
import { extractWithVision as defaultExtractWithVision } from "./extraction/vision"
import { assertZipWithinLimits, looksLikeZip } from "./extraction/zip-guard"

/**
 * File extraction — pure server-side library, lifted from
 * `app/api/extract/route.ts`'s original body. Same NPM packages
 * (dynamic-imported so they never touch the main bundle), same
 * per-format budgets, same kind taxonomy.
 *
 * Two consumers:
 *   1. `app/api/extract/route.ts` — the Next.js multipart/form-data
 *      endpoint; calls `extractFile()` after parsing the form.
 *   2. `services/agent-ts/src/routes/extract.ts` — the Hono mirror
 *      endpoint on `services/agent-ts/`; same call, same response
 *      shape (matches `ExtractionResponseSchema` on the wire).
 *
 * Lifting this out closes TS follow-up #3 in
 * `docs/PLAN-agent-ts-followups.md` — the duplicated copy in
 * `services/agent-ts/src/extraction.ts` is now deleted in favour
 * of this single source of truth.
 */

const EXTRACTION_BUDGET = 100 * 1024
const CODE_BUDGET = 128 * 1024
const FULL_EXTRACTION_BUDGET = 1024 * 1024

export type ExtractionKind =
  | "pdf"
  | "docx"
  | "markdown"
  | "csv"
  | "json"
  | "text"
  | "image"
  | "html"
  | "code"
  | "spreadsheet"
  | "unsupported"

export interface ExtractionResult {
  kind: ExtractionKind
  text: string
  truncated: boolean
  /** Detected source language for `code` kind (e.g. 'tsx', 'python'). */
  language?: string
  /** Full extracted text (capped at FULL_EXTRACTION_BUDGET). Only set
   *  when distinct from `text`. */
  fullText?: string
}

interface ExtractedBlock {
  text: string
  truncated: boolean
  fullText?: string
}

function truncateTo(raw: string, budget: number): ExtractedBlock {
  if (raw.length <= budget) {
    return { text: raw, truncated: false }
  }
  const text = raw.slice(0, budget)
  const fullText =
    raw.length <= FULL_EXTRACTION_BUDGET ? raw : raw.slice(0, FULL_EXTRACTION_BUDGET)
  return { text, truncated: true, fullText }
}

function truncate(raw: string): ExtractedBlock {
  return truncateTo(raw, EXTRACTION_BUDGET)
}

const CODE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".sh": "shell",
  ".bash": "shell",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
}

function codeLanguageFor(name: string): string | null {
  const lower = name.toLowerCase()
  for (const ext of Object.keys(CODE_EXTENSIONS)) {
    if (lower.endsWith(ext)) return CODE_EXTENSIONS[ext] ?? null
  }
  return null
}

function hasName(name: string, ...suffixes: string[]): boolean {
  const lower = name.toLowerCase()
  return suffixes.some((s) => lower.endsWith(s))
}

/** Rows parsed per sheet (SheetJS `sheetRows`). Text past the first
 *  few thousand rows would be cut by the budget anyway. */
const XLSX_SHEET_ROWS = 5000
/** Cells rendered per `sheet_to_csv` call while building a sheet's CSV
 *  in slices, so the budget check runs between slices. */
const XLSX_CELLS_PER_SLICE = 50_000

type XlsxModule = typeof import("xlsx")
type XlsxWorkbook = ReturnType<XlsxModule["read"]>
type XlsxSheet = XlsxWorkbook["Sheets"][string]
interface CellRange {
  s: { r: number; c: number }
  e: { r: number; c: number }
}

/** Bounds of the cells actually present in a (sparse-mode) sheet, or
 *  null when it has none. The declared `!ref` is file-controlled and can
 *  claim millions of empty cells; real cells cost bytes. */
function actualCellBounds(XLSX: XlsxModule, sheet: XlsxSheet): CellRange | null {
  let bounds: CellRange | null = null
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue
    const { r, c } = XLSX.utils.decode_cell(key)
    if (!(r >= 0 && c >= 0)) continue
    if (!bounds) {
      bounds = { s: { r, c }, e: { r, c } }
      continue
    }
    if (r < bounds.s.r) bounds.s.r = r
    if (c < bounds.s.c) bounds.s.c = c
    if (r > bounds.e.r) bounds.e.r = r
    if (c > bounds.e.c) bounds.e.c = c
  }
  return bounds
}

/**
 * Render every sheet as `# Sheet: <name>\n<csv>` blocks, stopping once
 * the output passes `budget` chars. Each sheet's range is clamped to
 * the intersection of its declared `!ref` and its real cells, and the
 * CSV is built in row slices so a wide/tall sheet stops early instead
 * of materialising everything before `truncate()` runs.
 */
function spreadsheetToText(
  XLSX: XlsxModule,
  workbook: XlsxWorkbook,
  budget: number
): string {
  const chunks: string[] = []
  let total = 0
  for (const sheetName of workbook.SheetNames) {
    if (total > budget) break
    const sheet = workbook.Sheets[sheetName]
    const declared = sheet?.["!ref"]
    if (!sheet || !declared) continue
    const actual = actualCellBounds(XLSX, sheet)
    if (!actual) continue
    const d = XLSX.utils.decode_range(declared)
    const range: CellRange = {
      s: { r: Math.max(d.s.r, actual.s.r), c: Math.max(d.s.c, actual.s.c) },
      e: { r: Math.min(d.e.r, actual.e.r), c: Math.min(d.e.c, actual.e.c) },
    }
    if (range.e.r < range.s.r || range.e.c < range.s.c) continue

    const cols = range.e.c - range.s.c + 1
    const rowsPerSlice = Math.max(1, Math.floor(XLSX_CELLS_PER_SLICE / cols))
    const header = `# Sheet: ${sheetName}\n`
    const slices: string[] = []
    let sheetLen = 0
    try {
      for (let r = range.s.r; r <= range.e.r; r += rowsPerSlice) {
        sheet["!ref"] = XLSX.utils.encode_range({
          s: { r, c: range.s.c },
          e: { r: Math.min(range.e.r, r + rowsPerSlice - 1), c: range.e.c },
        })
        const slice = XLSX.utils.sheet_to_csv(sheet)
        slices.push(slice)
        sheetLen += slice.length + 1
        if (total + header.length + sheetLen > budget) break
      }
    } finally {
      sheet["!ref"] = declared
    }
    const csv = slices.join("\n").trim()
    if (!csv) continue
    chunks.push(`${header}${csv}`)
    total += header.length + csv.length + 2
  }
  return chunks.join("\n\n")
}

export interface ExtractInput {
  name: string
  mimeType: string
  data: Buffer
}

export interface ExtractFileOptions {
  /** Force the vision pass on (`true`) / off (`false`); `undefined` →
   *  auto-decide via `shouldUseVision`. */
  vision?: boolean
  /** Per-call budget gate; called once right before the vision pass. When
   *  it denies, vision is skipped (text-only). Omitted → no gate. */
  consumeVisionBudget?: () => RateLimitVerdict
  signal?: AbortSignal
  // --- test seams (default to the real implementations) ---
  resolveVisionModel?: () => string | null
  extractWithVision?: (input: {
    data: Uint8Array
    model: string
    signal?: AbortSignal
  }) => Promise<{ text: string; pageCount: number }>
}

/** Best-effort vision enhancement of a PDF text result. Never throws —
 *  any failure returns the text-only result. */
async function maybeAddVision(
  textResult: ExtractionResult,
  data: Buffer,
  opts: ExtractFileOptions
): Promise<ExtractionResult> {
  const resolve = opts.resolveVisionModel ?? resolveVisionModel
  const runVision = opts.extractWithVision ?? defaultExtractWithVision

  const model = resolve()
  if (!model) return textResult

  const wanted =
    opts.vision === true
      ? true
      : opts.vision === false
        ? false
        : shouldUseVision(textResult, data.length)
  if (!wanted) return textResult

  if (opts.consumeVisionBudget && !opts.consumeVisionBudget().allowed) {
    return textResult
  }

  try {
    const vision = await runVision({ data, model, signal: opts.signal })
    if (!vision.text.trim()) return textResult
    return mergeVisionText(textResult, vision.text)
  } catch (err) {
    console.warn("[extraction] vision pass failed, using text-only:", err)
    return textResult
  }
}

/** Identify + extract a single uploaded file. */
export async function extractFile(
  input: ExtractInput,
  opts: ExtractFileOptions = {}
): Promise<ExtractionResult> {
  const { name, mimeType: type, data } = input

  // Plain-text formats
  if (
    type === "text/plain" ||
    type === "text/markdown" ||
    type === "text/csv" ||
    type === "application/json" ||
    hasName(name, ".txt", ".md", ".csv", ".json")
  ) {
    const raw = data.toString("utf-8")
    const { text, truncated, fullText } = truncate(raw)
    const kind: ExtractionKind =
      type === "application/json" || hasName(name, ".json")
        ? "json"
        : type === "text/csv" || hasName(name, ".csv")
          ? "csv"
          : type === "text/markdown" || hasName(name, ".md")
            ? "markdown"
            : "text"
    return { kind, text, truncated, fullText }
  }

  if (type === "application/pdf" || hasName(name, ".pdf")) {
    const { PDFParse } = await import("pdf-parse")
    // pdf-parse bundles its own pdfjs-dist 5.x; `isEvalSupported: false`
    // stops it compiling attacker-supplied PDF functions via `new Function`.
    const parser = new PDFParse({ data, isEvalSupported: false })
    const parsed = await parser.getText()
    const { text, truncated, fullText } = truncate(parsed.text ?? "")
    const textResult: ExtractionResult = { kind: "pdf", text, truncated, fullText }
    return await maybeAddVision(textResult, data, opts)
  }

  if (
    type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    hasName(name, ".docx")
  ) {
    // OOXML is a zip; cap entry count + real inflated size before
    // mammoth/JSZip inflates everything into memory (zip bombs).
    assertZipWithinLimits(data)
    const mammoth = await import("mammoth")
    const result = await mammoth.extractRawText({ buffer: data })
    const { text, truncated, fullText } = truncate(result.value ?? "")
    return { kind: "docx", text, truncated, fullText }
  }

  if (type === "text/html" || hasName(name, ".html", ".htm")) {
    const { parse } = await import("node-html-parser")
    const raw = data.toString("utf-8")
    const root = parse(raw, {
      comment: false,
      blockTextElements: { script: false, noscript: false, style: false, pre: true },
    })
    const visible = root.text.replace(/\s+/g, " ").trim()
    const { text, truncated, fullText } = truncate(visible)
    return { kind: "html", text, truncated, fullText }
  }

  {
    const language = codeLanguageFor(name)
    if (language) {
      const raw = data.toString("utf-8")
      const { text, truncated, fullText } = truncateTo(raw, CODE_BUDGET)
      return { kind: "code", text, truncated, fullText, language }
    }
  }

  if (
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    type === "application/vnd.ms-excel" ||
    hasName(name, ".xlsx", ".xls")
  ) {
    // .xlsx is a zip (guard it, as for docx); legacy .xls is an OLE/CFB
    // container that SheetJS reads without inflating, so it's skipped.
    if (looksLikeZip(data)) assertZipWithinLimits(data)
    const XLSX = await import("xlsx")
    // `sheetRows` stops the parser after the first N rows. Without it a
    // tiny file declaring a huge `<dimension>` (e.g. A1:CV1000000) is
    // read as-is and `sheet_to_csv` walks every declared cell.
    const workbook = XLSX.read(data, { type: "buffer", sheetRows: XLSX_SHEET_ROWS })
    const joined = spreadsheetToText(XLSX, workbook, FULL_EXTRACTION_BUDGET)
    const { text, truncated, fullText } = truncate(joined)
    return { kind: "spreadsheet", text, truncated, fullText }
  }

  // Images: client handles the data-URL locally. A successful empty
  // body keeps the contract clean if the route does get hit.
  if (
    type.startsWith("image/") ||
    hasName(name, ".png", ".jpg", ".jpeg", ".gif", ".webp")
  ) {
    return { kind: "image", text: "", truncated: false }
  }

  return { kind: "unsupported", text: "", truncated: false }
}
