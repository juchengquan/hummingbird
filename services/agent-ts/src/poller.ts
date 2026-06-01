/**
 * Background poll loop — Phase 1 of PLAN-agent-ts.
 *
 * Mirrors `services/agent-py/src/agent_py/poller.py` in dry-run mode:
 * claim a job, structured-log it, release it back. The Python or TS
 * Next.js worker actually executes; the TS service only observes
 * until Phase 2 flips `WORKER_DRY_RUN=false`.
 *
 * Behaviour:
 *   - With no pool open (`SUPABASE_DB_URL` empty) → no-op every tick.
 *   - With `WORKER_DRY_RUN=true` (default) → claim + log + release.
 *   - With `WORKER_DRY_RUN=false` → claim + dispatch to executor
 *     (Phase 2 wires this branch).
 *
 * Cancellation:
 *   - The loop honours an `AbortSignal` so the app's shutdown handler
 *     can stop it cleanly. SIGTERM → controller.abort() → in-flight
 *     claim finishes, no new claim issued, loop exits.
 */

import { getPool as defaultGetPool, hasPool as defaultHasPool } from "./db"
import type { Env } from "./env"
import {
  claimNextJob as defaultClaimNextJob,
  releaseJobToQueue as defaultReleaseJobToQueue,
  type ClaimedJob,
} from "./jobs"
import type { Sql } from "./db"

const WORKER_ID = "agent-ts"

/** Injected seam for the poller's collaborators. Defaults wire the
 *  real DB pool + SQL helpers; tests pass fakes to drive the loop
 *  deterministically without going through `mock.module` (which
 *  leaks across the test process). Mirrors agent-py's
 *  `RunStepFn` / `MakeStepFn` injection pattern. */
export interface PollerDeps {
  hasPool: () => boolean
  getPool: () => Sql
  claimNextJob: (sql: Sql, workerId: string) => Promise<ClaimedJob | null>
  releaseJobToQueue: (sql: Sql, jobId: string) => Promise<void>
}

const defaultDeps: PollerDeps = {
  hasPool: defaultHasPool,
  getPool: defaultGetPool,
  claimNextJob: defaultClaimNextJob,
  releaseJobToQueue: defaultReleaseJobToQueue,
}

/** Stats returned at the end of the loop (or after an abort) so
 *  tests can verify behaviour without snooping on structured logs. */
export interface PollerStats {
  ticks: number
  claimed: number
  released: number
  errors: number
}

export interface RunPollLoopOptions {
  /** Signal that fires when the app is shutting down. The loop
   *  finishes its current tick and exits without scheduling another. */
  signal?: AbortSignal
  /** Hard cap on iterations — when set, the loop exits after this
   *  many ticks regardless of signal state. Used by tests to bound
   *  the run; production passes Infinity. */
  maxTicks?: number
  /** Injected collaborators. Production callers omit this and get
   *  the real DB-backed implementation; tests pass a `PollerDeps`
   *  with stubbed `claimNextJob` / `hasPool` / etc. */
  deps?: PollerDeps
}

/**
 * Drive the poll loop forever (or until `signal` aborts / `maxTicks`
 * hits). Returns aggregate stats so a test or the shutdown log can
 * report what happened during the run.
 */
export async function runPollLoop(
  env: Env,
  options: RunPollLoopOptions = {},
): Promise<PollerStats> {
  const deps = options.deps ?? defaultDeps
  const stats: PollerStats = { ticks: 0, claimed: 0, released: 0, errors: 0 }
  const sleepMs = env.POLL_INTERVAL_SECONDS * 1000
  const maxTicks = options.maxTicks ?? Infinity

  while (!options.signal?.aborted && stats.ticks < maxTicks) {
    stats.ticks += 1

    if (!deps.hasPool()) {
      // No DB → no claim possible. Sleep + loop.
      await sleep(sleepMs, options.signal)
      continue
    }

    try {
      const job = await deps.claimNextJob(deps.getPool(), WORKER_ID)
      if (job) {
        stats.claimed += 1
        if (env.WORKER_DRY_RUN) {
          // Phase 1 contract: log and release. Phase 2 swaps in the
          // executor branch.
          // eslint-disable-next-line no-console
          console.log(
            `[agent-ts.poller] claimed ${job.id} action=${job.action} attempt=${job.attempt} — releasing (dry-run)`,
          )
          await deps.releaseJobToQueue(deps.getPool(), job.id)
          stats.released += 1
        } else {
          // Phase 2 lands the dispatch branch. Until then,
          // !dry_run + flagged behaves the same as dry_run for safety.
          // eslint-disable-next-line no-console
          console.warn(
            `[agent-ts.poller] WORKER_DRY_RUN=false but executor not wired yet (Phase 2). Releasing ${job.id} to TS worker.`,
          )
          await deps.releaseJobToQueue(deps.getPool(), job.id)
          stats.released += 1
        }
      }
    } catch (err) {
      stats.errors += 1
      // eslint-disable-next-line no-console
      console.warn(`[agent-ts.poller] tick failed: ${stringifyError(err)}`)
    }

    if (stats.ticks < maxTicks) {
      await sleep(sleepMs, options.signal)
    }
  }

  return stats
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
