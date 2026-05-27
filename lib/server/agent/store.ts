import "server-only"

/**
 * RunStore — the Supabase-backed persistence for agent runs
 * (`tasks` + `task_events`, migration `0012`). Thin wrappers over the
 * typed client; the IR↔row mapping logic lives in `./persistence.ts`
 * (and is unit-tested there). All queries are `user_id`-scoped on top
 * of the own-your-rows RLS — defense in depth.
 *
 * `appendEvent` is idempotent on `(task_id, seq)` so a retried emit
 * (or an overlapping replay) is a no-op rather than a duplicate.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { TaskEvent, RunStatus } from "@/shared/agent/events"
import type { Database } from "@/shared/supabase/types"
import { rowsToTaskEvents, taskEventToRow } from "./persistence"

type DB = SupabaseClient<Database>
export type TaskRow = Database["public"]["Tables"]["tasks"]["Row"]

export interface CreateRunInput {
  id: string
  userId: string
  conversationId: string
  goal: string
  maxSteps: number
}

export async function createRun(db: DB, input: CreateRunInput): Promise<void> {
  const { error } = await db.from("tasks").insert({
    id: input.id,
    user_id: input.userId,
    conversation_id: input.conversationId,
    goal: input.goal,
    status: "queued",
    step: 0,
    max_steps: input.maxSteps,
    started_at: new Date().toISOString(),
  })
  if (error) throw new Error(`createRun: ${error.message}`)
}

export async function getRun(
  db: DB,
  runId: string,
  userId: string
): Promise<TaskRow | null> {
  const { data, error } = await db
    .from("tasks")
    .select("*")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`getRun: ${error.message}`)
  return data ?? null
}

export interface UpdateRunPatch {
  status?: RunStatus
  step?: number
  resultMessageId?: string | null
  finished?: boolean
}

export async function updateRun(
  db: DB,
  runId: string,
  userId: string,
  patch: UpdateRunPatch
): Promise<void> {
  const row: Database["public"]["Tables"]["tasks"]["Update"] = {
    updated_at: new Date().toISOString(),
  }
  if (patch.status !== undefined) row.status = patch.status
  if (patch.step !== undefined) row.step = patch.step
  if (patch.resultMessageId !== undefined)
    row.result_message_id = patch.resultMessageId
  if (patch.finished) row.finished_at = new Date().toISOString()
  const { error } = await db
    .from("tasks")
    .update(row)
    .eq("id", runId)
    .eq("user_id", userId)
  if (error) throw new Error(`updateRun: ${error.message}`)
}

/** Append one event. Idempotent on the (task_id, seq) unique index —
 *  a duplicate seq is silently ignored. */
export async function appendEvent(
  db: DB,
  event: TaskEvent,
  userId: string
): Promise<void> {
  const { error } = await db
    .from("task_events")
    .upsert(taskEventToRow(event, userId), {
      onConflict: "task_id,seq",
      ignoreDuplicates: true,
    })
  if (error) throw new Error(`appendEvent: ${error.message}`)
}

/** Replay events with `seq > sinceSeq`, ascending — the resume read. */
export async function listEventsSince(
  db: DB,
  runId: string,
  userId: string,
  sinceSeq: number
): Promise<TaskEvent[]> {
  const { data, error } = await db
    .from("task_events")
    .select("task_id,seq,step,kind,payload,created_at")
    .eq("task_id", runId)
    .eq("user_id", userId)
    .gt("seq", sinceSeq)
    .order("seq", { ascending: true })
  if (error) throw new Error(`listEventsSince: ${error.message}`)
  return rowsToTaskEvents(data ?? [])
}

/** Cheap cancel probe the runner polls between steps. */
export async function isRunCancelled(
  db: DB,
  runId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("tasks")
    .select("status")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) return false // a probe failure shouldn't kill the run
  return data?.status === "cancelled"
}
