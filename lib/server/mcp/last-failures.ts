import "server-only"

import { createHash } from "node:crypto"

/**
 * Short-lived in-process cache of MCP server read failures.
 *
 * Purpose: when an attached MCP server is dead, every chat turn that
 * references its resources pays the full per-call timeout
 * (`READ_TIMEOUT_MS` in `inject-resources.ts` — 5 seconds). For users
 * with one bad attachment that's 5 s of pre-stream stall on every
 * single message. This cache short-circuits subsequent reads against
 * a recently-failed server with the cached error, so only the *first*
 * turn after a failure pays the timeout.
 *
 * Isolation. `serverId` is chosen by the client, so it can't be the key
 * on its own: two callers could share an id, and the cached reason is
 * rendered into the *other* caller's system prompt. Entries are keyed by
 * caller (user id, or the anonymous client key) + serverId + a hash of
 * the server URL, and the stored reason is a short generic category
 * (`describeMcpFailure`) — never the upstream error text, which the MCP
 * SDK fills with the upstream response body.
 *
 * Memory is bounded: entries expire after the 30 s cooldown (swept
 * lazily on read and on every write once per TTL), and an LRU cap
 * evicts the oldest entries past `MAX_ENTRIES`.
 *
 * Tradeoffs:
 * - **Per-server granularity**, not per-resource. If one resource on
 *   a server times out, we assume the whole server is sick.
 * - **In-process Map**, not Redis / Supabase. A cold instance pays one
 *   timeout per server, same as with no cache.
 * - **Cooldown = 30 s.** Bridges a typical outage without making
 *   recovery wait long.
 */

const FAILURE_TTL_MS = 30_000
const MAX_ENTRIES = 1_000
const MAX_REASON_LENGTH = 80

interface CachedFailure {
  /** `Date.now()` at the moment of failure. */
  at: number
  /** Short generic reason (see `describeMcpFailure`). */
  reason: string
}

/** Who saw the failure, and against which server endpoint. */
export interface FailureScope {
  /** `user:<id>` when signed in, else the anonymous client key. */
  caller: string
  serverId: string
  url: string
}

// Map insertion order doubles as LRU order (re-inserted on write).
const failures = new Map<string, CachedFailure>()
let lastSweep = Date.now()

function keyOf(scope: FailureScope): string {
  const urlHash = createHash("sha256").update(scope.url).digest("hex").slice(0, 16)
  return JSON.stringify([scope.caller, scope.serverId, urlHash])
}

function sweep(now: number): void {
  lastSweep = now
  for (const [key, entry] of failures) {
    if (now - entry.at > FAILURE_TTL_MS) failures.delete(key)
  }
}

/**
 * Map an MCP failure to a short, generic reason that is safe to put in
 * a model prompt: a category plus, at most, an HTTP status. Upstream
 * response text never passes through.
 */
export function describeMcpFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : ""
  const message = err instanceof Error ? err.message : String(err)
  let reason: string
  if (name === "McpUrlBlockedError") {
    reason = "server URL blocked by policy"
  } else if (/timed out|timeout|aborted/i.test(message)) {
    reason = "timed out"
  } else {
    const status = /\bHTTP\s*(\d{3})\b/i.exec(message)?.[1]
    if (status === "401" || status === "403") reason = `authentication failed (HTTP ${status})`
    else if (status) reason = `upstream returned HTTP ${status}`
    else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(message))
      reason = "connection failed"
    else reason = "request failed"
  }
  return reason.slice(0, MAX_REASON_LENGTH)
}

/**
 * Return the cached failure reason if this caller's server failed within
 * the cooldown window, or `null` if the entry is missing or expired
 * (lazy expiry — the entry is removed on the way out).
 */
export function getRecentFailure(scope: FailureScope): string | null {
  const key = keyOf(scope)
  const entry = failures.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > FAILURE_TTL_MS) {
    failures.delete(key)
    return null
  }
  return entry.reason
}

/** Record a fresh failure (stored as a generic reason). Overwrites any
 *  existing entry for the same scope. Returns the stored reason. */
export function recordFailure(scope: FailureScope, err: unknown): string {
  const now = Date.now()
  if (now - lastSweep >= FAILURE_TTL_MS) sweep(now)
  const key = keyOf(scope)
  const reason = describeMcpFailure(err)
  failures.delete(key)
  failures.set(key, { at: now, reason })
  while (failures.size > MAX_ENTRIES) {
    const oldest = failures.keys().next().value
    if (oldest === undefined) break
    failures.delete(oldest)
  }
  return reason
}

/** Clear a server's cached failure — useful when the caller knows
 *  the server has been re-configured or re-credentialed and wants to
 *  retry immediately rather than waiting out the cooldown. */
export function clearFailure(scope: FailureScope): void {
  failures.delete(keyOf(scope))
}

/** Test-only: wipe the entire cache. */
export function _resetForTests(): void {
  failures.clear()
  lastSweep = Date.now()
}

/** Test-only: number of cached entries. */
export function _sizeForTests(): number {
  return failures.size
}
