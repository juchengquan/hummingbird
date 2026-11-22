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
 *
 * Background runs only. Since migration 0041 a `tasks` row is also an
 * interactive run of the runs API (`mode = 'interactive'`, executed in
 * agent-py's API process, never queued — PLAN-frontend-backend-split
 * Q27/Q28). The task routes built on this module must behave exactly as
 * before, so every read and update here is scoped to `BACKGROUND`: an
 * interactive run is invisible to them (404 from the routes, never
 * reconciled, never listed as a child, never cancelled by a cascade —
 * `cancel_task`'s tree is background runs only).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { TaskEvent, RunStatus } from "@/shared/agent/events"
import type { Database, Json } from "@/shared/supabase/types"
import type { RunCheckpoint } from "./checkpoint"
import { rowsToTaskEvents, taskEventToRow } from "@/shared/agent/persistence"

type DB = SupabaseClient<Database>
export type TaskRow = Database["public"]["Tables"]["tasks"]["Row"]

/** The only `tasks.mode` the task routes see (migration 0041). */
const BACKGROUND = "background"

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
    mode: BACKGROUND,
    thread_id: input.conversationId,
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
    .eq("mode", BACKGROUND)
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
    .eq("mode", BACKGROUND)
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
    .eq("mode", BACKGROUND)
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

/** Statuses an orphaned run can be settled from. Never `paused` (the run
 *  is legitimately waiting on the user / its subagents) and never a
 *  terminal status (settled already — don't overwrite it). */
const SETTLEABLE_STATUSES = ["queued", "running"] as const

/**
 * Settle an orphaned run (the producer died without a terminal event)
 * and append its terminal `result` event out-of-band.
 *
 * The status flip is conditional on the run still being queued/running
 * (or `from`, narrower: a failed enqueue settles only a still queued run),
 * so a run that settled concurrently (or was cancelled) is never
 * overwritten — and only when the flip actually happened is the event
 * appended, so it can't gain a stray second `result`. Seq follows the
 * last event so resume replays it; idempotent via the (task_id, seq)
 * unique index. Returns whether this call settled the run.
 */
export async function appendSyntheticResult(
  db: DB,
  runId: string,
  userId: string,
  opts: {
    status: "done" | "failed"
    error?: string
    from?: readonly (typeof SETTLEABLE_STATUSES)[number][]
  }
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from("tasks")
    .update({ status: opts.status, finished_at: nowIso, updated_at: nowIso })
    .eq("id", runId)
    .eq("user_id", userId)
    .eq("mode", BACKGROUND)
    .in("status", [...(opts.from ?? SETTLEABLE_STATUSES)])
    .select("id")
  if (error) throw new Error(`appendSyntheticResult: ${error.message}`)
  if (!data || data.length === 0) return false

  const last = await latestEvent(db, runId, userId)
  const event: TaskEvent = {
    runId,
    seq: (last?.seq ?? 0) + 1,
    step: last?.step ?? 0,
    createdAt: nowIso,
    kind: "result",
    status: opts.status,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  }
  await appendEvent(db, event, userId)
  return true
}

/**
 * Whether some worker still owns (or will pick up) this run: a job that
 * is `queued` with attempts left, or `running` under an unexpired lease
 * (`task_jobs.lease_expires_at`, migration 0032 — the agent service
 * heartbeats it while a step runs, however long the step takes). A job
 * whose lease lapsed belongs to a dead worker; failed/done jobs drive
 * nothing. A read error counts as live — never fail a run on a guess.
 */
async function hasLiveJob(
  db: DB,
  runId: string,
  userId: string,
  nowMs: number
): Promise<boolean> {
  const { data, error } = await db
    .from("task_jobs")
    .select("status,lease_expires_at,attempts,max_attempts")
    .eq("task_id", runId)
    .eq("user_id", userId)
    .in("status", ["queued", "running"])
  if (error) return true
  return (data ?? []).some((job) => {
    if (job.status === "queued") return job.attempts < job.max_attempts
    const lease = job.lease_expires_at ? Date.parse(job.lease_expires_at) : NaN
    return Number.isFinite(lease) && lease > nowMs
  })
}

/** List a task's child subagent tasks (status + goal), RLS-scoped. */
export async function listTaskChildren(
  db: DB,
  parentId: string,
  userId: string
): Promise<{ id: string; status: string; goal: string }[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, status, goal")
    .eq("parent_task_id", parentId)
    .eq("user_id", userId)
    .eq("mode", BACKGROUND)
    .order("created_at", { ascending: true })
  if (error) throw new Error(`listTaskChildren: ${error.message}`)
  // `goal` is NOT NULL on background rows (0041's tasks_run_shape_check);
  // the column type is nullable only because interactive runs have none.
  return (data ?? []).map((c) => ({ ...c, goal: c.goal ?? "" }))
}

const QUESTION_KINDS = ["approval", "choice", "input", "ui-part"] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

function questionKind(raw: unknown): QuestionKind {
  return QUESTION_KINDS.find((kind) => kind === raw) ?? "approval"
}

/**
 * What kind of question `requestId` is on a paused run: from the row's
 * open interrupts (`outcome`, written with the pause), or for a run
 * paused before 0045 from its request entry in the log. Null when the
 * run doesn't ask it (`enqueue_task_job` then refuses the answer).
 */
export async function getQuestionKind(
  db: DB,
  run: Pick<TaskRow, "id" | "outcome">,
  userId: string,
  requestId: string
): Promise<QuestionKind | null> {
  const outcome = run.outcome as {
    type?: unknown
    interrupts?: Array<{ id?: unknown; reason?: unknown }>
  } | null
  if (outcome?.type === "interrupt" && Array.isArray(outcome.interrupts)) {
    const open = outcome.interrupts.find((interrupt) => interrupt?.id === requestId)
    return open ? questionKind(open.reason) : null
  }
  const { data, error } = await db
    .from("task_events")
    .select("payload")
    .eq("task_id", run.id)
    .eq("user_id", userId)
    .eq("kind", "approval")
    .eq("payload->>phase", "request")
    .eq("payload->>approvalId", requestId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`getQuestionKind: ${error.message}`)
  if (!data) return null
  return questionKind((data.payload as { requestKind?: unknown } | null)?.requestKind)
}

/**
 * Whether a worker holds this run's job right now (`running` under an
 * unexpired lease). Unlike `hasLiveJob`, a `queued` job doesn't count —
 * used for runs no worker ever started, where a queued job that nobody
 * claimed is exactly the problem. A read error counts as held.
 */
async function hasLeasedJob(
  db: DB,
  runId: string,
  userId: string,
  nowMs: number
): Promise<boolean> {
  const { data, error } = await db
    .from("task_jobs")
    .select("status,lease_expires_at,attempts,max_attempts")
    .eq("task_id", runId)
    .eq("user_id", userId)
    .in("status", ["running"])
  if (error) return true
  return (data ?? []).some((job) => {
    const lease = job.lease_expires_at ? Date.parse(job.lease_expires_at) : NaN
    return Number.isFinite(lease) && lease > nowMs
  })
}

/** Default for how long a never-started run may wait for a worker. */
export const DEFAULT_NO_WORKER_TIMEOUT_MS = 10 * 60_000

/** `TASK_NO_WORKER_TIMEOUT_MINUTES` (positive number) → ms, else the default. */
export function noWorkerTimeoutMs(
  raw: string | undefined = process.env.TASK_NO_WORKER_TIMEOUT_MINUTES
): number {
  const minutes = raw === undefined || raw.trim() === "" ? NaN : Number(raw)
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DEFAULT_NO_WORKER_TIMEOUT_MS
}

/**
 * Whether ANY task worker has executed something within `withinMs`
 * (a live lease, or a job it finished) — `task_worker_active_within`,
 * migration 0040. A never-started run is only "orphaned" when this is
 * false: with one busy worker a backlog can wait past the timeout while
 * the worker is healthy. A read error counts as active (never fail a
 * run on a probe error).
 */
async function taskWorkerActiveWithin(db: DB, withinMs: number): Promise<boolean> {
  const { data, error } = await db.rpc("task_worker_active_within", {
    p_seconds: Math.max(0, Math.ceil(withinMs / 1000)),
  })
  if (error) return true
  return data === true
}

export const NO_WORKER_ERROR =
  "No task worker available: this task was never picked up. Try again later, or contact the administrator if it keeps happening."

/** The route's `status: queued` marker is seq 1; a worker's first event
 *  (its `status: running`) is seq 2. */
const LAST_PRE_START_SEQ = 1

/**
 * Fail this user's orphaned runs. Two cases:
 *
 * - **Never started** — `queued`, nothing past the route's `status:
 *   queued` marker, created more than `noWorkerMs` ago, and no worker
 *   holding a lease on its job, AND no worker has executed anything in
 *   that window (`task_worker_active_within`, migration 0040): agent-py
 *   is down or left in dry-run. A busy worker with a backlog keeps the
 *   run waiting rather than failing it. (Opted-out users never get
 *   here: agent-py fails their jobs up front.) Failed with
 *   `NO_WORKER_ERROR`.
 * - **Stalled** — a started `queued`/`running` row that
 *   1. has had no activity (latest event, else `started_at`) for
 *      `olderThanMs`, AND
 *   2. has no live job — nothing queued for it and no worker holding an
 *      unexpired lease on it.
 *   Event recency alone isn't proof of death: one long step (extended
 *   reasoning, a sandbox run) can go minutes without an event while its
 *   worker heartbeats the job lease. The lease is the liveness signal;
 *   the inactivity window just keeps this cheap and covers runs with no
 *   job.
 *
 * Settling is conditional on the run still being queued/running, so it
 * never overwrites a terminal status. RLS-scoped to `userId`; returns
 * how many were reconciled.
 */
export async function reconcileStaleRuns(
  db: DB,
  userId: string,
  olderThanMs = 180_000,
  nowMs: number = Date.now(),
  noWorkerMs: number = noWorkerTimeoutMs()
): Promise<number> {
  const { data, error } = await db
    .from("tasks")
    .select("id,status,started_at,created_at")
    .eq("user_id", userId)
    .eq("mode", BACKGROUND)
    .in("status", [...SETTLEABLE_STATUSES])
  if (error) throw new Error(`reconcileStaleRuns: ${error.message}`)
  let failed = 0
  let workerActive: boolean | undefined
  for (const row of data ?? []) {
    const last = await latestEvent(db, row.id, userId)
    let settleError: string
    if (row.status === "queued" && (last?.seq ?? 0) <= LAST_PRE_START_SEQ) {
      const queuedAt = row.created_at ?? row.started_at
      if (!queuedAt || nowMs - new Date(queuedAt).getTime() <= noWorkerMs) continue
      if (await hasLeasedJob(db, row.id, userId, nowMs)) continue
      // Probed once per reconcile pass, lazily — most passes never get here.
      workerActive ??= await taskWorkerActiveWithin(db, noWorkerMs)
      if (workerActive) continue
      settleError = NO_WORKER_ERROR
    } else {
      const ref = last?.createdAt ?? row.started_at
      if (!ref || nowMs - new Date(ref).getTime() <= olderThanMs) continue
      if (await hasLiveJob(db, row.id, userId, nowMs)) continue
      settleError = "Task stopped unexpectedly (no recent activity)."
    }
    const settled = await appendSyntheticResult(db, row.id, userId, {
      status: "failed",
      error: settleError,
    })
    if (settled) failed += 1
  }
  return failed
}
