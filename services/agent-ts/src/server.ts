/**
 * Entry point — boot Bun's HTTP server with the Hono app.
 *
 *   bun src/server.ts
 *
 * Bun ships an HTTP server built-in (`Bun.serve`) — no separate
 * adapter needed. Hono apps expose `.fetch` which is the canonical
 * Web `Request → Response` handler.
 */

import { createApp } from "./app"
import { closePool, hasPool, initPool } from "./db"
import { getEnv } from "./env"
import {
  POLLER_SHUTDOWN_GRACE_MS,
  pollerStartDecision,
  runPollLoop,
  settleWithin,
} from "./poller"

const env = getEnv()
const app = createApp()

// Open the DB pool before binding the port so /readyz reflects the
// real state by the first probe.
initPool()

// eslint-disable-next-line no-console
console.log(`[${env.SERVICE_NAME}] listening on http://localhost:${env.SERVICE_PORT}`)

const server = Bun.serve({
  port: env.SERVICE_PORT,
  fetch: app.fetch,
})

// Background poll loop — opt-in (`AGENT_TS_POLLER_ENABLED`): this
// service has no executor, so its poller only claims + releases jobs,
// which delays agent-py (the executor). Runs until SIGTERM.
const pollerController = new AbortController()
let pollLoop: Promise<unknown> | null = null
const pollerDecision = pollerStartDecision(env, hasPool())
if (pollerDecision.start) {
  // eslint-disable-next-line no-console
  console.log(
    `[${env.SERVICE_NAME}] poller starting interval=${env.POLL_INTERVAL_SECONDS}s dry_run=${env.WORKER_DRY_RUN}`,
  )
  pollLoop = runPollLoop(env, { signal: pollerController.signal }).catch((err) => {
    console.error(`[${env.SERVICE_NAME}] poll loop crashed: ${String(err)}`)
  })
} else {
  // eslint-disable-next-line no-console
  console.log(`[${env.SERVICE_NAME}] poller skipped — ${pollerDecision.reason}`)
}

// Graceful shutdown — stop the HTTP server, abort the poller, WAIT for
// its in-flight tick (a claim mid-tick must get its release written, or
// the job sits `running` until its lease lapses and the attempt is
// burned), then close the pool.
let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  // eslint-disable-next-line no-console
  console.log(`[${env.SERVICE_NAME}] shutting down`)
  server.stop()
  pollerController.abort()
  if (pollLoop) await settleWithin(pollLoop, POLLER_SHUTDOWN_GRACE_MS)
  await closePool()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
