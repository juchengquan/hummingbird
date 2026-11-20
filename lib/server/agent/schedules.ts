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

/** Route-side floor between two fires of one schedule. */
export const SCHEDULE_MIN_INTERVAL_MS = 5 * 60_000

/** Dispatcher-side floor: the route's 5 minutes minus one tick of
 *  slack, so a legitimate every-5-minutes schedule isn't throttled by
 *  cron-tick jitter. Applies to every row, whatever wrote it — the
 *  backstop for rows written straight through PostgREST or before 0035. */
export const SCHEDULE_DISPATCH_MIN_GAP_MS = 4 * 60_000

/** How many consecutive fires `validateScheduleCron` inspects. Enough to
 *  cross hour and day boundaries for any minute field the coarse guard
 *  admits (≤ 12 fires an hour). */
const CRON_GAP_SAMPLE = 48

/**
 * Mirror of the DB's `private.task_schedule_cron_coarse_ok` (0035):
 * five fields, and a minute field that fires at most 12 times an hour
 * (a list of ≤ 12 minutes, or `*` / a range / a start with step ≥ 5).
 */
export function cronPassesCoarseGuard(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const minute = fields[0]
  return (
    /^[0-5]?[0-9](,[0-5]?[0-9]){0,11}$/.test(minute) ||
    /^(\*|[0-5]?[0-9]-[0-5]?[0-9]|[0-5]?[0-9])\/([5-9]|[1-5][0-9])$/.test(minute)
  )
}

export type CronValidation =
  | { ok: true; next: Date }
  | { ok: false; message: string }

/**
 * Validate a schedule's cron + timezone for the create/update routes:
 * parseable, passes the DB's coarse guard, and never fires twice within
 * `SCHEDULE_MIN_INTERVAL_MS`. Returns the first fire after `after`.
 */
export function validateScheduleCron(
  cron: string,
  timezone: string,
  after: Date
): CronValidation {
  let fires: Date[]
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone })
    fires = []
    for (let i = 0; i < CRON_GAP_SAMPLE; i++) fires.push(it.next().toDate())
  } catch {
    return {
      ok: false,
      message: `Couldn't parse cron "${cron}" with timezone "${timezone}".`,
    }
  }
  const tooFrequent = {
    ok: false as const,
    message: `Cron "${cron}" fires more often than every ${SCHEDULE_MIN_INTERVAL_MS / 60_000} minutes.`,
  }
  if (!cronPassesCoarseGuard(cron)) return tooFrequent
  for (let i = 1; i < fires.length; i++) {
    if (fires[i].getTime() - fires[i - 1].getTime() < SCHEDULE_MIN_INTERVAL_MS) {
      return tooFrequent
    }
  }
  return { ok: true, next: fires[0] }
}

/** Due rows read per tick — a window wide enough that one account's
 *  backlog can't hide everyone else's due rows. */
const DUE_FETCH_LIMIT = 500
/** Fires per tick, across all users. */
const TICK_MAX_FIRES = 50
/** Fires per tick for any one user. */
const TICK_MAX_FIRES_PER_USER = 5

/**
 * Pick this tick's batch fairly: round-robin across users (each user's
 * rows in the order given — earliest `next_run_at` first), at most
 * `maxPerUser` per user and `maxTotal` overall. Users are visited in
 * order of their earliest due row, so a backlog drains oldest-first
 * without one account taking the whole batch. Pure.
 */
export function pickFairBatch<T extends { user_id: string }>(
  rows: readonly T[],
  opts: { maxTotal: number; maxPerUser: number }
): T[] {
  const byUser = new Map<string, T[]>()
  for (const row of rows) {
    const list = byUser.get(row.user_id)
    if (list) list.push(row)
    else byUser.set(row.user_id, [row])
  }
  const picked: T[] = []
  for (let round = 0; round < opts.maxPerUser; round++) {
    let progressed = false
    for (const list of byUser.values()) {
      if (picked.length >= opts.maxTotal) return picked
      if (round < list.length) {
        picked.push(list[round])
        progressed = true
      }
    }
    if (!progressed) break
  }
  return picked
}

/**
 * Walk the ready set and fire a fair batch of it (`pickFairBatch`).
 * Returns the count actually enqueued (some rows may have been deleted
 * between select and update, or deferred by the minimum-gap throttle).
 * Uses the service-role client — the tick runs without a user session.
 */
export async function dispatchDueSchedules(db: DB): Promise<number> {
  const now = new Date()
  const { data, error } = await db
    .from("task_schedules")
    .select("*")
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(DUE_FETCH_LIMIT)
  if (error) {
    throw new Error(`dispatchDueSchedules: ${error.message}`)
  }
  if (!data || data.length === 0) return 0

  // Fair share: one account's pile of due rows can't fill the tick and
  // starve everyone else. Rows not picked stay due for the next tick.
  const batch = pickFairBatch(data, {
    maxTotal: TICK_MAX_FIRES,
    maxPerUser: TICK_MAX_FIRES_PER_USER,
  })

  let fired = 0
  for (const row of batch) {
    // Minimum gap since the last fire, whatever the cron says (a legacy
    // row, or `next_run_at` reset by a direct PostgREST write). Defer
    // the row to the end of the gap instead of firing; the guarded
    // update keeps a racing tick from doing the same twice.
    const lastRunMs = row.last_run_at ? Date.parse(row.last_run_at) : NaN
    if (
      Number.isFinite(lastRunMs) &&
      now.getTime() - lastRunMs < SCHEDULE_DISPATCH_MIN_GAP_MS
    ) {
      await db
        .from("task_schedules")
        .update({
          next_run_at: new Date(lastRunMs + SCHEDULE_DISPATCH_MIN_GAP_MS).toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("id", row.id)
        .eq("user_id", row.user_id)
        .eq("next_run_at", row.next_run_at)
      continue
    }

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
