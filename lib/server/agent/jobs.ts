import "server-only"

/**
 * Enqueue side of the `task_jobs` queue. The user-facing routes
 * (`/api/tasks` POST, `/api/tasks/:id/respond`) call these helpers
 * to write new rows. Claim / settle / release happen elsewhere
 * now — the dedicated agent services own that path through their
 * own `postgres`-driver implementations:
 *   - `services/agent-py/src/agent_py/jobs.py` (asyncpg)
 *   - `services/agent-ts/src/jobs.ts` (postgres driver)
 *
 * The old in-Next-process worker (`claimNextJob` / `markJobDone` /
 * `markJobFailed` / `enqueueContinueJob`) was deleted alongside
 * `worker.ts` — the Supabase-JS path couldn't open a real
 * transaction and so couldn't actually hold `FOR UPDATE SKIP
 * LOCKED` semantics. The dedicated services have the right
 * primitives and have shipped them.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database, Json } from "@/shared/supabase/types"

type DB = SupabaseClient<Database>

export type JobAction = "start" | "respond" | "continue"

export type JobStatus = "queued" | "running" | "done" | "failed"

/** Insert a `start` job. The route writes the initial checkpoint
 *  before calling this — the service worker reads everything it
 *  needs from there, so no per-job payload. */
export async function enqueueStartJob(
  db: DB,
  input: { taskId: string; userId: string }
): Promise<void> {
  await enqueue(db, input.taskId, input.userId, "start", {})
}

/** Insert a `respond` job. The payload carries the human's answer; the
 *  service worker pairs it with the pending tool call in the checkpoint. */
export async function enqueueRespondJob(
  db: DB,
  input: {
    taskId: string
    userId: string
    payload: {
      requestId: string
      approved?: boolean
      selection?: string[]
      value?: string
      args?: unknown
    }
  }
): Promise<void> {
  await enqueue(db, input.taskId, input.userId, "respond", input.payload as unknown as Json)
}

async function enqueue(
  db: DB,
  taskId: string,
  userId: string,
  action: JobAction,
  payload: Json,
  delayMs?: number
): Promise<void> {
  const scheduledAt = new Date(Date.now() + (delayMs ?? 0)).toISOString()
  const { error } = await db.from("task_jobs").insert({
    task_id: taskId,
    user_id: userId,
    action,
    payload,
    status: "queued",
    scheduled_at: scheduledAt,
  })
  if (error) throw new Error(`enqueue ${action}: ${error.message}`)
}
