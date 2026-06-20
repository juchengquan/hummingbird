import "server-only"

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { cancelChildTasks, getRun, updateRun } from "@/server/agent/store"
import { isTerminalStatus, type RunStatus } from "@/shared/agent/events"

/**
 * Out-of-band cancel: flip the run's status to `cancelled`. The runner
 * polls `isRunCancelled` between steps and settles on the next check —
 * this route doesn't wait for that, it just records the intent. Already
 * terminal runs are left untouched (idempotent no-op).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
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
  const userId = userData.user.id

  try {
    const run = await getRun(db, id, userId)
    if (!run) {
      return NextResponse.json(
        { code: "not_found", message: "Run not found." },
        { status: 404 }
      )
    }
    if (!isTerminalStatus(run.status as RunStatus)) {
      await updateRun(db, id, userId, { status: "cancelled", finished: true })
      await cancelChildTasks(db, id, userId)
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
