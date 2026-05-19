import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { getSupabaseServerClient } from "@/lib/supabase/server"

/**
 * Revoke a share. RLS limits the update to rows owned by the caller, so
 * a wrong token from another user simply matches zero rows and reports
 * "not found" without leaking existence.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const client = await getSupabaseServerClient()
  if (!client) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 503 })
  }

  const { data: userData, error: authError } = await client.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data, error } = await client
    .from("shares")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", token)
    .select("token")
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
