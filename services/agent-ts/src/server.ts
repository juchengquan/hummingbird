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
import { runPollLoop } from "./poller"

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

// Background poll loop runs until SIGTERM. The promise is intentionally
// not awaited — it terminates when the AbortController fires.
const pollerController = new AbortController()
if (hasPool()) {
  // eslint-disable-next-line no-console
  console.log(
    `[${env.SERVICE_NAME}] poller starting interval=${env.POLL_INTERVAL_SECONDS}s dry_run=${env.WORKER_DRY_RUN}`,
  )
  void runPollLoop(env, { signal: pollerController.signal })
} else {
  // eslint-disable-next-line no-console
  console.log(`[${env.SERVICE_NAME}] poller skipped — SUPABASE_DB_URL not set`)
}

// Graceful shutdown — stop the HTTP server, abort the poller, close
// the pool. Order matters: stop accepting new connections first, let
// in-flight requests finish, then tear down the worker / pool.
const shutdown = async () => {
  // eslint-disable-next-line no-console
  console.log(`[${env.SERVICE_NAME}] shutting down`)
  server.stop()
  pollerController.abort()
  await closePool()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
