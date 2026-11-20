/**
 * Phase 1 tests — poll loop dry-run dispatch.
 *
 * Uses dependency injection (`runPollLoop(env, { deps })`) so the
 * DB pool and SQL helpers can be faked without going through
 * `mock.module`, which is process-wide in Bun and leaks across
 * test files.
 */

import { describe, test, expect } from "bun:test"

import type { Env } from "../src/env"
import type { PollerDeps } from "../src/poller"
import { pollerStartDecision, runPollLoop, settleWithin } from "../src/poller"

const baseEnv: Env = {
  SERVICE_NAME: "agent-ts",
  SERVICE_PORT: 8001,
  SUPABASE_URL: "",
  SUPABASE_JWT_SECRET: "",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  SUPABASE_DB_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  AGENT_TS_POLLER_ENABLED: true,
  WORKER_DRY_RUN: true,
  POLL_INTERVAL_SECONDS: 0, // fire as fast as possible in tests
  JOB_LEASE_SECONDS: 120,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_BASE_URL: "",
  AGENT_DEFAULT_MODEL: "anthropic/claude-haiku-4.5",
  TAVILY_API_KEY: "",
  MINIMAX_CN_API_KEY: "",
  MINIMAX_CN_BASE_URL: "",
  MCP_ENCRYPTION_KEY: "",
}

const sampleJob = {
  id: "job-1",
  taskId: "task-1",
  userId: "user-1",
  action: "start" as const,
  payload: {},
  attempts: 1,
  maxAttempts: 3,
  reclaimed: false,
}

/** Build a minimal `PollerDeps` whose collaborators are spy-like
 *  arrays of calls. The fake pool is just an opaque object — never
 *  actually used, just passed through the call chain. */
function buildDeps(overrides: Partial<PollerDeps> = {}): {
  deps: PollerDeps
  releases: string[]
  claims: number
} {
  const releases: string[] = []
  let claims = 0
  const fakePool = {} as never
  const deps: PollerDeps = {
    hasPool: () => true,
    getPool: () => fakePool,
    claimNextJob: async () => {
      claims += 1
      return null
    },
    releaseJobToQueue: async (_pool, jobId) => {
      releases.push(jobId)
    },
    ...overrides,
  }
  return { deps, releases, get claims() { return claims } }
}

describe("runPollLoop — dry-run", () => {
  test("claims + releases in one tick when a job exists", async () => {
    const { deps, releases } = buildDeps({
      claimNextJob: async () => sampleJob,
    })
    const stats = await runPollLoop(baseEnv, { maxTicks: 1, deps })
    expect(stats).toMatchObject({ ticks: 1, claimed: 1, released: 1, errors: 0 })
    expect(releases).toEqual(["job-1"])
  })

  test("empty queue → tick counted, no release", async () => {
    const { deps, releases } = buildDeps({ claimNextJob: async () => null })
    const stats = await runPollLoop(baseEnv, { maxTicks: 1, deps })
    expect(stats).toMatchObject({ ticks: 1, claimed: 0, released: 0, errors: 0 })
    expect(releases).toEqual([])
  })

  test("no pool → no claim attempt", async () => {
    let claimCalls = 0
    const { deps } = buildDeps({
      hasPool: () => false,
      claimNextJob: async () => {
        claimCalls += 1
        return null
      },
    })
    const stats = await runPollLoop(baseEnv, { maxTicks: 1, deps })
    expect(stats).toMatchObject({ ticks: 1, claimed: 0, released: 0 })
    expect(claimCalls).toBe(0)
  })

  test("claim error is logged but loop continues", async () => {
    let calls = 0
    const { deps } = buildDeps({
      claimNextJob: async () => {
        calls += 1
        if (calls === 1) throw new Error("connection lost")
        return null
      },
    })
    const stats = await runPollLoop(baseEnv, { maxTicks: 2, deps })
    expect(stats.errors).toBe(1)
    expect(stats.ticks).toBe(2)
  })

  test("abort signal exits the loop cleanly", async () => {
    const { deps } = buildDeps({ claimNextJob: async () => null })
    const ctrl = new AbortController()
    // Abort before the first tick — loop should exit immediately.
    ctrl.abort()
    const stats = await runPollLoop(baseEnv, {
      signal: ctrl.signal,
      maxTicks: 10,
      deps,
    })
    expect(stats.ticks).toBe(0)
  })
})

describe("runPollLoop — !dry-run safety", () => {
  test("WORKER_DRY_RUN=false still releases (executor wiring is Phase 2)", async () => {
    const { deps, releases } = buildDeps({
      claimNextJob: async () => sampleJob,
    })
    const stats = await runPollLoop(
      { ...baseEnv, WORKER_DRY_RUN: false },
      { maxTicks: 1, deps },
    )
    // Phase 1 contract: don't drop work even when "live"; release back
    // to the queue until Phase 2's executor branch lands.
    expect(stats).toMatchObject({ claimed: 1, released: 1 })
    expect(releases).toEqual(["job-1"])
  })
})

describe("runPollLoop — claim options", () => {
  test("claims passively (queued only) with the configured lease", async () => {
    const seen: unknown[] = []
    const { deps } = buildDeps({
      claimNextJob: async (_sql, options) => {
        seen.push(options)
        return null
      },
    })
    await runPollLoop({ ...baseEnv, JOB_LEASE_SECONDS: 45 }, { maxTicks: 1, deps })
    // agent-ts only releases what it claims, so it must never take over
    // a dead worker's expired-lease job — agent-py reclaims those.
    expect(seen).toEqual([{ leaseSeconds: 45, reclaimExpired: false }])
  })
})

describe("pollerStartDecision", () => {
  test("off by default: agent-ts has no executor, its claims only delay agent-py", () => {
    expect(pollerStartDecision({ AGENT_TS_POLLER_ENABLED: false }, true).start).toBe(false)
  })

  test("opt-in without a pool still skips", () => {
    expect(pollerStartDecision({ AGENT_TS_POLLER_ENABLED: true }, false).start).toBe(false)
  })

  test("opt-in with a pool starts", () => {
    expect(pollerStartDecision({ AGENT_TS_POLLER_ENABLED: true }, true).start).toBe(true)
  })
})

describe("settleWithin (shutdown waits for the in-flight tick)", () => {
  test("resolves once the loop settles", async () => {
    let done = false
    const loop = new Promise<void>((resolve) =>
      setTimeout(() => {
        done = true
        resolve()
      }, 10),
    )
    await settleWithin(loop, 1_000)
    expect(done).toBe(true)
  })

  test("gives up after the grace period", async () => {
    const started = Date.now()
    await settleWithin(new Promise(() => {}), 20)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("never rejects", async () => {
    await settleWithin(Promise.reject(new Error("boom")), 1_000)
  })
})
