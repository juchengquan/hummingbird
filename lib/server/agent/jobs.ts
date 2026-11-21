import "server-only"

/**
 * Enqueue side of the `task_jobs` queue. The user-facing routes
 * (`/api/tasks` POST, `/api/tasks/:id/respond`) and the schedule tick
 * call these helpers to write new rows, via the `enqueue_task_job` RPC
 * (`./task-writes.ts`). `userId` is kept on the inputs for call-site
 * symmetry; the RPC derives the job's owner from the task row. Claim / settle / release happen elsewhere
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

import { enqueueTaskJob } from "./task-writes"

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
  await enqueue(db, input.taskId, "start", {})
}

/** Insert a `respond` job. The payload carries the human's answer; the
 *  service worker pairs it with the pending tool call in the checkpoint.
 *  `uiAnswer` is the generative-UI structured answer (commit 3a of
 *  PLAN-generative-ui-parts.md) — the agent-py poller parses it off the
 *  jsonb payload and surfaces it on `RespondActionPayload.ui_answer`. */
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
      uiAnswer?: unknown
      args?: unknown
    }
  }
): Promise<void> {
  await enqueue(db, input.taskId, "respond", input.payload as unknown as Json)
}

async function enqueue(
  db: DB,
  taskId: string,
  action: JobAction,
  payload: Json
): Promise<void> {
  // Since migration 0034 the API roles can't INSERT `task_jobs`; the
  // SECURITY DEFINER RPC pins status / attempts / scheduled_at and
  // derives `user_id` from the task. Throws `TaskWriteError` (SQLSTATE
  // kept) so routes can map a 404 / 409 instead of a blanket 500.
  await enqueueTaskJob(db, { taskId, action, payload })
}
