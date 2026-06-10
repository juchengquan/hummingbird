import "server-only"

import { createHash } from "node:crypto"

/**
 * In-process response cache for the deterministic non-chat calls
 * (summaries, file extraction). Phase 1 of docs/PLAN-semantic-caching.md.
 *
 * Exact-key only: the key is a SHA-256 of the canonicalised request, so a
 * cache hit is byte-identical to what a miss would have produced -- it can
 * never serve a wrong answer (SHA-256 collision risk is negligible). The
 * "semantic" similarity layer (match near-duplicate inputs) is Phase 2 and
 * needs an embedding pipeline that doesn't exist yet.
 *
 * Storage is an in-memory bounded LRU + TTL. The deploy target is a
 * long-running server (a VM), so module state persists across requests --
 * which captures the repeat value (re-summarising the same file, re-running
 * an unchanged TL;DR). A persistent / cross-device variant (Supabase /
 * pgvector) is a Phase-2 follow-up.
 *
 * Keys are content-derived, not user-derived: a hit only happens when the
 * caller supplies the identical input, so the returned value is the answer
 * for the input they themselves provided -- safe to share across users with
 * no leak, and no per-user keying needed.
 *
 * Never used for the chat stream -- only the deterministic side-calls.
 */

/** Bump to invalidate every entry at once -- e.g. after a prompt change
 *  that would make previously-cached answers stale. Part of every key. */
const CACHE_VERSION = "v1"
/** Per-entry lifetime. In-memory, so this mostly bounds staleness across
 *  long uptimes; MAX_ENTRIES bounds memory. */
const TTL_MS = 60 * 60 * 1000
/** LRU cap. Evicts least-recently-used beyond this. */
const MAX_ENTRIES = 500

interface Entry {
  value: unknown
  expires: number
}

// Insertion order in a Map is the LRU order: `get` re-inserts a hit to the
// end (most-recent), eviction drops from the front (least-recent).
const store = new Map<string, Entry>()

/**
 * Deterministic JSON: object keys sorted recursively so the same logical
 * input always serialises identically regardless of property order. Arrays
 * keep their order -- message order is semantically meaningful, so it must
 * affect the key.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`
}

/**
 * Build a cache key from the call kind, the resolved model id, and the
 * canonicalised input. Anything that changes the answer must be in here;
 * volatile noise (timestamps, ids) must be stripped by the caller before
 * passing `input`. Parts are JSON-array-encoded before hashing so there's
 * no delimiter ambiguity between fields.
 */
export function responseCacheKey(parts: {
  kind: string
  model: string
  input: unknown
}): string {
  const payload = JSON.stringify([
    CACHE_VERSION,
    parts.kind,
    parts.model,
    stableStringify(parts.input),
  ])
  return createHash("sha256").update(payload).digest("hex")
}

/** Return the cached value for `key`, or `undefined` on miss / expiry. */
export function getCachedResponse<T>(key: string): T | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (entry.expires <= Date.now()) {
    store.delete(key)
    return undefined
  }
  // LRU touch: re-insert so it becomes most-recently-used.
  store.delete(key)
  store.set(key, entry)
  return entry.value as T
}

/** Store `value` under `key`, evicting the least-recently-used entries
 *  beyond the cap. */
export function setCachedResponse(key: string, value: unknown): void {
  store.delete(key)
  store.set(key, { value, expires: Date.now() + TTL_MS })
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/** Test-only: drop all entries so cases don't bleed into each other. */
export function __clearResponseCache(): void {
  store.clear()
}
