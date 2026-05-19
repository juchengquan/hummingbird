import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { z } from "zod"

import { getSupabaseServerClient } from "@/lib/supabase/server"

const CreateShareSchema = z.object({
  kind: z.enum(["conversation", "document"]),
  conversationId: z.string().uuid(),
})

/**
 * Mint a base64url-encoded random token. 22 chars = 128 bits of entropy,
 * which is comfortably brute-force-resistant for an unauthenticated
 * read-only resource.
 */
function mintToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Base64url without padding.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export async function POST(req: NextRequest) {
  const client = await getSupabaseServerClient()
  if (!client) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 })
  }

  const { data: userData, error: authError } = await client.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = CreateShareSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 })
  }

  // Verify the conversation belongs to this user — RLS would block the
  // insert anyway, but a 404 is cleaner than the RLS rejection that comes
  // back as a generic 23xxx error.
  const { data: conv, error: convError } = await client
    .from("conversations")
    .select("id")
    .eq("id", parsed.data.conversationId)
    .single()
  if (convError || !conv) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 })
  }

  const token = mintToken()
  const { error: insertError } = await client.from("shares").insert({
    token,
    user_id: userData.user.id,
    kind: parsed.data.kind,
    conversation_id: parsed.data.conversationId,
  })
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ token, kind: parsed.data.kind })
}
