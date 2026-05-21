import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { z } from "zod"

import { fetchUrlBookmark, type FetchError } from "@/server/url/fetch"
import { normalizeUrl } from "@/server/url/validate"

/**
 * Fetch + extract a URL as a bookmark snapshot. Used by the "Add
 * bookmark" UI in the Links tab and by the per-row Refresh button.
 *
 * Body: `{ url: string }`
 * Response on success: `{ ok: true, bookmark: BookmarkSnapshot }`
 * Response on failure: `{ ok: false, error: { code, message } }`
 *   - 400 — validation, bad URL, SSRF reject, unsupported content type
 *   - 408 — fetch timed out
 *   - 413 — body too large
 *   - 429 — rate limit (per IP, in-memory sliding window)
 *   - 502 — upstream HTTP error / network failure
 *
 * Rate limit: 30 fetches per minute per client IP. Sliding window in
 * a module-level Map; survives restart isn't worth the complexity for
 * a feature where the worst case is a server-side cost the attacker
 * pays for too.
 */

const BodySchema = z.object({
  url: z.string().min(1).max(2000),
})

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 30
const rateLimitBuckets = new Map<string, number[]>()

function rateLimitKey(req: NextRequest): string {
  // Prefer X-Forwarded-For (the deployment proxy fills it in); fall back
  // to a single bucket so an unconfigured deploy still limits abuse.
  const forwarded = req.headers.get("x-forwarded-for")
  if (forwarded) {
    return forwarded.split(",")[0].trim()
  }
  return "default"
}

function consumeRateLimit(key: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now()
  const bucket = rateLimitBuckets.get(key) ?? []
  // Drop entries outside the window.
  const fresh = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  if (fresh.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldest = fresh[0]
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldest)
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
  }
  fresh.push(now)
  rateLimitBuckets.set(key, fresh)
  return { allowed: true, retryAfterSec: 0 }
}

export async function POST(req: NextRequest) {
  const rateKey = rateLimitKey(req)
  const limit = consumeRateLimit(rateKey)
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "rate_limited",
          message: `Too many fetches. Retry in ${limit.retryAfterSec}s.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec) },
      }
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_json", message: "Invalid JSON body" } },
      { status: 400 }
    )
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "invalid_body", message: parsed.error.message },
      },
      { status: 400 }
    )
  }

  const normalized = normalizeUrl(parsed.data.url)
  if (!normalized) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "invalid_url",
          message: "URL is not parseable",
        },
      },
      { status: 400 }
    )
  }

  const result = await fetchUrlBookmark(normalized)
  if (!result.ok) {
    const status = httpStatusFor(result.error)
    return NextResponse.json(
      { ok: false, error: result.error },
      { status }
    )
  }
  return NextResponse.json({ ok: true, bookmark: result.snapshot })
}

function httpStatusFor(error: FetchError): number {
  switch (error.code) {
    case "validation":
    case "unsupported_content_type":
      return 400
    case "timeout":
      return 408
    case "body_too_large":
      return 413
    case "too_many_redirects":
      return 502
    case "http_error":
      // Pass through upstream 4xx/5xx as 502 to make it clear the
      // failure was on the target, not us. The original status is in
      // the error body.
      return 502
    case "network":
      return 502
    default:
      return 500
  }
}
