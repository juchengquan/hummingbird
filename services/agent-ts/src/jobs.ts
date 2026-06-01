/**
 * Direct port of `services/agent-py/src/agent_py/jobs.py`.
 *
 * `claimNextJob` issues `FOR UPDATE SKIP LOCKED` so two parallel
 * workers can poll the same queue without claiming the same row.
 * `releaseJobToQueue` puts a claimed row back (dry-run path) so
 * the TS worker doesn't compete with the Python worker during
 * Phase 1 mixed-stack operation.
 *
 * SQL shape mirrors agent-py byte-for-byte so the queue contract
 * stays identical across implementations.
 */

import type { Sql } from "./db"

/** Job action discriminator — same set as agent-py + the existing
 *  TS `lib/server/agent/jobs.ts`. */
export type JobAction = "start" | "respond" | "continue"

/** One row pulled off `task_jobs` and marked `claimed` in the same
 *  transaction. `payload` shape varies by action — the dispatcher
 *  branches on `action` to interpret. */
export interface ClaimedJob {
  id: string
  taskId: string
  userId: string
  action: JobAction
  payload: Record<string, unknown>
  attempt: number
  claimedAt: Date
}

const CLAIM_SQL = `
WITH claimable AS (
  SELECT id
  FROM public.task_jobs
  WHERE status = 'queued'
    AND scheduled_for <= now()
  ORDER BY priority DESC, scheduled_for ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE public.task_jobs t
SET status = 'claimed',
    claimed_at = now(),
    claimed_by = $1,
    attempt = t.attempt + 1
FROM claimable
WHERE t.id = claimable.id
RETURNING t.id, t.task_id, t.user_id, t.action, t.payload, t.attempt, t.claimed_at;
`

const RELEASE_SQL = `
UPDATE public.task_jobs
SET status = 'queued', claimed_at = NULL, claimed_by = NULL,
    attempt = GREATEST(attempt - 1, 0)
WHERE id = $1 AND status = 'claimed';
`

const MARK_DONE_SQL = `
UPDATE public.task_jobs
SET status = 'done', finished_at = now()
WHERE id = $1;
`

const MARK_FAILED_SQL = `
UPDATE public.task_jobs
SET status = 'failed', finished_at = now(), last_error = $2
WHERE id = $1;
`

/**
 * Atomically claim the next ready job. Returns `null` when the queue
 * is empty. `workerId` is a free-form identifier — agent-py uses
 * `'agent-py'`; the TS service uses `'agent-ts'` so postmortems can
 * tell handlers apart in `claimed_by`.
 */
export async function claimNextJob(
  sql: Sql,
  workerId: string,
): Promise<ClaimedJob | null> {
  const rows = await sql.unsafe<RawJobRow[]>(CLAIM_SQL, [workerId])
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    action: row.action as JobAction,
    payload: coercePayload(row.payload),
    attempt: row.attempt,
    claimedAt: row.claimed_at,
  }
}

/** Put a claimed job back on the queue. Phase 1 dry-run uses this on
 *  every claim. Phase 2 only uses it when we can't actually execute. */
export async function releaseJobToQueue(sql: Sql, jobId: string): Promise<void> {
  await sql.unsafe(RELEASE_SQL, [jobId])
}

export async function markJobDone(sql: Sql, jobId: string): Promise<void> {
  await sql.unsafe(MARK_DONE_SQL, [jobId])
}

export async function markJobFailed(
  sql: Sql,
  jobId: string,
  error: string,
): Promise<void> {
  await sql.unsafe(MARK_FAILED_SQL, [jobId, error])
}

// --- internal helpers ----------------------------------------------------

interface RawJobRow {
  id: string
  task_id: string
  user_id: string
  action: string
  payload: unknown
  attempt: number
  claimed_at: Date
}

function coercePayload(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}
