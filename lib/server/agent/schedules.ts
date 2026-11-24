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

/** What a schedule runs with when it never chose: every skill agent-py's
 *  executor has a tool for (each still needs its provider configured). */
const UNSET_SCHEDULE_SKILLS: NonNullable<RunCheckpoint["config"]["skills"]> = [
  { id: "webSearch" },
  { id: "webFetch" },
  { id: "searchFiles" },
  { id: "imageGen" },
]

/**
 * A schedule's `config.skills`. The executor offers only the skills listed
 * there, and the schedule editor doesn't set any, so unset (`null`) is
 * spelled out as all of them; an explicit `[]` stays none. Mirrored by
 * agent-py's `schedules.schedule_skills`.
 */
export function scheduleSkills(
  skills: Json | null
): NonNullable<RunCheckpoint["config"]["skills"]> {
  return skills === null
    ? UNSET_SCHEDULE_SKILLS
    : (skills as NonNullable<RunCheckpoint["config"]["skills"]>)
}

/**
 * The model a schedule saved without one gets (Q67, Q73, Q80). Mirrored by
 * agent-py's `schedules.SCHEDULE_DEFAULT_MODEL`. Nothing picks one at fire
 * time: a fire without a model fails "no model" (Q56).
 */
export const SCHEDULE_DEFAULT_MODEL = "anthropic/claude-haiku-4.5"

/**
 * The `model` a create or update stores: the given one, else Haiku for a
 * schedule that is (or stays, or becomes) enabled — creating one, or
 * re-enabling one, that has no model. A disabled schedule may keep none
 * (it never fires). Mirrored by agent-py's `schedule_model_on_save`.
 */
export function scheduleModelOnSave(
  model: string | null | undefined,
  enabled: boolean
): string | null {
  if ((model ?? null) === null && enabled) return SCHEDULE_DEFAULT_MODEL
  return model ?? null
}

/** What one fire writes: the conversation's title, then
 *  `public.create_scheduled_task`'s goal, step budget and checkpoint (0047).
 *  Mirrored by agent-py's `scheduled_fire_for`; the parity fixture
 *  `services/agent-py/tests/fixtures/schedule_fire_parity.json` pins both. */
export interface ScheduledFire {
  conversationTitle: string
  goal: string
  maxSteps: number
  checkpoint: RunCheckpoint
}

export function scheduledFireFor(
  row: Pick<
    ScheduleRow,
    "name" | "prompt" | "model" | "system_prompt" | "workspace_id" | "skills" | "max_steps"
  >
): ScheduledFire {
  const maxSteps = row.max_steps ?? 25
  const messages: ModelMessage[] = [{ role: "user", content: row.prompt }]
  return {
    conversationTitle: `Scheduled: ${row.name}`,
    goal: row.prompt.slice(0, 2000),
    maxSteps,
    checkpoint: {
      messages,
      step: 0,
      seq: 1,
      config: {
        // No default at fire time (Q56): without a model the worker fails
        // it "no model". The routes store Haiku when it is saved (Q73).
        model: row.model ?? "",
        ...(row.system_prompt !== null ? { workspaceSystemPrompt: row.system_prompt } : {}),
        workspaceId: row.workspace_id,
        skills: scheduleSkills(row.skills),
        maxSteps,
      },
    },
  }
}

/**
 * Set up a fresh run from a schedule row: one new conversation per fire
 * (Q80; the result is delivered into it), then the task through
 * `public.create_scheduled_task` (0047) — the task, its checkpoint, the
 * `status: queued` entry and the `start` job under the user's task lock,
 * or, at the 5-task cap (Q79), the task already failed `limit_reached`, so
 * the fire still shows in the task list. Then stamp the schedule's
 * `last_run_task_id` so the UI can deep-link to the result.
 */
async function fireSchedule(db: DB, row: ScheduleRow): Promise<void> {
  const userId = row.user_id
  const runId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const fire = scheduledFireFor(row)

  const convInsert = await db.from("conversations").insert({
    id: conversationId,
    user_id: userId,
    workspace_id: row.workspace_id,
    title: fire.conversationTitle,
  })
  if (convInsert.error) {
    throw new Error(`conversation insert: ${convInsert.error.message}`)
  }

  const created = await db.rpc("create_scheduled_task", {
    p_id: runId,
    p_user_id: userId,
    p_conversation_id: conversationId,
    p_goal: fire.goal,
    p_max_steps: fire.maxSteps,
    p_checkpoint: fire.checkpoint as unknown as Json,
  })
  if (created.error) {
    throw new Error(`create_scheduled_task: ${created.error.message}`)
  }

  // Record which task this fire produced so the UI can link to it.
  await db
    .from("task_schedules")
    .update({ last_run_task_id: runId })
    .eq("id", row.id)
    .eq("user_id", userId)
}
