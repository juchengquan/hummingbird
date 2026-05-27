import "server-only"

import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { reconcileStaleRuns } from "@/server/agent/store"

/**
 * Reconcile the caller's orphaned runs — flips `running`/`queued` rows
 * with no recent activity to `failed` (+ a synthetic `result` event so
 * any open resume stream settles). RLS-scoped to the authed user; the
 * client calls it on dashboard mount before auto-resuming. A cross-user
 * cron sweep (service-role) is a follow-up.
 */
export async function POST() {
  const db = await getSupabaseServerClient()
  if (!db) {
    return NextResponse.json(
      { code: "unavailable", message: "Supabase is not configured." },
      { status: 503 }
    )
  }

  const { data: userData, error: authError } = await db.auth.getUser()
  if (authError || !userData.user) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 }
    )
  }

  try {
    const failed = await reconcileStaleRuns(db, userData.user.id)
    return NextResponse.json({ ok: true, failed })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
