import "server-only"

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
 * Memory is bounded two ways: a sweep (at most once per `windowMs`,
 * run lazily from `consume`) drops buckets whose newest entry has aged
 * out of the window, and a hard `maxBuckets` cap evicts the
 * least-recently-used buckets when a new key would exceed it.
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
  /** Hard cap on tracked keys. When a new key would exceed it, expired
   *  buckets are swept and then the least-recently-used ones evicted.
   *  Default 10_000. */
  maxBuckets?: number
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
  /** Test-only: number of tracked buckets. */
  _size(): number
}

const DEFAULT_MAX_BUCKETS = 10_000

export function createSlidingWindow(config: SlidingWindowConfig): SlidingWindow {
  const maxBuckets = Math.max(1, config.maxBuckets ?? DEFAULT_MAX_BUCKETS)
  // Map insertion order doubles as LRU order: every touch re-inserts.
  const buckets = new Map<string, number[]>()
  let lastSweep = Date.now()

  /** Drop every bucket with no entry inside the window. Buckets are
   *  sorted ascending, so the last entry is the newest. */
  function sweep(now: number) {
    lastSweep = now
    for (const [key, bucket] of buckets) {
      const newest = bucket[bucket.length - 1]
      if (newest === undefined || now - newest >= config.windowMs) {
        buckets.delete(key)
      }
    }
  }

  return {
    consume(key) {
      const now = Date.now()
      if (now - lastSweep >= config.windowMs) sweep(now)

      const bucket = buckets.get(key) ?? []
      // Drop entries outside the window.
      const fresh = bucket.filter((t) => now - t < config.windowMs)
      if (fresh.length >= config.max) {
        const oldest = fresh[0]
        const retryAfterMs = config.windowMs - (now - oldest)
        buckets.delete(key)
        buckets.set(key, fresh)
        return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
      }
      fresh.push(now)
      buckets.delete(key)
      if (buckets.size >= maxBuckets) {
        sweep(now)
        while (buckets.size >= maxBuckets) {
          const lru = buckets.keys().next().value
          if (lru === undefined) break
          buckets.delete(lru)
        }
      }
      buckets.set(key, fresh)
      return { allowed: true, retryAfterSec: 0 }
    },
    _reset() {
      buckets.clear()
      lastSweep = Date.now()
    },
    _size() {
      return buckets.size
    },
  }
}

/** Header-reading surface shared by `NextRequest`, `Request`, and
 *  plain `Headers` — keeps the IP derivation testable without Next. */
interface HeaderSource {
  get(name: string): string | null
}

export interface ClientIpOptions {
  /** Number of reverse proxies in front of the app that each append
   *  the peer address to `X-Forwarded-For`. The client IP is the entry
   *  `trustedProxyHops` from the right. 0 → XFF is ignored entirely. */
  trustedProxyHops: number
  /** Trust the platform-set `x-real-ip` / `x-vercel-forwarded-for`
   *  headers. Only safe where the platform overwrites them (Vercel);
   *  behind a self-hosted proxy a client could inject them. */
  trustPlatformHeaders: boolean
}

const DEFAULT_TRUSTED_PROXY_HOPS = 1
/** Longest legitimate IP literal (IPv6 with zone id) is well under
 *  this; anything longer is junk and shouldn't become a map key. */
const MAX_IP_LENGTH = 64

function cleanIp(value: string | null | undefined): string | null {
  const v = value?.trim()
  if (!v || v.length > MAX_IP_LENGTH) return null
  return v
}

/**
 * Derive the client IP from proxy headers, or null when none is
 * trustworthy.
 *
 * 1. On Vercel, the platform sets `x-real-ip` and
 *    `x-vercel-forwarded-for` itself (overwriting client values), so
 *    those win.
 * 2. Otherwise, `X-Forwarded-For` is read from the RIGHT: each trusted
 *    proxy appends the address it received the connection from, so
 *    the entry `trustedProxyHops` from the end is the one our
 *    outermost proxy saw. Entries further left are whatever the client
 *    sent and are never trusted.
 */
