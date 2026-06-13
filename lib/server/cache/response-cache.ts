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
/** Cosine-similarity floor for a Phase-2 near-match hit. Tight on purpose
 *  (a near-match serves a *similar* input's answer, not a byte-identical
 *  one). Tune by editing + bumping CACHE_VERSION. */
const SIMILARITY_THRESHOLD = 0.97

interface Entry {
  value: unknown
  expires: number
  /** Phase 2: the input's embedding, present only for entries whose caller
   *  opted into similarity matching. Absent → never matched by similarity. */
  embedding?: number[]
  /** Phase 2: `kind|mode|model` — similarity only matches within one scope,
   *  so a file summary never matches another mode or another model. */
  scope?: string
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
export function setCachedResponse(
  key: string,
  value: unknown,
  opts?: { embedding?: number[]; scope?: string },
): void {
  store.delete(key)
  store.set(key, {
    value,
    expires: Date.now() + TTL_MS,
    embedding: opts?.embedding,
    scope: opts?.scope,
  })
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
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
      store.delete(key)
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
}
