/**
 * `/v1/whoami` — auth smoke test. Echoes the verified JWT claims
 * (minus secrets) so an operator can confirm the JWT secret + the
 * Authorization-header plumbing work end-to-end before any real
 * endpoints exist.
 *
 * Mirrors `services/agent-py`'s `/v1/whoami` exactly.
 */

import { Hono } from "hono"

import type { AuthVars } from "../middleware/auth"
import { requireAuth } from "../middleware/auth"

export const whoamiRoutes = new Hono<{ Variables: AuthVars }>()

whoamiRoutes.get("/v1/whoami", requireAuth, (c) => {
  const claims = c.get("claims")
  return c.json({
    user_id: typeof claims.sub === "string" ? claims.sub : null,
    role: typeof claims.role === "string" ? claims.role : null,
  })
})
