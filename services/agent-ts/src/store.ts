/**
 * RunStore — direct port of
 * `services/agent-py/src/agent_py/store.py`.
 *
 * `tasks` + `task_events` writes. SQL byte-for-byte identical to
 * agent-py's so the row contract stays uniform across stacks.
 *
 * The Python service has `_set_user_context()` for RLS impersonation
 * around per-user queries (`searchFiles`, MCP cred decrypt). Phase 2
 * doesn't need that yet; it lands alongside Phase 3 tools.
 */

import type { Sql } from "./db"
import type { TaskEvent } from "./events"
import { eventToRowPayload } from "./events"

const APPEND_EVENT_SQL = `
INSERT INTO public.task_events (task_id, user_id, seq, step, kind, payload)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)
ON CONFLICT (task_id, seq) DO NOTHING;
`

const SET_HANDLER_SQL = `
UPDATE public.tasks
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('handler', $3::text),
    updated_at = now()
WHERE id = $1::uuid AND user_id = $2::uuid;
`

const IS_CANCELLED_SQL = `
SELECT status FROM public.tasks
WHERE id = $1::uuid AND user_id = $2::uuid;
`

const LOAD_CHECKPOINT_SQL = `
SELECT checkpoint FROM public.tasks
WHERE id = $1::uuid AND user_id = $2::uuid;
`

const SAVE_CHECKPOINT_SQL = `
UPDATE public.tasks
SET checkpoint = $3::jsonb,
    updated_at = now()
WHERE id = $1::uuid AND user_id = $2::uuid;
`

export interface UpdateRunOptions {
  runId: string
  userId: string
  status?: string
  step?: number
  finished?: boolean
}

/**
 * Patch a `tasks` row. Only the fields explicitly passed get written —
 * partial updates are intentional so the executor can bump just `step`
 * between steps without touching status. Mirrors agent-py's
 * `update_run`.
 */
export async function updateRun(
  sql: Sql,
  { runId, userId, status, step, finished }: UpdateRunOptions,
): Promise<void> {
  const sets: string[] = ["updated_at = now()"]
  const args: unknown[] = []
  if (status !== undefined) {
    args.push(status)
    sets.push(`status = $${args.length}`)
  }
  if (step !== undefined) {
    args.push(step)
    sets.push(`step = $${args.length}`)
  }
  if (finished) {
    sets.push("finished_at = now()")
  }
  args.push(runId)
  args.push(userId)
  const stmt = `UPDATE public.tasks SET ${sets.join(", ")} WHERE id = $${args.length - 1}::uuid AND user_id = $${args.length}::uuid;`
  await sql.unsafe(stmt, args as never)
}

/**
 * Insert one event row. Idempotent on `(task_id, seq)` — a duplicate
 * seq hits the unique constraint and is silently ignored. Mirrors
 * agent-py's `append_event`.
 */
export async function appendEvent(
  sql: Sql,
  event: TaskEvent,
  userId: string,
): Promise<void> {
  const payload = JSON.stringify(eventToRowPayload(event))
  await sql.unsafe(APPEND_EVENT_SQL, [
    event.runId,
    userId,
    event.seq,
    event.step,
    event.kind,
    payload,
  ])
}

/** Stamp `tasks.metadata.handler` so post-hoc analysis can tell which
 *  service ran which run. Mirrors agent-py's `set_task_handler`. */
export async function setTaskHandler(
  sql: Sql,
  runId: string,
  userId: string,
  handler: string,
): Promise<void> {
  await sql.unsafe(SET_HANDLER_SQL, [runId, userId, handler])
}

/** Cheap status probe the runner polls between steps. Network blip
 *  → false (the run keeps going). Mirrors agent-py's `is_run_cancelled`. */
export async function isRunCancelled(
  sql: Sql,
  runId: string,
  userId: string,
): Promise<boolean> {
  try {
    const rows = await sql.unsafe<{ status: string }[]>(IS_CANCELLED_SQL, [
      runId,
      userId,
    ])
    return rows[0]?.status === "cancelled"
  } catch {
    return false
  }
}

/** Read `tasks.checkpoint` jsonb. Returns null on missing row /
 *  null column (defensive). Shape matches `RunCheckpoint` on the TS
 *  side. */
export async function loadCheckpoint(
  sql: Sql,
  runId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql.unsafe<{ checkpoint: unknown }[]>(LOAD_CHECKPOINT_SQL, [
    runId,
    userId,
  ])
  const raw = rows[0]?.checkpoint
  if (raw === null || raw === undefined) return null
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return null
}

/** Overwrite the `tasks.checkpoint` jsonb. Phase 3a uses this on the
 *  chunk-break path; same shape as `RunCheckpoint`. */
export async function saveCheckpoint(
  sql: Sql,
  runId: string,
  userId: string,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  await sql.unsafe(SAVE_CHECKPOINT_SQL, [
    runId,
    userId,
    JSON.stringify(checkpoint),
  ])
}
