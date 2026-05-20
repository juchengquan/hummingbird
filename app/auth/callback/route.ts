import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getSupabaseServerClient } from "@/server/supabase/server"

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const next = searchParams.get("next") ?? "/dashboard"

  const client = await getSupabaseServerClient()

  if (!client) {
    return NextResponse.redirect(
      `${origin}/dashboard?auth_error=unconfigured`
    )
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/dashboard?auth_error=missing_code`)
  }

  const { error } = await client.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(
      `${origin}/dashboard?auth_error=${encodeURIComponent(error.message)}`
    )
  }

  return NextResponse.redirect(`${origin}${next}`)
}
