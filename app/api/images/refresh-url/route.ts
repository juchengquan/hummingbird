import "server-only"

/**
 * `POST /api/images/refresh-url` — re-sign an expired generated-image
 * URL.
 *
 * Signed URLs minted by `persistGeneratedImages` carry a 1-year TTL,
 * which means anyone with a year-old conversation eventually hits an
 * expired URL. The bytes are still in Storage at `storagePath`; this
 * route mints a fresh signature.
 *
 * Authorisation: two layers. (1) Caller must be signed in; (2) the
 * supplied `storagePath`'s first segment must match `auth.uid()`. The
 * RLS policy on the `user-files` bucket (migration 0003) already
 * enforces this on `createSignedUrl`, but failing fast with a clean
 * 403 is friendlier than fighting an opaque storage error.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { signGeneratedImageUrl } from "@/server/image-storage"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { RefreshImageUrlRequestSchema } from "@/shared/api-schemas"

export async function POST(req: NextRequest) {
  const client = await getSupabaseServerClient()
  if (!client) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 }
    )
  }
  const { data: userData, error: authError } = await client.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 }
    )
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 }
    )
  }
  const parsed = RefreshImageUrlRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 }
    )
  }
  const { storagePath } = parsed.data

  // Bucket layout is `<userId>/...` (see `uploadToBucket` in
  // image-storage.ts + the RLS policy in 0003_storage.sql). Reject a
  // path that doesn't belong to the caller up-front rather than letting
  // RLS surface as a confusing storage error.
  const firstSegment = storagePath.split("/")[0]
  if (firstSegment !== userData.user.id) {
    return NextResponse.json(
      { code: "forbidden", message: "Storage path does not belong to you." },
      { status: 403 }
    )
  }

  const url = await signGeneratedImageUrl(storagePath, client)
  if (!url) {
    return NextResponse.json(
      {
        code: "not_found",
        message: "Could not re-sign the URL — object may be missing.",
      },
      { status: 404 }
    )
  }
  return NextResponse.json({ url })
}
