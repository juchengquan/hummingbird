import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  getCachedResponse,
  responseCacheKey,
  setCachedResponse,
} from '@/server/cache/response-cache'
import { extractFile } from '@/server/extraction'
import { createSlidingWindow, rateLimitKey } from '@/server/rate-limit'
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

// Vision extraction runs N model calls per doc — rate-limit per IP so a
// burst of layout-rich PDFs can't run the gateway bill up. Text-only
// extraction is unaffected (the gate is only consulted inside the vision
// branch).
const extractVisionLimit = createSlidingWindow({ windowMs: 60_000, max: 10 })

/** Exact-key cache key for an extraction. The `vision` flag is part of
 *  the key so a forced-vision result and a text-only result don't
 *  collide. Exported for unit testing. */
export function extractCacheKey(parts: {
  name: string
  mimeType: string
  contentHash: string
  vision: boolean
}): string {
  return responseCacheKey({
    kind: 'extract',
    model: '-',
    input: {
      name: parts.name,
      mimeType: parts.mimeType,
      contentHash: parts.contentHash,
      vision: parts.vision,
    },
  })
}

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

  // Optional `vision` form field: "true"/"false" forces the vision pass
  // on/off; absent → auto-decide via the extractor's heuristic.
  const visionField = form.get('vision')
  const visionFlag =
    visionField === 'true' ? true : visionField === 'false' ? false : undefined

  try {
    const data = Buffer.from(await file.arrayBuffer())
    const contentHash = createHash('sha256').update(data).digest('hex')
    // Cache key folds in the vision intent so a forced-vision result and
    // a text-only result are stored distinctly.
    const cacheKey = extractCacheKey({
      name,
      mimeType,
      contentHash,
      vision: visionFlag ?? false,
    })
    const cached = getCachedResponse(cacheKey)
    if (cached !== undefined) return NextResponse.json(cached)

    const result = await extractFile(
      { name, mimeType, data },
      {
        vision: visionFlag,
        consumeVisionBudget: () => extractVisionLimit.consume(rateLimitKey(req)),
      }
    )
    setCachedResponse(cacheKey, result)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Extraction failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
