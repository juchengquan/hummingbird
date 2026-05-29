import "server-only"

/**
 * The queue half of the task-queue plan (`PLAN-agent-task-queue.md`).
 * Each `task_jobs` row is one chunk of work for the background worker
 * (`./worker.ts`). v1 only the `continue` action is implemented — it
 * lets a run survive the serverless execution cap by checkpointing
 * mid-loop and re-enqueueing itself. `start` and `respond` actions are
 * reserved for later phases.
 *
 * The user-facing routes (`/api/tasks`, `/api/tasks/:id/respond`) call
 * `enqueueContinueJob` when `runAgentLoop` yields. The worker process
 * (or a Vercel cron tick) calls `claimNextJob` and dispatches.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database, Json } from "@/shared/supabase/types"

type DB = SupabaseClient<Database>
type JobRow = Database["public"]["Tables"]["task_jobs"]["Row"]

export type JobAction = "start" | "respond" | "continue"

export type JobStatus = "queued" | "running" | "done" | "failed"

export interface ClaimedJob {
  id: string
  taskId: string
  userId: string
  action: JobAction
  payload: Json
  attempts: number
  maxAttempts: number
}

/** Insert a `continue` job for `taskId`. v1 carries no payload — the
 *  worker reads the task's checkpoint to figure out where to pick up. */
export async function enqueueContinueJob(
  db: DB,
  input: { taskId: string; userId: string; delayMs?: number }
): Promise<void> {
  const scheduledAt = new Date(Date.now() + (input.delayMs ?? 0)).toISOString()
  const { error } = await db.from("task_jobs").insert({
    task_id: input.taskId,
    user_id: input.userId,
    action: "continue",
    payload: {} as Json,
    status: "queued",
    scheduled_at: scheduledAt,
  })
  if (error) throw new Error(`enqueueContinueJob: ${error.message}`)
}

/**
 * Atomically claim the next ready job. Returns `null` when the queue
 * is empty or someone else won the race for the candidate — the caller
 * should sleep briefly and try again.
 *
 * `db` should be the **service-role** client; user-scoped RLS would
 * limit the worker to one user's jobs, which isn't what we want.
 */
export async function claimNextJob(db: DB): Promise<ClaimedJob | null> {
  const { data: candidate, error: selectErr } = await db
    .from("task_jobs")
    .select("*")
    .eq("status", "queued")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (selectErr) throw new Error(`claimNextJob (select): ${selectErr.message}`)
  if (!candidate) return null

  // Guarded update: another worker may have taken the row between the
  // select and update; the `eq('status','queued')` predicate means our
  // update affects 0 rows in that case and `.maybeSingle()` returns null.
  const { data: claimed, error: updateErr } = await db
    .from("task_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      attempts: candidate.attempts + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select()
    .maybeSingle()
  if (updateErr) throw new Error(`claimNextJob (claim): ${updateErr.message}`)
  if (!claimed) return null
  return rowToClaimed(claimed)
}

export async function markJobDone(db: DB, jobId: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await db
    .from("task_jobs")
    .update({ status: "done", finished_at: now, updated_at: now })
    .eq("id", jobId)
  if (error) throw new Error(`markJobDone: ${error.message}`)
}

/**
 * On retryable failure: leave `status='queued'` and push `scheduled_at`
 * out by a backoff. On terminal failure (max attempts reached, or
 * caller forces it): set `status='failed'` so the worker stops
 * touching the row. The latest error always lands in `error`.
 */
export async function markJobFailed(
  db: DB,
  job: ClaimedJob,
  error: { message: string; code?: string },
  opts?: { retryable?: boolean }
): Promise<void> {
  const now = new Date().toISOString()
  const retryable = opts?.retryable ?? true
  const exhausted = job.attempts >= job.maxAttempts
  const final = !retryable || exhausted

  // 2^attempts seconds, capped at 5 min. Plenty of room for transient
  // gateway 5xx / connection blips.
  const backoffMs = Math.min(5 * 60_000, 1000 * 2 ** job.attempts)
  const scheduledAt = new Date(Date.now() + backoffMs).toISOString()

  const patch = final
    ? {
        status: "failed" as const,
        finished_at: now,
        error: error as unknown as Json,
        updated_at: now,
      }
    : {
        status: "queued" as const,
        started_at: null,
        scheduled_at: scheduledAt,
        error: error as unknown as Json,
        updated_at: now,
      }
  const { error: updateErr } = await db
    .from("task_jobs")
    .update(patch)
    .eq("id", job.id)
  if (updateErr) throw new Error(`markJobFailed: ${updateErr.message}`)
}

function rowToClaimed(row: JobRow): ClaimedJob {
  const action = row.action as JobAction
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    action,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }
}
