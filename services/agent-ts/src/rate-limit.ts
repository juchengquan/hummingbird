/**
 * Per-IP rate-limit helpers for agent-ts. Reuses the core
 * sliding-window algorithm (with expired-bucket sweep + LRU cap) and
 * the client-IP derivation from `@/server/rate-limit.ts` (which is
 * `import "server-only"` — fine, agent-ts runs in a server-side Bun
 * process under `--conditions=react-server`), and adapts the key
 * extractor to Hono's `Context`.
 *
 * Mirrors the equivalent setup in
 * `services/agent-py/src/agent_py/rate_limit.py`.
 */

import type { Context } from "hono"

import {
  createSlidingWindow,
  rateLimitKey as rateLimitKeyFromRequest,
} from "./vendor/server/rate-limit"

export { createSlidingWindow }

/** Standard key derivation — same semantics as the Next.js routes:
 *  the client IP is the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS`
 *  (default 1) from the RIGHT, i.e. the address our outermost proxy
 *  saw. Entries further left are client-supplied and never trusted,
 *  so a caller can't rotate a spoofed XFF value to dodge the limit.
 *  Falls back to a single shared bucket when no trustworthy header is
 *  present, so an unconfigured deploy still limits abuse to one global
 *  rate rather than going unbounded. */
export function rateLimitKey(c: Context): string {
  return rateLimitKeyFromRequest({ headers: c.req.raw.headers })
}
