import "server-only"

/**
 * The API-side write paths into the agent worker tables. Since
 * migration 0034 the `anon` / `authenticated` roles can no longer
 * INSERT `tasks` or write `task_jobs` directly — PostgREST callers would
 * otherwise set `status`, `attempts`, `scheduled_at`, `checkpoint`, …
 * to anything. Both writes go through SECURITY DEFINER RPCs that pin
 * the worker-owned columns and check ownership + state:
 *
 *   - `create_task_run`  — new queued run + its initial checkpoint.
 *   - `enqueue_task_job` — new queued job (user callers: `start` on a
 *     queued, never-started task; `respond` with the one answer to the
 *     question a paused one waits on, 0045; the service-role client may
 *     also enqueue for any task).
 *   - `cancel_task` — cancel the whole task, or skip one child (0045).
 *
 * Errors carry the Postgres SQLSTATE so routes can answer with a
 * meaningful status (`taskWriteErrorResponse`) instead of a blanket 500.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database, Json } from "@/shared/supabase/types"

import type { RunCheckpoint } from "./checkpoint"

type DB = SupabaseClient<Database>

export type TaskJobAction = "start" | "respond" | "continue"

/** The 5-task cap's answer (Q72, Q79; hint `task_cap`, 0050). Word for word
 *  agent-py's `TASK_CAP_MESSAGE` (task-writes.test.ts checks). */
export const TASK_CAP_MESSAGE = "5 tasks are already active. Finish or cancel one, then start this one again."

/** A full job queue's answer (20 queued jobs; hint `job_queue`, 0050).
 *  Word for word agent-py's `JOB_QUEUE_FULL_MESSAGE`. */
export const JOB_QUEUE_FULL_MESSAGE = "Too many queued jobs (20 per user). Wait for some to start, then try again."

/** 54000's hint (0050, Q88) → the sentence a user reads. */
const LIMIT_MESSAGES: Record<string, string> = {
  task_cap: TASK_CAP_MESSAGE,
  job_queue: JOB_QUEUE_FULL_MESSAGE,
}

/** A failed task-table RPC, keeping the SQLSTATE the function raised and
 *  its hint (0050 tags which limit a 54000 met). */
export class TaskWriteError extends Error {
  readonly sqlState: string | undefined
  readonly hint: string | undefined

  constructor(message: string, sqlState?: string, hint?: string) {
    super(message)
    this.name = "TaskWriteError"
    this.sqlState = sqlState
    this.hint = hint || undefined
  }
}

/** SQLSTATEs the task RPCs / guard triggers raise on purpose (0034,
 *  0035, 0045) → the HTTP answer a route should give. Anything else is left
 *  to the route's generic error categorisation. */
const SQLSTATE_RESPONSES: Record<string, { status: number; code: string }> = {
  "42501": { status: 403, code: "forbidden" },
  P0002: { status: 404, code: "not_found" },
  "22023": { status: 400, code: "invalid_request" },
  "55000": { status: 409, code: "invalid_state" },
  "54000": { status: 409, code: "limit_reached" },
}

/** Map a task-write failure (a `TaskWriteError`, or a raw PostgREST
 *  error object carrying `code`) to `{ status, code, message }`, or
 *  `null` when it isn't one of the deliberate RPC/trigger errors. */
export function taskWriteErrorResponse(
  error: unknown
): { status: number; code: string; message: string } | null {
  if (!error || typeof error !== "object") return null
  const sqlState =
    error instanceof TaskWriteError
      ? error.sqlState
      : typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined
  if (!sqlState) return null
  const mapped = SQLSTATE_RESPONSES[sqlState]
  if (!mapped) return null
  const hint = typeof (error as { hint?: unknown }).hint === "string" ? (error as { hint: string }).hint : undefined
  const message =
    (sqlState === "54000" && hint ? LIMIT_MESSAGES[hint] : undefined) ??
    (typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Request rejected.")
  return { ...mapped, message }
}

export interface CreateTaskRunInput {
  id: string
  conversationId: string
  goal: string
  maxSteps: number
  checkpoint: RunCheckpoint
}

/** Create a queued run + its initial checkpoint in one statement. The
 *  owner is the caller's JWT (`auth.uid()`); the RPC rejects a
 *  conversation the caller doesn't own (P0002) and a `maxSteps` outside
 *  1..50 (22023), and overwrites `checkpoint.config.maxSteps` with the
 *  validated value. */
export async function createTaskRun(db: DB, input: CreateTaskRunInput): Promise<void> {
  const { error } = await db.rpc("create_task_run", {
    p_id: input.id,
    p_conversation_id: input.conversationId,
    p_goal: input.goal,
    p_max_steps: input.maxSteps,
    p_checkpoint: input.checkpoint as unknown as Json,
  })
  if (error) {
    throw new TaskWriteError(`createTaskRun: ${error.message}`, error.code, error.hint)
  }
}

/** Cancel through `cancel_task` (0045, Q60): a top-level task with its
 *  whole chain of answers and their children, a child alone (its parent
 *  continues). Idempotent; P0002 when it isn't the caller's. */
export async function cancelTask(db: DB, taskId: string): Promise<void> {
  const { error } = await db.rpc("cancel_task", { p_task_id: taskId })
  if (error) {
    throw new TaskWriteError(`cancel task: ${error.message}`, error.code, error.hint)
  }
}

/** Enqueue a job through `enqueue_task_job`; returns the new job id. */
export async function enqueueTaskJob(
  db: DB,
  input: {
    taskId: string
    action: TaskJobAction
    payload?: Json
    /** Earliest run time; the RPC clamps it to [now, now + 1 day]. */
    scheduledAt?: Date
  }
): Promise<string> {
  const { data, error } = await db.rpc("enqueue_task_job", {
    p_task_id: input.taskId,
    p_action: input.action,
    p_payload: input.payload ?? {},
    ...(input.scheduledAt ? { p_scheduled_at: input.scheduledAt.toISOString() } : {}),
  })
  if (error) {
    throw new TaskWriteError(`enqueue ${input.action}: ${error.message}`, error.code, error.hint)
  }
  return data as string
}
