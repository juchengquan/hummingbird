/**
 * Hono app factory — mirrors `create_app(...)` in
 * `services/agent-py/src/agent_py/main.py`.
 *
 * Factory shape (rather than a module-level `app = new Hono()`) so
 * tests can spin up isolated instances per test with overridden env
 * without leaking state across tests.
 *
 * Phase 0: health + whoami. Phase 1: poll loop (in server.ts).
 * Phase 2: executor. Phase 3: chat. Phase 4: extract / url-fetch /
 * refresh-url / summarize / mcp proxy.
 */

import { Hono } from "hono"

import { chatRoutes } from "./routes/chat"
import { extractRoutes } from "./routes/extract"
import { healthRoutes } from "./routes/health"
import { mcpProxyRoutes } from "./routes/mcp-proxy"
import { refreshUrlRoutes } from "./routes/refresh-url"
import { summarizeRoutes } from "./routes/summarize"
import { urlFetchRoutes } from "./routes/url-fetch"
import { whoamiRoutes } from "./routes/whoami"
import type { AuthVars } from "./middleware/auth"

export type AppVariables = AuthVars

export function createApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()

  // Health probes — unauthenticated. Liveness must work without any
  // dependency reachable.
  app.route("/", healthRoutes)

  // Auth-protected /v1 routes.
  app.route("/", whoamiRoutes)
  app.route("/", chatRoutes)
  app.route("/", extractRoutes)
  app.route("/", urlFetchRoutes)
  app.route("/", refreshUrlRoutes)
  app.route("/", summarizeRoutes)
  app.route("/", mcpProxyRoutes)

  return app
}
