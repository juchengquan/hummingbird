import "server-only"

/**
 * Cron entry point for `task_schedules` dispatch. Walks due
 * schedules and enqueues `start` jobs for them. The dedicated
 * agent services (`services/agent-py/` and `services/agent-ts/`)
 * own job execution from there — this route does NOT claim or
 * run jobs anymore (the in-Next inline worker was retired alongside
 * this change).
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` or
 * `?secret=<CRON_SECRET>`. Without `CRON_SECRET` set, the route is
 * disabled (503).
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { dispatchDueSchedules } from "@/server/agent/schedules"
import { getSupabaseAdminClient } from "@/server/supabase/admin"

export async function POST(req: NextRequest) {
  return handle(req)
}

// Vercel cron triggers a GET by default; accept both so the same route
// works under cron and manual `curl -X POST`.
export async function GET(req: NextRequest) {
  return handle(req)
}

async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json(
      { code: "unavailable", message: "Task tick is disabled (CRON_SECRET not set)." },
      { status: 503 }
    )
  }
  const auth = req.headers.get("authorization") ?? ""
  const headerOk = auth === `Bearer ${expected}`
  const queryOk = req.nextUrl.searchParams.get("secret") === expected
  if (!headerOk && !queryOk) {
    return NextResponse.json(
      { code: "auth", message: "Unauthorized." },
      { status: 401 }
    )
  }

  const db = getSupabaseAdminClient()
  if (!db) {
    return NextResponse.json(
      {
        code: "unavailable",
        message: "Admin client unavailable (SUPABASE_SERVICE_ROLE_KEY not set).",
      },
      { status: 503 }
    )
  }

  let scheduledFired = 0
  try {
    scheduledFired = await dispatchDueSchedules(db)
  } catch (err) {
    console.error("[tasks/tick] dispatchDueSchedules:", err)
  }

  return NextResponse.json({ scheduledFired })
}
