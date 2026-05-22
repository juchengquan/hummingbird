import "server-only"

import type { NextRequest } from "next/server"

/**
 * Sliding-window per-key rate limiter. In-process; not durable across
 * restarts and not shared across serverless instances — fine for our
 * scale, and the worst case is a small leak in rate-limit accuracy
 * after cold starts, not a security gap (the SSRF guard still applies
 * to every outbound request).
 *
 * The window is "the most recent `windowMs` ago." Each successful
 * check pushes `now` into the key's bucket and drops anything older
 * than the window. When the bucket has `max` entries the check
 * returns `allowed: false` with a `retryAfterSec` hint computed from
 * the oldest entry's age.
 *
 * Usage:
 *
 *   const limit = createSlidingWindow({ windowMs: 60_000, max: 30 })
 *   const verdict = limit.consume(rateLimitKey(req))
 *   if (!verdict.allowed) return new Response(..., {
 *     status: 429,
 *     headers: { "Retry-After": String(verdict.retryAfterSec) },
 *   })
 */

export interface SlidingWindowConfig {
  windowMs: number
  max: number
}

export interface RateLimitVerdict {
  allowed: boolean
  /** Seconds the client should wait before retrying. 0 when allowed. */
  retryAfterSec: number
}

export interface SlidingWindow {
  consume(key: string): RateLimitVerdict
  /** Test-only: reset all buckets. */
  _reset(): void
}

export function createSlidingWindow(config: SlidingWindowConfig): SlidingWindow {
  const buckets = new Map<string, number[]>()

  return {
    consume(key) {
      const now = Date.now()
      const bucket = buckets.get(key) ?? []
      // Drop entries outside the window.
      const fresh = bucket.filter((t) => now - t < config.windowMs)
      if (fresh.length >= config.max) {
        const oldest = fresh[0]
        const retryAfterMs = config.windowMs - (now - oldest)
        return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
      }
      fresh.push(now)
      buckets.set(key, fresh)
      return { allowed: true, retryAfterSec: 0 }
    },
    _reset() {
      buckets.clear()
    },
  }
}

/**
 * Standard rate-limit key derivation. Prefers `X-Forwarded-For` (the
 * deployment proxy fills it in); falls back to a single bucket so an
 * unconfigured deploy still limits abuse to one global rate rather
 * than going unbounded.
 */
export function rateLimitKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) {
    return forwarded.split(",")[0].trim()
  }
  return "default"
}
