/**
 * JWT verification middleware — Phase 0 of PLAN-agent-ts.
 *
 * Mirrors `services/agent-py/src/agent_py/auth.py`: verifies the
 * Supabase-issued JWT (HS256 against `SUPABASE_JWT_SECRET`) on the
 * incoming `Authorization: Bearer <jwt>` header and stashes the
 * claims on the Hono context for the route handler.
 *
 * Failure modes — distinct status codes so monitoring can alert:
 *   - missing / malformed Authorization header → 401 + `WWW-Authenticate: Bearer`
 *   - bad signature / expired token → 401
 *   - `SUPABASE_JWT_SECRET` unset → 503 (misconfig, not user error)
 */

import type { Context, MiddlewareHandler } from "hono"
import { jwtVerify } from "jose"

import { getEnv } from "../env"

/** What the route handler reads off `c.get("claims")` to learn who
 *  the caller is. Mirrors agent-py's `claims: dict[str, object]`. */
export type Claims = Record<string, unknown> & {
  sub?: string
  role?: string
  exp?: number
}

/** Hono context-variable map — extend so `c.get("claims")` is typed. */
export type AuthVars = {
  claims: Claims
}

const AUTH_HEADER = "authorization"

/**
 * Hono middleware that verifies the bearer token and stashes claims.
 * Attach to any route or sub-router that requires auth — leaves
 * `/healthz` / `/readyz` alone so liveness probes work without
 * credentials.
 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVars }> = async (
  c,
  next,
) => {
  const env = getEnv()
  if (!env.SUPABASE_JWT_SECRET) {
    // Misconfig — distinct from 401 so monitoring can alert on it.
    return c.json(
      {
        code: "auth_unavailable",
        message: "SUPABASE_JWT_SECRET is not configured.",
      },
      503,
    )
  }

  const header = c.req.header(AUTH_HEADER)
  if (!header) {
    return missingAuthHeader(c)
  }
  const [scheme, token] = header.split(" ", 2)
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return missingAuthHeader(c)
  }

  let claims: Claims
  try {
    const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
    const verified = await jwtVerify(token, secret, { algorithms: ["HS256"] })
    claims = verified.payload as Claims
  } catch {
    // Don't leak which part of verification failed — same as 401.
    return c.json(
      { code: "auth", message: "Invalid token." },
      401,
      { "WWW-Authenticate": "Bearer" },
    )
  }

  c.set("claims", claims)
  await next()
}

function missingAuthHeader(c: Context) {
  return c.json(
    { code: "auth", message: "Missing or malformed Authorization header." },
    401,
    { "WWW-Authenticate": "Bearer" },
  )
}
