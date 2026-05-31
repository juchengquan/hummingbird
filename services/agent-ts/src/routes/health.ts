/**
 * Health + readiness routes.
 *
 *  - `/healthz` — liveness. 200 as long as the process is up.
 *    Does NOT depend on Supabase, the model gateway, or any other
 *    external service. Restart the container on failure.
 *  - `/readyz` — readiness. Reports the configured dependencies so
 *    Kubernetes / Fly / nginx can wait until they're satisfied
 *    before routing traffic. Mirrors agent-py's `/readyz`.
 */

import { Hono } from "hono"

import { getEnv } from "../env"
import packageInfo from "../../package.json"

export const healthRoutes = new Hono()

healthRoutes.get("/healthz", (c) => {
  const env = getEnv()
  return c.json({
    status: "ok",
    service: env.SERVICE_NAME,
    version: packageInfo.version,
  })
})

healthRoutes.get("/readyz", (c) => {
  const env = getEnv()
  return c.json({
    status: "ok",
    checks: {
      supabase_url_configured: Boolean(env.SUPABASE_URL),
      supabase_db_configured: Boolean(env.SUPABASE_DB_URL),
      jwt_secret_configured: Boolean(env.SUPABASE_JWT_SECRET),
      // Phase 1 grows this with `db_pool_open` once the pool exists.
      db_pool_open: false,
    },
  })
})
