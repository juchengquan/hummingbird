import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { FILE_SIZE_LIMIT } from '@/lib/upload-config'

// Keep extracted-text budget aligned with the client constant.
const EXTRACTION_BUDGET = 32 * 1024

export const runtime = 'nodejs'
// Bigger uploads come through here than for JSON routes.
export const maxDuration = 30

interface ExtractionResponse {
  kind: 'pdf' | 'docx' | 'markdown' | 'csv' | 'json' | 'text' | 'image' | 'unsupported'
  text: string
  truncated: boolean
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXTRACTION_BUDGET) return { text, truncated: false }
  return { text: text.slice(0, EXTRACTION_BUDGET), truncated: true }
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
      const { text, truncated } = truncate(raw)
      const kind: ExtractionResponse['kind'] =
        type === 'application/json' || hasName(name, '.json')
          ? 'json'
          : type === 'text/csv' || hasName(name, '.csv')
          ? 'csv'
          : type === 'text/markdown' || hasName(name, '.md')
          ? 'markdown'
          : 'text'
      return NextResponse.json<ExtractionResponse>({ kind, text, truncated })
    }

    // PDF
    if (type === 'application/pdf' || hasName(name, '.pdf')) {
      const { PDFParse } = await import('pdf-parse')
      const buffer = Buffer.from(await file.arrayBuffer())
      const parser = new PDFParse({ data: buffer })
      const result = await parser.getText()
      const { text, truncated } = truncate(result.text ?? '')
      return NextResponse.json<ExtractionResponse>({ kind: 'pdf', text, truncated })
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
      const { text, truncated } = truncate(result.value ?? '')
      return NextResponse.json<ExtractionResponse>({ kind: 'docx', text, truncated })
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
