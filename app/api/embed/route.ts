import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

import { EmbedRequestSchema } from "@/shared/api-schemas"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { isEmbeddingConfigured } from "@/server/embeddings/provider"
import { indexFileSections } from "@/server/embeddings/index-file"
import { createSlidingWindow } from "@/server/rate-limit"
import {
  formatBodyLimit,
  PAYLOAD_TOO_LARGE_CODE,
  readJsonCapped,
} from "@/server/read-body-capped"

/** Body cap: `text` ≤ 1.2M chars at ≤ 3 UTF-8 bytes per char, plus the
 *  tiny `fileId` / `force` fields. */
const EMBED_BODY_MAX = 4 * 1024 * 1024

/** Per-user cap. Each call can embed ~1 MB of text (many paid chunks);
 *  30/min still covers a multi-file drop plus the client's
 *  `file_not_found` backoff retries. */
const embedLimit = createSlidingWindow({ windowMs: 60_000, max: 30 })

/**
 * `POST /api/embed` — chunk + embed a file's extracted text into the
 * `file_sections` vector table (PLAN-local-rag.md PR 2). The body carries
 * the text directly (`{ fileId, text, force? }`) so the populate path
 * doesn't depend on `files.full_text` having synced — the only cloud
 * precondition is the `files` row existing for the FK.
 *
 * Requires sign-in (RLS scopes `file_sections` to the owner). Inert when
 * no embedder is configured: returns `{ status: 'skipped',
 * reason: 'not_configured' }` with 200 so the best-effort client caller
 * treats it as a no-op rather than an error.
 */

export const runtime = "nodejs"
// Embedding a 1 MB file is many chunks × a model round-trip each.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const read = await readJsonCapped(req, EMBED_BODY_MAX)
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json(
          {
            code: PAYLOAD_TOO_LARGE_CODE,
            error: `Request body exceeds ${formatBodyLimit(EMBED_BODY_MAX)}.`,
          },
          { status: 413 }
        )
      : NextResponse.json(
          { code: "bad_request", error: "Expected a JSON body." },
          { status: 400 }
        )
  }
  const body = read.value

  const parsed = EmbedRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { code: "bad_request", error: "Invalid embed request." },
      { status: 400 }
    )
  }

  const client = await getSupabaseServerClient()
  if (!client) {
    return NextResponse.json(
      { code: "not_signed_in", error: "Embedding requires sign-in." },
      { status: 401 }
    )
  }
  const { data: userData } = await client.auth.getUser()
  const userId = userData.user?.id
  if (!userId) {
    return NextResponse.json(
      { code: "not_signed_in", error: "Embedding requires sign-in." },
      { status: 401 }
    )
  }

  // Env gate lives at the boundary; the orchestration stays env-free.
  if (!isEmbeddingConfigured()) {
    return NextResponse.json({ status: "skipped", sections: 0, reason: "not_configured" })
  }

  const limit = embedLimit.consume(`user:${userId}`)
  if (!limit.allowed) {
    return NextResponse.json(
      {
        code: "rate_limited",
        error: `Too many embed requests. Retry in ${limit.retryAfterSec}s.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    )
  }

  try {
    const result = await indexFileSections({
      client,
      userId,
      fileId: parsed.data.fileId,
      text: parsed.data.text,
      force: parsed.data.force,
    })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Embedding failed."
    return NextResponse.json({ code: "embed_failed", error: message }, { status: 500 })
  }
}
