import "server-only"

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"

import { categorizeError } from "@/shared/api-errors"
import { getSupabaseServerClient } from "@/server/supabase/server"
import { listTaskChildren } from "@/server/agent/store"
import { rowsToTaskEvents } from "@/shared/agent/persistence"
import { projectRun, type PendingInput } from "@/shared/agent/project"
import type { Database } from "@/shared/supabase/types"

/**
 * A paused child's open question (Q59): the fold of its `approval` events
 * and of the `status` ones, whose resume markers discard a dead attempt's
 * question. Only those kinds are read: this is polled, and a whole log
 * can pass PostgREST's `max_rows`.
 */
async function openQuestion(
  db: SupabaseClient<Database>,
  childId: string,
  userId: string
): Promise<PendingInput | null> {
  const { data, error } = await db
    .from("task_events")
    .select("task_id,seq,step,kind,payload,created_at")
    .eq("task_id", childId)
    .eq("user_id", userId)
    .in("kind", ["approval", "status"])
    .order("seq", { ascending: true })
  if (error) throw new Error(`openQuestion: ${error.message}`)
  return projectRun(rowsToTaskEvents(data ?? [])).pendingInput
}

/**
 * `GET /api/tasks/:id/children` — a task's sub-agents: status, goal, and
 * for a paused one the question it waits on, answered through
 * `POST /api/tasks/:childId/respond`.
 */
export async function GET(
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

  try {
    const userId = userData.user.id
    const rows = await listTaskChildren(db, id, userId)
    const children = await Promise.all(
      rows.map(async (child) =>
        child.status === "paused"
          ? { ...child, pendingInput: await openQuestion(db, child.id, userId) }
          : child
      )
    )
    return NextResponse.json({ children })
  } catch (error) {
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