export function clientIpFromHeaders(
  headers: HeaderSource,
  opts: ClientIpOptions
): string | null {
  if (opts.trustPlatformHeaders) {
    const real = cleanIp(headers.get("x-real-ip"))
    if (real) return real
    const vercel = cleanIp(headers.get("x-vercel-forwarded-for")?.split(",")[0])
    if (vercel) return vercel
  }
  const hops = opts.trustedProxyHops
  if (hops <= 0) return null
  const forwarded = headers.get("x-forwarded-for")
  if (!forwarded) return null
  const entries = forwarded
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
  if (entries.length === 0) return null
  // Fewer entries than configured hops means a proxy didn't append —
  // the left-most entry is then the best (proxy-written) address left.
  const index = Math.max(0, entries.length - hops)
  return cleanIp(entries[index])
}

/** Parse `TRUSTED_PROXY_HOPS`; invalid/unset → 1 (one reverse proxy,
 *  e.g. Caddy/Nginx on the self-hosted VM, or Vercel's edge). */
export function trustedProxyHopsFromEnv(
  raw: string | undefined = process.env.TRUSTED_PROXY_HOPS
): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUSTED_PROXY_HOPS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return DEFAULT_TRUSTED_PROXY_HOPS
  return n
}

/** Platforms whose edge sets / appends `X-Forwarded-For` itself, so the
 *  right-most entry is trustworthy without a self-hosted proxy. */
const PROXYING_PLATFORM_ENV = [
  "VERCEL",
  "RENDER",
  "FLY_APP_NAME",
  "RAILWAY_ENVIRONMENT",
  "K_SERVICE", // Cloud Run
  "NETLIFY",
] as const

/**
 * Boot-time check for a deploy where per-IP limits can't work, or null
 * when nothing looks wrong. Heuristic (we can't see the network):
 *
 * - Only production (`next start`); dev on localhost has no clients.
 * - A known proxying platform → fine.
 * - `TRUSTED_PROXY_HOPS=0` → every anonymous caller shares one bucket.
 * - `TRUSTED_PROXY_HOPS` unset → the default of 1 assumes a reverse
 *   proxy. If Next.js is exposed directly, that's spoofable: Next only
 *   sets `X-Forwarded-For` when the request has none, so a client that
 *   sends its own XFF picks its own rate-limit key. Setting the var
 *   explicitly (≥ 1) is taken as the operator confirming the proxy.
 */
export function proxyConfigWarning(
  env: Record<string, string | undefined> = process.env
): string | null {
  if (env.NODE_ENV !== "production") return null
  if (PROXYING_PLATFORM_ENV.some((name) => Boolean(env[name]))) return null
  const raw = env.TRUSTED_PROXY_HOPS
  if (raw !== undefined && raw.trim() !== "" && trustedProxyHopsFromEnv(raw) === 0) {
    return (
      "[rate-limit] TRUSTED_PROXY_HOPS=0: X-Forwarded-For is ignored, so every " +
      "anonymous caller shares ONE rate-limit bucket. Per-IP limits need a reverse " +
      "proxy (Caddy / Nginx) in front of Next.js and TRUSTED_PROXY_HOPS set to the " +
      "number of proxies."
    )
  }
  if (raw === undefined || raw.trim() === "") {
    return (
      "[rate-limit] TRUSTED_PROXY_HOPS is unset, so the client IP is read as if ONE " +
      "reverse proxy appends to X-Forwarded-For. If Next.js is exposed directly, " +
      "clients can send their own X-Forwarded-For and choose their rate-limit key " +
      "(Next.js only sets the header when it's absent). Put a reverse proxy in front " +
      "and set TRUSTED_PROXY_HOPS to the number of proxies to confirm the setup."
    )
  }
  return null
}

let proxyWarningLogged = false

/** Log `proxyConfigWarning` once per process. Called from
 *  `instrumentation.ts` at server start. */
export function warnOnProxyConfig(
  env: Record<string, string | undefined> = process.env,
  log: (message: string) => void = console.warn
): void {
  if (proxyWarningLogged) return
  const warning = proxyConfigWarning(env)
  if (!warning) return
  proxyWarningLogged = true
  log(warning)
}

/**
 * Standard rate-limit key derivation: the client IP per
 * `clientIpFromHeaders` (platform headers on Vercel, else the
 * right-most-trusted `X-Forwarded-For` entry per `TRUSTED_PROXY_HOPS`).
 * Falls back to a single shared bucket so an unconfigured deploy still
 * limits abuse to one global rate rather than going unbounded.
 */
export function rateLimitKey(req: { headers: HeaderSource }): string {
  return (
    clientIpFromHeaders(req.headers, {
      trustedProxyHops: trustedProxyHopsFromEnv(),
      trustPlatformHeaders: Boolean(process.env.VERCEL),
    }) ?? "default"
  )
}
