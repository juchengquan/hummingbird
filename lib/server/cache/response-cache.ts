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
 * Keys are content-derived, optionally partitioned by a caller `scope`
 * (see `@/server/cache/caller-scope`). Callers that use the Phase-2
 * near-match lookup MUST pass a caller scope in both the exact key and the
 * similarity scope: a near-match serves the answer to a *similar* input,
 * which may be another user's document, so it must never cross callers.
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
/** Approximate memory budget across all entries (values + embeddings).
 *  An extraction result carries up to ~1 MB of `fullText` plus a 100 KB
 *  `text`, so the entry cap alone allowed ~1 GB. LRU-evicted beyond. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** A single value bigger than this isn't cached at all (it would evict
 *  a large share of the cache for one hit). */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024
/** Cosine-similarity floor for a Phase-2 near-match hit. Tight on purpose
 *  (a near-match serves a *similar* input's answer, not a byte-identical
 *  one). Tune by editing + bumping CACHE_VERSION. */
const SIMILARITY_THRESHOLD = 0.97

interface Entry {
  value: unknown
  expires: number
  /** Approximate in-memory size (see `approxBytes`). */
  bytes: number
  /** Phase 2: the input's embedding, present only for entries whose caller
   *  opted into similarity matching. Absent → never matched by similarity. */
  embedding?: number[]
  /** Phase 2: `kind|caller|mode|model` — similarity only matches within one
   *  scope, so a file summary never matches another caller, mode or model. */
  scope?: string
}

// Insertion order in a Map is the LRU order: `get` re-inserts a hit to the
// end (most-recent), eviction drops from the front (least-recent).
const store = new Map<string, Entry>()
let totalBytes = 0

function drop(key: string): void {
  const entry = store.get(key)
  if (!entry) return
  totalBytes -= entry.bytes
  store.delete(key)
}

/** Approximate heap size of a cached value: its JSON length x 2 (JS
 *  strings are UTF-16) plus 8 bytes per embedding dimension. A value
 *  that doesn't serialise counts as infinite (never cached). */
function approxBytes(value: unknown, embedding?: number[]): number {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return Number.POSITIVE_INFINITY
  }
  return (json?.length ?? 0) * 2 + (embedding?.length ?? 0) * 8
}

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
  /** Caller partition (e.g. `user:<id>`). Omitted → shared across callers
   *  (keys stay identical to the pre-scope format). */
  scope?: string
}): string {
  const payload = JSON.stringify([
    CACHE_VERSION,
    parts.kind,
    parts.model,
    stableStringify(parts.input),
    ...(parts.scope !== undefined ? [parts.scope] : []),
  ])
  return createHash("sha256").update(payload).digest("hex")
}

/** Return the cached value for `key`, or `undefined` on miss / expiry. */
export function getCachedResponse<T>(key: string): T | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (entry.expires <= Date.now()) {
    drop(key)
    return undefined
  }
  // LRU touch: re-insert so it becomes most-recently-used.
  store.delete(key)
  store.set(key, entry)
  return entry.value as T
}

/** Store `value` under `key`, evicting the least-recently-used entries
 *  beyond the entry cap or the byte budget. A value over
 *  `MAX_ENTRY_BYTES` isn't stored (an older entry under the same key is
 *  still dropped, so a stale value can't outlive it). */
export function setCachedResponse(
  key: string,
  value: unknown,
  opts?: { embedding?: number[]; scope?: string },
): void {
  drop(key)
  const bytes = approxBytes(value, opts?.embedding)
  if (bytes > MAX_ENTRY_BYTES) return
  store.set(key, {
    value,
    expires: Date.now() + TTL_MS,
    bytes,
    embedding: opts?.embedding,
    scope: opts?.scope,
  })
  totalBytes += bytes
  while (store.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    drop(oldest)
  }
}

/** Cosine similarity of two equal-length vectors. Returns -1 ("no match")
 *  on a length mismatch (e.g. EMBEDDING_DIM changed across a restart) or a
 *  zero-norm vector, so a guard value can never clear a positive threshold. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return -1
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Phase 2 near-match lookup. Scans entries within `scope` that carry an
 * embedding, returns the value of the highest-cosine entry at or above
 * `threshold` (default SIMILARITY_THRESHOLD), or undefined. Expired entries
 * encountered are dropped. The winning entry is LRU-touched.
 */
export function findSimilarCachedResponse<T>(opts: {
  scope: string
  embedding: number[]
  threshold?: number
}): T | undefined {
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD
  const now = Date.now()
  let bestKey: string | undefined
  let bestScore = threshold
  let bestValue: unknown
  for (const [key, entry] of store) {
    if (entry.expires <= now) {
      drop(key)
      continue
    }
    if (entry.scope !== opts.scope || !entry.embedding) continue
    const score = cosine(opts.embedding, entry.embedding)
    if (score >= threshold && score >= bestScore) {
      bestScore = score
      bestKey = key
      bestValue = entry.value
    }
  }
  if (bestKey === undefined) return undefined
  const entry = store.get(bestKey)
  if (entry) {
    store.delete(bestKey)
    store.set(bestKey, entry)
  }
  return bestValue as T
}

/** Test-only: drop all entries so cases don't bleed into each other. */
export function __clearResponseCache(): void {
  store.clear()
  totalBytes = 0
}

/** Test-only: entry count + approximate bytes held. */
export function __responseCacheStats(): { entries: number; bytes: number } {
  return { entries: store.size, bytes: totalBytes }
}

/** Test-only: the configured byte limits. */
export const __RESPONSE_CACHE_LIMITS = {
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
} as const

/** Test-only: force an entry's expiry into the past so expiry/eviction
 *  paths can be exercised without waiting out TTL_MS. */
export function __expireEntry(key: string): void {
  const entry = store.get(key)
  if (entry) entry.expires = 0
}
