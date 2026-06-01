import "server-only"

/**
 * Cron entry point for the task-queue worker. Processes ready jobs in
 * a loop until the queue is empty or this invocation's own time budget
 * runs out. Vercel hits this on a `vercel.json` cron schedule;
 * developers can also `curl` it during local testing as long as they
 * present the shared secret.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` or `?secret=<CRON_SECRET>`
 * (Vercel cron uses the header). Without `CRON_SECRET` set, the route
 * is disabled (503) — we don't want an unauthenticated cron endpoint
 * draining the queue in any deploy that hasn't opted in.
 */

import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

import { getSupabaseAdminClient } from "@/server/supabase/admin"
import { dispatchDueSchedules } from "@/server/agent/schedules"
import { inlineAgentWorkerEnabled } from "@/server/agent/inline-worker"
import { processNextJob, type ProcessOutcome } from "@/server/agent/worker"

const TICK_BUDGET_MS = (() => {
  const raw = Number(process.env.TASK_TICK_BUDGET_MS)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return 50_000
})()

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
  if (!inlineAgentWorkerEnabled()) {
    // Operator has handed the queue to a dedicated service
    // (agent-py / agent-ts). The cron tick is a no-op in that
    // mode — the service's own poll loop owns the work.
    return NextResponse.json({
      ok: true,
      processed: 0,
      idle: 0,
      skipped: 0,
      failed: 0,
      bailed: false,
      schedulesDispatched: 0,
      note: "inline_worker_disabled",
    })
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

  const deadline = Date.now() + TICK_BUDGET_MS

  // Step 7 — first walk task_schedules for due rows and enqueue start
  // jobs for them. Has to happen before the worker loop so a schedule
  // that fires right now actually runs this tick instead of waiting
  // for the next one.
  let scheduledFired = 0
  try {
    scheduledFired = await dispatchDueSchedules(db)
  } catch (err) {
    console.error("[tasks/tick] dispatchDueSchedules:", err)
  }

  const outcomes: ProcessOutcome[] = []
  // Loop until idle (no claim) or the tick's deadline is near. Each job
  // gets its own per-job budget inside `processNextJob`, so this loop
  // mainly drains backlog when the queue is busy.
  while (Date.now() < deadline) {
    const outcome = await processNextJob(db, {
      budgetMs: Math.max(5_000, deadline - Date.now()),
    })
    outcomes.push(outcome)
    if (outcome.kind === "idle") break
  }

  return NextResponse.json({
    scheduledFired,
    processed: outcomes.filter((o) => o.kind === "processed").length,
    failed: outcomes.filter((o) => o.kind === "failed").length,
    skipped: outcomes.filter((o) => o.kind === "skipped").length,
    outcomes,
  })
}
