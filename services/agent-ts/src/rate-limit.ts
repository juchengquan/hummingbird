/**
 * Per-IP rate-limit + idle-timeout helpers for agent-ts. Reuses the
 * core sliding-window algorithm from `@/server/rate-limit.ts` (which
 * is `import "server-only"` — fine, agent-ts runs in a server-side
 * Bun process) and adds a Hono-flavoured key extractor that reads
 * `X-Forwarded-For` from the request headers.
 *
 * Mirrors the equivalent setup in
 * `services/agent-py/src/agent_py/rate_limit.py`.
 */

import type { Context } from "hono"

import { createSlidingWindow } from "@/server/rate-limit"

export { createSlidingWindow }

/** Standard key derivation. Prefers `X-Forwarded-For` (the deploy
 *  proxy fills it in); falls back to a single bucket so an
 *  unconfigured deploy still limits abuse to one global rate rather
 *  than going unbounded. */
export function rateLimitKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return "default"
}
