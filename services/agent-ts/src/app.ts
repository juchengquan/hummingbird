/**
 * Hono app factory — mirrors `create_app(...)` in
 * `services/agent-py/src/agent_py/main.py`.
 *
 * Factory shape (rather than a module-level `app = new Hono()`) so
 * tests can spin up isolated instances per test with overridden env
 * without leaking state across tests.
 *
 * Phase 0 mounts only health + whoami. Phase 1 adds the lifespan
 * hook for the poll loop; Phase 2+ adds executor + chat + tools.
 */

import { Hono } from "hono"

import { healthRoutes } from "./routes/health"
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

  return app
}
