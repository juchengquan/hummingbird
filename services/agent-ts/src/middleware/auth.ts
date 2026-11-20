/**
 * JWT verification middleware — Phase 0 of PLAN-agent-ts.
 *
 * Mirrors `services/agent-py/src/agent_py/auth.py`: verifies the
 * Supabase-issued JWT (HS256 against `SUPABASE_JWT_SECRET`) on the
 * incoming `Authorization: Bearer <jwt>` header and stashes the
 * claims on the Hono context for the route handler.
 *
 * A valid signature alone is NOT enough: the legacy Supabase anon key
 * is itself an HS256 JWT signed with the same project secret (role
 * `anon`, no `sub`) and ships in the browser bundle. So we also require
 * `exp`, `aud` == `SUPABASE_JWT_AUDIENCE` (default `authenticated`),
 * `role` == `authenticated`, and a UUID `sub`.
 *
 * Failure modes — distinct status codes so monitoring can alert:
 *   - missing / malformed Authorization header → 401 + `WWW-Authenticate: Bearer`
 *   - bad signature / expired / wrong aud / wrong role / bad sub → 401
 *     (generic body; the reason is logged, never returned)
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
    const verified = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      audience: env.SUPABASE_JWT_AUDIENCE,
      requiredClaims: ["exp", "sub", "aud"],
    })
    claims = verified.payload as Claims
  } catch (err) {
    // Log the reason; don't leak which part of verification failed.
    console.info(
      JSON.stringify({
        event: "auth.token_rejected",
        reason: err instanceof Error ? err.name : "unknown",
      }),
    )
    return invalidToken(c)
  }

  if (claims.role !== REQUIRED_ROLE) {
    console.info(JSON.stringify({ event: "auth.token_rejected", reason: "role" }))
    return invalidToken(c)
  }
  if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) {
    console.info(JSON.stringify({ event: "auth.token_rejected", reason: "sub" }))
    return invalidToken(c)
  }

  c.set("claims", claims)
  await next()
}

/** The only `role` claim accepted on user-facing endpoints. */
const REQUIRED_ROLE = "authenticated"

/** Any RFC 4122-shaped UUID (auth.users ids are v4). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function invalidToken(c: Context) {
  return c.json(
    { code: "auth", message: "Invalid token." },
    401,
    { "WWW-Authenticate": "Bearer" },
  )
}

function missingAuthHeader(c: Context) {
  return c.json(
    { code: "auth", message: "Missing or malformed Authorization header." },
    401,
    { "WWW-Authenticate": "Bearer" },
  )
}
