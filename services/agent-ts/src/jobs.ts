/**
 * Direct port of `services/agent-py/src/agent_py/jobs.py`.
 *
 * `claimNextJob` issues `FOR UPDATE SKIP LOCKED` so two parallel
 * workers can poll the same queue without claiming the same row.
 * `releaseJobToQueue` puts a claimed row back (dry-run path) so
 * the TS worker doesn't compete with the Python worker during
 * Phase 1 mixed-stack operation.
 *
 * The SQL mirrors agent-py statement-for-statement against the real
 * `task_jobs` schema (migrations 0014 + 0032): status is one of
 * `queued | running | done | failed`; `attempts` / `max_attempts` /
 * `scheduled_at` / `started_at` / `finished_at` / `error jsonb` /
 * `lease_expires_at`. Semantics, identical across the two services:
 *
 *   - claim: oldest ready row → `running`, `attempts + 1`, lease
 *     stamped `now() + leaseSeconds`. Ready = `queued` and due, or
 *     (when `reclaimExpired`) `running` with a lapsed lease. Both only
 *     while `attempts < max_attempts`.
 *   - release: back to `queued`, lease + `started_at` cleared, the
 *     claim's attempt refunded, `scheduled_at` backed off by half the
 *     job's age (clamped to 5 s – 5 min).
 *   - done / failed: terminal, lease cleared; only from `running`, and
 *     fenced on the claim's `attempts` when given.
 *   - extendLease / handBackJob: heartbeat and graceful-shutdown
 *     hand-back, both fenced on `attempts` (the claim's fencing token).
 */

import type { Sql } from "./db"

/** Job action discriminator — same set as agent-py + the existing
 *  TS `lib/server/agent/jobs.ts`. */
export type JobAction = "start" | "respond" | "continue"

/** Default claim lease, seconds — same as agent-py's
 *  `DEFAULT_LEASE_SECONDS`. */
export const DEFAULT_LEASE_SECONDS = 120

/** One row pulled off `task_jobs` and marked `running` in the same
 *  statement. `payload` shape varies by action — the dispatcher
 *  branches on `action` to interpret. Mirrors agent-py's `ClaimedJob`. */
export interface ClaimedJob {
  id: string
  taskId: string
  userId: string
  action: JobAction
  payload: Record<string, unknown>
  /** Post-claim attempt count — the claim's fencing token. */
  attempts: number
  maxAttempts: number
  /** True when the claim took over a `running` row whose lease had
   *  expired (dead worker), not a fresh `queued` row. */
  reclaimed: boolean
}

export interface ClaimOptions {
  leaseSeconds?: number
  /** Also take over `running` rows whose lease lapsed. A passive
   *  (releasing-only) worker must leave this off. */
  reclaimExpired?: boolean
}

export const CLAIM_SQL = `
WITH next_job AS (
  SELECT id, status AS prev_status
  FROM public.task_jobs
  WHERE attempts < max_attempts
    AND (
          (status = 'queued' AND scheduled_at <= now())
       OR ($2::boolean AND status = 'running' AND lease_expires_at < now())
    )
  ORDER BY scheduled_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE public.task_jobs t
SET status = 'running',
    started_at = now(),
    attempts = t.attempts + 1,
    lease_expires_at = now() + $1::double precision * interval '1 second',
    updated_at = now()
FROM next_job
WHERE t.id = next_job.id
RETURNING t.id,
          t.task_id,
          t.user_id,
          t.action,
          t.payload,
          t.attempts,
          t.max_attempts,
          (next_job.prev_status = 'running') AS reclaimed;
`

export const RELEASE_SQL = `
UPDATE public.task_jobs
SET status = 'queued',
    started_at = NULL,
    lease_expires_at = NULL,
    attempts = GREATEST(attempts - 1, 0),
    scheduled_at = now() + LEAST(
      interval '5 minutes',
      GREATEST(interval '5 seconds', (now() - created_at) / 2)
    ),
    updated_at = now()
WHERE id = $1
  AND status = 'running';
`

