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
import type { Database, Json } from "@/shared/supabase/types"
import type { RunCheckpoint } from "./checkpoint"
import { rowsToTaskEvents, taskEventToRow } from "@/shared/agent/persistence"

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

/**
 * Persist the run state at the start of a run. Stored in
 * `tasks.checkpoint` as JSONB; the dedicated agent service loads it
 * via its own checkpoint reader to seed the runner. Called by
 * `POST /api/tasks` for the initial checkpoint and by
 * `lib/server/agent/schedules.ts` for scheduled fires.
 */
export async function saveCheckpoint(
  db: DB,
  runId: string,
  userId: string,
  checkpoint: RunCheckpoint
): Promise<void> {
  const { error } = await db
    .from("tasks")
    .update({
      checkpoint: checkpoint as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("user_id", userId)
  if (error) throw new Error(`saveCheckpoint: ${error.message}`)
}

/** Latest event row for a run (highest seq), or null. Used both to
 *  compute the next seq for a synthetic event and to judge liveness. */
async function latestEvent(
  db: DB,
  runId: string,
  userId: string
): Promise<{ seq: number; step: number; createdAt: string } | null> {
  const { data, error } = await db
    .from("task_events")
    .select("seq,step,created_at")
    .eq("task_id", runId)
    .eq("user_id", userId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return { seq: data.seq, step: data.step, createdAt: data.created_at }
}

/**
 * Append a terminal `result` event out-of-band and settle the run — used
 * to fail an orphaned run (the producer died without a terminal event).
 * Seq follows the last event so resume replays it; idempotent via the
 * (task_id, seq) unique index.
 */
export async function appendSyntheticResult(
  db: DB,
  runId: string,
  userId: string,
  opts: { status: "done" | "failed"; error?: string }
): Promise<void> {
  const last = await latestEvent(db, runId, userId)
  const event: TaskEvent = {
    runId,
    seq: (last?.seq ?? 0) + 1,
    step: last?.step ?? 0,
    createdAt: new Date().toISOString(),
    kind: "result",
    status: opts.status,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  }
  await appendEvent(db, event, userId)
  await updateRun(db, runId, userId, { status: opts.status, finished: true })
}

/** Cancel all not-yet-settled children of a cancelled parent task. */
export async function cancelChildTasks(
  db: DB,
  parentId: string,
  userId: string
): Promise<void> {
  const { error } = await db
    .from("tasks")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("parent_task_id", parentId)
    .eq("user_id", userId)
    .not("status", "in", "(done,failed,cancelled)")
  if (error) throw new Error(`cancelChildTasks: ${error.message}`)
}

/**
 * Fail this user's orphaned runs: any `queued`/`running` row whose most
 * recent activity (latest event, else `started_at`) is older than
 * `olderThanMs`. Liveness is judged by event recency — a live run emits
 * events continuously (coalesced tokens, step boundaries), so this only
 * catches genuinely dead runs (function killed mid-stream). RLS-scoped
 * to `userId`; returns how many were reconciled.
 */
export async function reconcileStaleRuns(
  db: DB,
  userId: string,
  olderThanMs = 180_000
): Promise<number> {
  const { data, error } = await db
    .from("tasks")
    .select("id,started_at")
    .eq("user_id", userId)
    .in("status", ["queued", "running"])
  if (error) throw new Error(`reconcileStaleRuns: ${error.message}`)
  const now = Date.now()
  let failed = 0
  for (const row of data ?? []) {
    const last = await latestEvent(db, row.id, userId)
    const ref = last?.createdAt ?? row.started_at
    if (!ref || now - new Date(ref).getTime() <= olderThanMs) continue
    await appendSyntheticResult(db, row.id, userId, {
      status: "failed",
      error: "Task stopped unexpectedly (no recent activity).",
    })
    failed += 1
  }
  return failed
}
