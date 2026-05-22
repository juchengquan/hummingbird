import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { FILE_SIZE_LIMIT } from '@/shared/upload-config'

// Keep extracted-text budget aligned with the client constant.
const EXTRACTION_BUDGET = 100 * 1024

export const runtime = 'nodejs'
// Bigger uploads come through here than for JSON routes.
export const maxDuration = 30

interface ExtractionResponse {
  kind:
    | 'pdf'
    | 'docx'
    | 'markdown'
    | 'csv'
    | 'json'
    | 'text'
    | 'image'
    | 'html'
    | 'code'
    | 'spreadsheet'
    | 'unsupported'
  text: string
  truncated: boolean
  /** Detected source language for `code` kind (e.g. 'tsx', 'python'). */
  language?: string
  /** Full extracted text (capped at FULL_EXTRACTION_BUDGET). Only set
   *  when distinct from `text` — see ExtractionResponseSchema in
   *  `lib/shared/api-schemas.ts` for the canonical wire shape. */
  fullText?: string
}

// Code files get a wider window than prose — 128 KB. Source files routinely
// blow past the prose budget without being long-form content.
const CODE_BUDGET = 128 * 1024

// Full-text budget for the Phase 3 `readFileSection` tool. 1 MB — 10x
// the inline view. The FTS index lives at `files.full_text_tsv` (see
// 0007 migration); the truncated `text` field stays the inline-prompt
// version. Files extracting past this cap lose the tail end from FTS,
// but 1 MB is plenty for "find the section about X" — the realistic
// failure mode is huge log files, not docs/papers.
const FULL_EXTRACTION_BUDGET = 1024 * 1024

interface ExtractedBlock {
  /** Inline-view text, truncated to per-format budget. */
  text: string
  /** True when `text` was cut from a longer source. */
  truncated: boolean
  /** Full extraction (capped at FULL_EXTRACTION_BUDGET). Only set
   *  when distinct from `text` — when they would match (file fits
   *  the inline budget), this is undefined and the wire response
   *  omits the field. */
  fullText?: string
}

function truncateTo(raw: string, budget: number): ExtractedBlock {
  if (raw.length <= budget) {
    // Small file: inline view is the whole thing. No separate fullText.
    return { text: raw, truncated: false }
  }
  const text = raw.slice(0, budget)
  const fullText = raw.length <= FULL_EXTRACTION_BUDGET
    ? raw
    : raw.slice(0, FULL_EXTRACTION_BUDGET)
  return { text, truncated: true, fullText }
}

const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.sh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
}

function codeLanguageFor(name: string): string | null {
  const lower = name.toLowerCase()
  for (const ext of Object.keys(CODE_EXTENSIONS)) {
    if (lower.endsWith(ext)) return CODE_EXTENSIONS[ext]
  }
  return null
}

function truncate(raw: string): ExtractedBlock {
  return truncateTo(raw, EXTRACTION_BUDGET)
}

function hasName(name: string, ...suffixes: string[]) {
  const lower = name.toLowerCase()
  return suffixes.some((s) => lower.endsWith(s))
}

export async function POST(req: NextRequest) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(
      { error: 'Expected multipart/form-data with a `file` field.' },
      { status: 400 }
    )
  }

  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'No `file` field.' }, { status: 400 })
  }
  if (file.size > FILE_SIZE_LIMIT) {
    return NextResponse.json({ error: 'File too large.' }, { status: 413 })
  }

  const name = file instanceof File ? file.name : 'unnamed'
  const type = file.type

  try {
    // Plain-text formats
    if (
      type === 'text/plain' ||
      type === 'text/markdown' ||
      type === 'text/csv' ||
      type === 'application/json' ||
      hasName(name, '.txt', '.md', '.csv', '.json')
    ) {
      const raw = await file.text()
      const { text, truncated, fullText } = truncate(raw)
      const kind: ExtractionResponse['kind'] =
        type === 'application/json' || hasName(name, '.json')
          ? 'json'
          : type === 'text/csv' || hasName(name, '.csv')
          ? 'csv'
          : type === 'text/markdown' || hasName(name, '.md')
          ? 'markdown'
          : 'text'
      return NextResponse.json<ExtractionResponse>({ kind, text, truncated, fullText })
    }

    // PDF
    if (type === 'application/pdf' || hasName(name, '.pdf')) {
      const { PDFParse } = await import('pdf-parse')
      const buffer = Buffer.from(await file.arrayBuffer())
      const parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      const { text, truncated, fullText } = truncate(result.text ?? '')
      return NextResponse.json<ExtractionResponse>({ kind: 'pdf', text, truncated, fullText })
    }

    // DOCX
    if (
      type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      hasName(name, '.docx')
    ) {
      const mammoth = await import('mammoth')
      const buffer = Buffer.from(await file.arrayBuffer())
      const result = await mammoth.extractRawText({ buffer })
      const { text, truncated, fullText } = truncate(result.value ?? '')
      return NextResponse.json<ExtractionResponse>({ kind: 'docx', text, truncated, fullText })
    }

    // HTML — strip tags, keep visible text. We use a streaming HTML parser
    // rather than a naïve regex so script/style content gets cleanly removed
    // and entities decode.
    if (type === 'text/html' || hasName(name, '.html', '.htm')) {
      const { parse } = await import('node-html-parser')
      const raw = await file.text()
      const root = parse(raw, {
        comment: false,
        blockTextElements: { script: false, noscript: false, style: false, pre: true },
      })
      const visible = root.text.replace(/\s+/g, ' ').trim()
      const { text, truncated, fullText } = truncate(visible)
      return NextResponse.json<ExtractionResponse>({ kind: 'html', text, truncated, fullText })
    }

    // Code files — treat as plain text with a wider budget and a detected
    // language tag the chat route can surface in the per-file header.
    {
      const language = codeLanguageFor(name)
      if (language) {
        const raw = await file.text()
        const { text, truncated, fullText } = truncateTo(raw, CODE_BUDGET)
        return NextResponse.json<ExtractionResponse>({
          kind: 'code',
          text,
          truncated,
          fullText,
          language,
        })
      }
    }

    // XLSX — emit one labelled CSV block per sheet. `xlsx` is ~600 KB but
    // dynamic-imported, so it never touches the main bundle.
    if (
      type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      type === 'application/vnd.ms-excel' ||
      hasName(name, '.xlsx', '.xls')
    ) {
      const XLSX = await import('xlsx')
      const buffer = Buffer.from(await file.arrayBuffer())
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const chunks: string[] = []
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        if (!sheet) continue
        const csv = XLSX.utils.sheet_to_csv(sheet)
        if (!csv.trim()) continue
        chunks.push(`# Sheet: ${sheetName}\n${csv.trim()}`)
      }
      const joined = chunks.join('\n\n')
      const { text, truncated, fullText } = truncate(joined)
      return NextResponse.json<ExtractionResponse>({
        kind: 'spreadsheet',
        text,
        truncated,
        fullText,
      })
    }

    // Images: the client handles them locally (FileReader → data URL stored
    // on UploadedFile.imageDataUrl), so this route is normally never called
    // for them. Returning a successful image response (rather than
    // 'unsupported') keeps the contract clean if anything does hit it.
    if (type.startsWith('image/') || hasName(name, '.png', '.jpg', '.jpeg', '.gif', '.webp')) {
      return NextResponse.json<ExtractionResponse>({
        kind: 'image',
        text: '',
        truncated: false,
      })
    }

    return NextResponse.json<ExtractionResponse>({
      kind: 'unsupported',
      text: '',
      truncated: false,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Extraction failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
