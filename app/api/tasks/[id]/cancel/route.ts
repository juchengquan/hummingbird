import "server-only"

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { getRun } from "@/server/agent/store"
import { cancelTask, taskWriteErrorResponse } from "@/server/agent/task-writes"

/**
 * Out-of-band cancel (Q60), through `cancel_task` (0045) — the RPC the
 * runs API calls too. A top-level task: the whole task, from any row of
 * its chain of answers (the runs before and after it, and their
 * children); the question doesn't reopen. A child: skipped, its parent
 * continues. Idempotent — an ended row stays as it is, but its task is
 * still cancelled, so this doesn't look at the status first. The worker
 * can't write over a cancel; it stops at its next write or step, which
 * this route doesn't wait for.
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
    await cancelTask(db, id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const { status, code, message } =
      taskWriteErrorResponse(error) ?? categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
