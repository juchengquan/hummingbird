import { createHash } from 'node:crypto'

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import {
  getCachedResponse,
  responseCacheKey,
  setCachedResponse,
} from '@/server/cache/response-cache'
import { extractFile, type VisionOutcome } from '@/server/extraction'
import { ZipLimitError } from '@/server/extraction/zip-guard'
import { requireAiAuth } from '@/server/auth/require-ai-auth'
import { createSlidingWindow, rateLimitKey } from '@/server/rate-limit'
import { BodyTooLargeError, readBodyCapped } from '@/server/read-body-capped'
import { FILE_SIZE_LIMIT } from '@/shared/upload-config'

/**
 * `POST /api/extract` — multipart/form-data with a `file` field.
 * Thin glue around `lib/server/extraction.ts` (the shared library
 * the agent-ts service's `/v1/extract` also calls). All extraction
 * logic — kind classification, budgets, dynamic imports of
 * pdf-parse / mammoth / xlsx / node-html-parser — lives in the
 * library; this file enforces the body/file-size caps, parses the
 * form, and translates the `ExtractionResult` to a `NextResponse`.
 */

// Vision extraction runs N model calls per doc — rate-limit per IP so a
// burst of layout-rich PDFs can't run the gateway bill up. Text-only
// extraction is unaffected (the gate is only consulted inside the vision
// branch).
const extractVisionLimit = createSlidingWindow({ windowMs: 60_000, max: 10 })

/** Per-IP cap on extraction requests of any kind. The route is open to
 *  anonymous callers and parsing (pdf / docx / xlsx) is CPU-heavy, so a
 *  loop of hostile files shouldn't get unlimited parser time. 60/min
 *  leaves room for a multi-file drop. Exported for tests. */
export const extractTextLimit = createSlidingWindow({ windowMs: 60_000, max: 60 })

/** The vision mode this caller actually gets: the requested `vision`
 *  field, forced to `off` when the sign-in gate denies vision. */
export type EffectiveVisionMode = 'auto' | 'on' | 'off'

export function effectiveVisionMode(
  requested: boolean | undefined,
  visionDenied: boolean
): EffectiveVisionMode {
  if (visionDenied || requested === false) return 'off'
  return requested === true ? 'on' : 'auto'
}

/** Exact-key cache key for an extraction. The effective vision mode is
 *  part of the key, so `auto`, `on` and `off` results never collide and
 *  a caller denied vision (mode `off`) can't be served a cached vision
 *  result. Exported for unit testing. */
export function extractCacheKey(parts: {
  name: string
  mimeType: string
  contentHash: string
  vision: EffectiveVisionMode
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

/** Whole multipart body cap: the file cap plus headroom for the
 *  multipart boundaries, part headers and the small `vision` field. */
export const EXTRACT_BODY_MAX = FILE_SIZE_LIMIT + 64 * 1024

const tooLarge = () =>
  NextResponse.json({ error: 'File too large.' }, { status: 413 })

export async function POST(req: NextRequest) {
  const limit = extractTextLimit.consume(rateLimitKey(req))
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many extraction requests. Retry in ${limit.retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
    )
  }

  // Size-check BEFORE parsing: `req.formData()` would buffer an
  // arbitrarily large body first. Content-Length is checked up front
  // and the stream is cut off once it passes the cap.
  let body: Uint8Array
  try {
    body = await readBodyCapped(req, EXTRACT_BODY_MAX)
  } catch (error) {
    if (error instanceof BodyTooLargeError) return tooLarge()
    return NextResponse.json({ error: 'Could not read request body.' }, { status: 400 })
  }

  let form: FormData
  try {
    form = await new Response(body as BodyInit, {
      headers: { 'content-type': req.headers.get('content-type') ?? '' },
    }).formData()
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
  if (file.size > FILE_SIZE_LIMIT) return tooLarge()

  const name = file instanceof File ? file.name : 'unnamed'
  const mimeType = file.type || ''

  // Optional `vision` form field: "true"/"false" forces the vision pass
  // on/off; absent → auto-decide via the extractor's heuristic.
  const visionField = form.get('vision')
  const requestedVision =
    visionField === 'true' ? true : visionField === 'false' ? false : undefined

  // REQUIRE_AUTH_FOR_AI: text extraction spends no model budget, so it
  // stays open to anonymous callers (file attach keeps working). The
  // vision pass is model-backed — an anonymous caller is forced to
  // text-only. When the gate is inactive `aiAuth.ok` is always true.
  const aiAuth = await requireAiAuth()
  const mode = effectiveVisionMode(requestedVision, !aiAuth.ok)

  try {
    const data = Buffer.from(await file.arrayBuffer())
    const contentHash = createHash('sha256').update(data).digest('hex')
    const cacheKey = extractCacheKey({ name, mimeType, contentHash, vision: mode })
    const cached = getCachedResponse(cacheKey)
    if (cached !== undefined) return NextResponse.json(cached)

    let visionOutcome = null as VisionOutcome | null
    const result = await extractFile(
      { name, mimeType, data },
      {
        vision: mode === 'on' ? true : mode === 'off' ? false : undefined,
        consumeVisionBudget: () => extractVisionLimit.consume(rateLimitKey(req)),
        onVisionOutcome: (outcome) => {
          visionOutcome = outcome
        },
      }
    )
    // A result degraded for THIS caller (vision wanted, but their budget
    // was spent or the pass failed) isn't what the key promises — another
    // caller in the same mode would get the vision text. Don't cache it.
    const degraded = visionOutcome === 'budget_denied' || visionOutcome === 'failed'
    if (!degraded) setCachedResponse(cacheKey, result)
    return NextResponse.json(result)
  } catch (error) {
    // Office zip whose decompressed size / entry count exceeds the
    // guard in `lib/server/extraction/zip-guard.ts` (zip bomb).
    if (error instanceof ZipLimitError) {
      return NextResponse.json({ error: error.message }, { status: 413 })
    }
    const message = error instanceof Error ? error.message : 'Extraction failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
