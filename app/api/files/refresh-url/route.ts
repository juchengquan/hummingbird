import "server-only"

/**
 * `POST /api/files/refresh-url` — re-sign an expired generated-file URL.
 *
 * Signed URLs minted by `persistGeneratedFiles` carry a 1-year TTL, so an
 * old conversation eventually hits an expired URL. The bytes are still in
 * Storage at `storagePath`; this route mints a fresh signature. Mirrors
 * `app/api/images/refresh-url/route.ts`.
 *
 * Authorisation: (1) caller must be signed in; (2) the supplied
 * `storagePath`'s first segment must match `auth.uid()` (bucket layout is
 * `<userId>/...`). RLS (migration 0003) also enforces this, but failing
 * fast with a clean 403 beats an opaque storage error.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { signGeneratedFileUrl } from "@/server/file-storage"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { RefreshFileUrlRequestSchema } from "@/shared/api-schemas"

export async function POST(req: NextRequest) {
  const client = await getSupabaseServerClient()
  if (!client) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 },
    )
  }
  const { data: userData, error: authError } = await client.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 },
    )
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 },
    )
  }
  const parsed = RefreshFileUrlRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 },
    )
  }
  const { storagePath } = parsed.data

  const firstSegment = storagePath.split("/")[0]
  if (firstSegment !== userData.user.id) {
    return NextResponse.json(
      { code: "forbidden", message: "Storage path does not belong to you." },
      { status: 403 },
    )
  }

  const url = await signGeneratedFileUrl(storagePath, client)
  if (!url) {
    return NextResponse.json(
      {
        code: "not_found",
        message: "Could not re-sign the URL — object may be missing.",
      },
      { status: 404 },
    )
  }
  return NextResponse.json({ url })
}
