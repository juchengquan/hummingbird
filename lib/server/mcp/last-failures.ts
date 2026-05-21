import "server-only"

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
 * Tradeoffs:
 * - **Per-server granularity**, not per-resource. If one resource on
 *   a server times out, we assume the whole server is sick — every
 *   `readResource` against it hits the same socket. The next-turn
 *   wakeup might mask a per-resource issue (e.g. one missing URI)
 *   but those re-surface after the cooldown.
 * - **In-process Map**, not Redis / Supabase. A new serverless
 *   instance starts cold; the cache is purely an opportunistic
 *   optimization for hot paths. Cold-start cost is one timeout per
 *   server, same as today.
 * - **Cooldown = 30 s.** Long enough to bridge a typical "server is
 *   down" period and avoid hammering a flaky upstream; short enough
 *   that recovery from a fix doesn't require waiting forever.
 *
 * If multiple attached resources share a sick server, the
 * concurrent first-turn `readResource` calls can ALL race to the
 * timeout before the cache fills — that's fine, they all time out
 * concurrently (same wall-clock cost as today). The cache shines on
 * turn 2+.
 */

const FAILURE_TTL_MS = 30_000

interface CachedFailure {
  /** `Date.now()` at the moment of failure. */
  at: number
  /** Error message to surface to the renderer. */
  reason: string
}

const failures = new Map<string, CachedFailure>()

/**
 * Return the cached failure reason if the server failed within the
 * cooldown window, or `null` if either the entry is missing or has
 * expired (lazy expiry — the entry is removed on the way out).
 */
export function getRecentFailure(serverId: string): string | null {
  const entry = failures.get(serverId)
  if (!entry) return null
  if (Date.now() - entry.at > FAILURE_TTL_MS) {
    failures.delete(serverId)
    return null
  }
  return entry.reason
}

/** Record a fresh failure. Overwrites any existing entry. */
export function recordFailure(serverId: string, reason: string): void {
  failures.set(serverId, { at: Date.now(), reason })
}

/** Clear a server's cached failure — useful when the caller knows
 *  the server has been re-configured or re-credentialed and wants to
 *  retry immediately rather than waiting out the cooldown. */
export function clearFailure(serverId: string): void {
  failures.delete(serverId)
}

/** Test-only: wipe the entire cache. */
export function _resetForTests(): void {
  failures.clear()
}
