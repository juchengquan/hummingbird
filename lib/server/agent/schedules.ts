import "server-only"

/**
 * Recurring task runs ("run every morning at 8") — step 7 of
 * `PLAN-agent-task-queue.md`. A row in `task_schedules` is a saved
 * spec for a task plus a cron expression + IANA timezone. The worker's
 * tick route walks due rows and enqueues a `start` job for each,
 * exactly like a user-triggered `POST /api/tasks` does today.
 *
 * The control plane lives here:
 *  - `nextRunFromCron` — pure: cron + tz + after → next fire time.
 *  - `dispatchDueSchedules` — server-side: claim, enqueue, advance.
 *  - row codec helpers for the route layer.
 *
 * `cron-parser` does the heavy lifting; we just have to remember to
 * pass `currentDate` (not `now`) and a tz string Postgres recognises.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { CronExpressionParser } from "cron-parser"
import type { ModelMessage } from "ai"

import type { Database, Json } from "@/shared/supabase/types"

import type { RunCheckpoint } from "./checkpoint"
import { enqueueStartJob } from "./jobs"
import { appendEvent, createRun, saveCheckpoint } from "./store"

type DB = SupabaseClient<Database>

export interface TaskScheduleConfig {
  id: string
  userId: string
  workspaceId: string
  name: string
  prompt: string
  cron: string
  timezone: string
  enabled: boolean
  model: string | null
  systemPrompt: string | null
  skills: Json | null
  maxSteps: number | null
}

export type ScheduleRow = Database["public"]["Tables"]["task_schedules"]["Row"]

/**
 * Next fire time for a cron + IANA timezone, strictly after `after`.
 * Returns `null` for unparseable cron strings or unknown timezones —
 * callers surface that as a validation error (the create route) or as
 * a logged skip (the tick).
 */
export function nextRunFromCron(
  cron: string,
  timezone: string,
  after: Date
): Date | null {
  try {
    const it = CronExpressionParser.parse(cron, {
      currentDate: after,
      tz: timezone,
    })
    return it.next().toDate()
  } catch {
    return null
  }
}

/**
 * Walk the ready set and fire each. Returns the count actually enqueued
 * (some rows may have been deleted between select and update). Uses the
 * service-role client — the tick runs without a user session.
 */
export async function dispatchDueSchedules(db: DB): Promise<number> {
  const now = new Date()
  const { data, error } = await db
    .from("task_schedules")
    .select("*")
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(50)
  if (error) {
    throw new Error(`dispatchDueSchedules: ${error.message}`)
  }
  if (!data || data.length === 0) return 0

  let fired = 0
  for (const row of data) {
    // Re-stamp `next_run_at` first with a guarded update. If two ticks
    // race and the other already moved this row forward, our update
    // touches zero rows and we skip the enqueue.
    const advanced = nextRunFromCron(row.cron, row.timezone, now)
    if (!advanced) {
      // Bad cron/tz — disable so we don't spin forever. The user will
      // see the row flip in the UI and can fix + re-enable.
      await db
        .from("task_schedules")
        .update({ enabled: false, updated_at: now.toISOString() })
        .eq("id", row.id)
        .eq("user_id", row.user_id)
      continue
    }
    const { data: claimed, error: claimErr } = await db
      .from("task_schedules")
      .update({
        next_run_at: advanced.toISOString(),
        last_run_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", row.id)
      .eq("user_id", row.user_id)
      .eq("next_run_at", row.next_run_at)
      .select("id")
      .maybeSingle()
    if (claimErr || !claimed) continue

    try {
      await fireSchedule(db, row)
      fired += 1
    } catch (err) {
      console.error("[schedules] fire failed for", row.id, err)
      // Even though the enqueue failed, `next_run_at` is already
      // pushed forward — the user will see the row's `last_run_task_id`
      // stay unchanged and can retry by editing + saving the row.
    }
  }
  return fired
}

/**
 * Set up a fresh run from a schedule row: create the conversation row
 * (the worker authors the result Message into it), write the initial
 * `tasks` + `task_events`(queued) + checkpoint exactly like
 * `POST /api/tasks` does, enqueue the `start` job, and stamp the
 * schedule's `last_run_task_id` so the UI can deep-link to the result.
 */
async function fireSchedule(db: DB, row: ScheduleRow): Promise<void> {
  const userId = row.user_id
  const runId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const maxSteps = row.max_steps ?? 25

  // Conversation row so the worker has somewhere to author the result.
  const convInsert = await db.from("conversations").insert({
    id: conversationId,
    user_id: userId,
    workspace_id: row.workspace_id,
    title: `Scheduled: ${row.name}`,
  })
  if (convInsert.error) {
    throw new Error(`conversation insert: ${convInsert.error.message}`)
  }

  // `tasks` + `task_events`(queued) + initial checkpoint exactly like
  // the start route, so the worker treats this as just another run.
  await createRun(db, {
    id: runId,
    userId,
    conversationId,
    goal: row.prompt.slice(0, 2000),
    maxSteps,
  })

  const messages: ModelMessage[] = [{ role: "user", content: row.prompt }]
  const checkpoint: RunCheckpoint = {
    messages,
    step: 0,
    seq: 1,
    config: {
      model: row.model ?? "",
      workspaceSystemPrompt: row.system_prompt ?? undefined,
      workspaceId: row.workspace_id,
      skills: (row.skills as RunCheckpoint["config"]["skills"]) ?? [],
      maxSteps,
    },
  }
  await saveCheckpoint(db, runId, userId, checkpoint)

  // Synthetic `status:queued` event so a watching client sees the
  // scheduled run flip in.
  await appendEvent(
    db,
    {
      runId,
      seq: 1,
      step: 0,
      createdAt: new Date().toISOString(),
      kind: "status",
      status: "queued",
      maxSteps,
    },
    userId
  )

  await enqueueStartJob(db, { taskId: runId, userId })

  // Record which task this fire produced so the UI can link to it.
  await db
    .from("task_schedules")
    .update({ last_run_task_id: runId })
    .eq("id", row.id)
    .eq("user_id", userId)
}
