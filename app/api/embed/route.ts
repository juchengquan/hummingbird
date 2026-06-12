import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

import { EmbedRequestSchema } from "@/shared/api-schemas"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { isEmbeddingConfigured } from "@/server/embeddings/provider"
import { indexFileSections } from "@/server/embeddings/index-file"

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
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { code: "bad_request", error: "Expected a JSON body." },
      { status: 400 }
    )
  }

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