export const MARK_DONE_SQL = `
UPDATE public.task_jobs
SET status = 'done',
    finished_at = now(),
    lease_expires_at = NULL,
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND ($2::integer IS NULL OR attempts = $2::integer);
`

export const MARK_FAILED_SQL = `
UPDATE public.task_jobs
SET status = 'failed',
    finished_at = now(),
    lease_expires_at = NULL,
    error = jsonb_build_object('message', $2::text),
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND ($3::integer IS NULL OR attempts = $3::integer);
`

export const EXTEND_LEASE_SQL = `
UPDATE public.task_jobs
SET lease_expires_at = now() + $3::double precision * interval '1 second',
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND attempts = $2::integer;
`

export const HAND_BACK_SQL = `
UPDATE public.task_jobs
SET lease_expires_at = now() - interval '1 second',
    attempts = GREATEST(attempts - 1, 0),
    updated_at = now()
WHERE id = $1
  AND status = 'running'
  AND attempts = $2::integer;
`

/**
 * Atomically claim the next ready job. Returns `null` when the queue
 * is empty or every candidate is held by another worker.
 */
export async function claimNextJob(
  sql: Sql,
  options: ClaimOptions = {},
): Promise<ClaimedJob | null> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  const reclaimExpired = options.reclaimExpired ?? true
  const rows = await sql.unsafe<RawJobRow[]>(CLAIM_SQL, [leaseSeconds, reclaimExpired])
  const row = rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    userId: String(row.user_id),
    action: row.action as JobAction,
    payload: coercePayload(row.payload),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    reclaimed: row.reclaimed === true,
  }
}

/** Put a claimed job back on the queue (dry-run / not ours to run).
 *  Returns whether a row was flipped. */
export async function releaseJobToQueue(sql: Sql, jobId: string): Promise<boolean> {
  return updatedAny(await sql.unsafe(RELEASE_SQL, [jobId]))
}

/** Settle a job done. Pass the claim's `attempts` to fence against a
 *  reclaimed job. Returns whether a row was settled. */
export async function markJobDone(
  sql: Sql,
  jobId: string,
  attempts: number | null = null,
): Promise<boolean> {
  return updatedAny(await sql.unsafe(MARK_DONE_SQL, [jobId, attempts]))
}

/** Settle a job failed (terminal). Pass the claim's `attempts` to fence
 *  against a reclaimed job. Returns whether a row was settled. */
export async function markJobFailed(
  sql: Sql,
  jobId: string,
  error: string,
  attempts: number | null = null,
): Promise<boolean> {
  return updatedAny(await sql.unsafe(MARK_FAILED_SQL, [jobId, error, attempts]))
}

/** Heartbeat: push this claim's lease forward. False → the claim is no
 *  longer ours (settled, reaped, or reclaimed by another worker). */
export async function extendLease(
  sql: Sql,
  jobId: string,
  attempts: number,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  return updatedAny(await sql.unsafe(EXTEND_LEASE_SQL, [jobId, attempts, leaseSeconds]))
}

/** Graceful-shutdown hand-back: expire the lease now (refunding the
 *  attempt) so the next live claim reclaims the job immediately. */
export async function handBackJob(
  sql: Sql,
  jobId: string,
  attempts: number,
): Promise<boolean> {
  return updatedAny(await sql.unsafe(HAND_BACK_SQL, [jobId, attempts]))
}

// --- internal helpers ----------------------------------------------------

interface RawJobRow {
  id: string
  task_id: string
  user_id: string
  action: string
  payload: unknown
  attempts: number
  max_attempts: number
  reclaimed: boolean | null
}

/** The `postgres` driver's result carries the affected-row count of an
 *  UPDATE on `.count`. */
function updatedAny(result: unknown): boolean {
  const count = (result as { count?: unknown } | null)?.count
  return typeof count === "number" && count > 0
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
