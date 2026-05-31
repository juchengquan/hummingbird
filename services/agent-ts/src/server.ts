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
import { getEnv } from "./env"

const env = getEnv()
const app = createApp()

// eslint-disable-next-line no-console
console.log(`[${env.SERVICE_NAME}] listening on http://localhost:${env.SERVICE_PORT}`)

const server = Bun.serve({
  port: env.SERVICE_PORT,
  fetch: app.fetch,
})

// Graceful shutdown — close the HTTP server on SIGTERM so in-flight
// requests get a chance to finish before the container is killed.
const shutdown = () => {
  // eslint-disable-next-line no-console
  console.log(`[${env.SERVICE_NAME}] shutting down`)
  server.stop()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
