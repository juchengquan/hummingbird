import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  getCachedResponse,
  responseCacheKey,
  setCachedResponse,
} from '@/server/cache/response-cache'
import { extractFile } from '@/server/extraction'
import { FILE_SIZE_LIMIT } from '@/shared/upload-config'

/**
 * `POST /api/extract` — multipart/form-data with a `file` field.
 * Thin glue around `lib/server/extraction.ts` (the shared library
 * the agent-ts service's `/v1/extract` also calls). All extraction
 * logic — kind classification, budgets, dynamic imports of
 * pdf-parse / mammoth / xlsx / node-html-parser — lives in the
 * library; this file parses the form, enforces the file-size cap,
 * and translates the `ExtractionResult` to a `NextResponse`.
 */

export const runtime = 'nodejs'
// Bigger uploads come through here than for JSON routes.
export const maxDuration = 30

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
  const mimeType = file.type || ''

  try {
    const data = Buffer.from(await file.arrayBuffer())
    // Exact-key response cache (PLAN-semantic-caching Phase 1). Extraction
    // is a deterministic function of the file bytes (+ name + mime), so a
    // re-upload of the same file skips the work. Key on a content hash of
    // the bytes rather than the bytes themselves.
    const contentHash = createHash('sha256').update(data).digest('hex')
    const cacheKey = responseCacheKey({
      kind: 'extract',
      model: '-',
      input: { name, mimeType, contentHash },
    })
    const cached = getCachedResponse(cacheKey)
    if (cached !== undefined) return NextResponse.json(cached)

    const result = await extractFile({ name, mimeType, data })
    setCachedResponse(cacheKey, result)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Extraction failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
