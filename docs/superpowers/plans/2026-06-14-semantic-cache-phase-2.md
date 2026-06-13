# Semantic Caching Phase 2 (in-process, file-mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add embedding-similarity near-match to the `file` summarize cache path so a lightly-edited/paraphrased file reuses a recent summary instead of paying for a fresh model call.

**Architecture:** Keep `lib/server/cache/response-cache.ts` embedding-agnostic — it stores and compares vectors passed in (`Entry` gains `embedding`/`scope`; new pure `cosine` + `findSimilarCachedResponse`). The summarize route owns calling `embedText` and does the similarity lookup on an exact-key miss, scoped by `summarize|file|<model>`. In-process (mirrors Phase 1), no DB/auth/migration.

**Tech Stack:** TypeScript, `bun:test`, the shipped embeddings provider (`lib/server/embeddings/provider.ts`), Next.js route handler.

Design spec: `docs/superpowers/specs/2026-06-14-semantic-cache-phase-2-design.md`.

---

### Task 1: Cache module — `cosine`, `findSimilarCachedResponse`, embedding-bearing entries

**Files:**
- Modify: `lib/server/cache/response-cache.ts`
- Test: `lib/server/cache/response-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `cosine` and `findSimilarCachedResponse` to the EXISTING import block at the top of `lib/server/cache/response-cache.test.ts` (it already imports `__clearResponseCache`, `getCachedResponse`, `responseCacheKey`, `setCachedResponse` from `"./response-cache"`; add the two new names — do NOT add a second import line). Then append:

```ts
describe("cosine", () => {
  test("identical vectors → 1", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10)
  })
  test("orthogonal vectors → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })
  test("length mismatch → -1 (no match)", () => {
    expect(cosine([1, 0, 0], [1, 0])).toBe(-1)
  })
  test("zero vector → -1 (no match)", () => {
    expect(cosine([0, 0], [1, 0])).toBe(-1)
  })
})

describe("findSimilarCachedResponse", () => {
  const SCOPE = "summarize|file|m"

  test("returns the value of an entry above the threshold", () => {
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    const hit = findSimilarCachedResponse<string>({
      scope: SCOPE,
      embedding: [1, 0, 0],
    })
    expect(hit).toBe("summary-A")
  })

  test("misses when cosine is below the threshold", () => {
    // [1,0,0] vs [0,1,0] → cosine 0 < default 0.97
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    const hit = findSimilarCachedResponse<string>({
      scope: SCOPE,
      embedding: [0, 1, 0],
    })
    expect(hit).toBeUndefined()
  })

  test("respects an explicit threshold (boundary)", () => {
    // [1,0,0] vs [0.95, 0.3122..., 0] is a unit vector with cosine ≈ 0.95
    const near: number[] = [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: near, threshold: 0.9 }),
    ).toBe("summary-A")
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: near, threshold: 0.97 }),
    ).toBeUndefined()
  })

  test("does not match across scope", () => {
    setCachedResponse("k1", "summary-A", { embedding: [1, 0, 0], scope: SCOPE })
    expect(
      findSimilarCachedResponse<string>({
        scope: "summarize|file|other-model",
        embedding: [1, 0, 0],
      }),
    ).toBeUndefined()
  })

  test("ignores entries stored without an embedding (2-arg setCachedResponse)", () => {
    setCachedResponse("k1", "plain")
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: [1, 0, 0] }),
    ).toBeUndefined()
  })

  test("picks the highest-scoring entry when several qualify", () => {
    setCachedResponse("k1", "far", { embedding: [0.98, 0.199, 0], scope: SCOPE })
    setCachedResponse("k2", "near", { embedding: [1, 0, 0], scope: SCOPE })
    expect(
      findSimilarCachedResponse<string>({ scope: SCOPE, embedding: [1, 0, 0] }),
    ).toBe("near")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/server/cache/response-cache.test.ts`
Expected: FAIL — `cosine`/`findSimilarCachedResponse` are not exported.

- [ ] **Step 3: Implement in `response-cache.ts`**

Add the threshold const near the other consts (after `MAX_ENTRIES`):

```ts
/** Cosine-similarity floor for a Phase-2 near-match hit. Tight on purpose
 *  (a near-match serves a *similar* input's answer, not a byte-identical
 *  one). Tune by editing + bumping CACHE_VERSION. */
const SIMILARITY_THRESHOLD = 0.97
```

Extend the `Entry` interface:

```ts
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
```

Replace `setCachedResponse` with the 3-arg form (backward-compatible — `opts` is optional):

```ts
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
```

Add the two new exports (place after `setCachedResponse`):

```ts
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
  let bestScore = threshold // must strictly clear the floor to win
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
  // LRU touch the winner.
  const entry = store.get(bestKey)
  if (entry) {
    store.delete(bestKey)
    store.set(bestKey, entry)
  }
  return bestValue as T
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/server/cache/response-cache.test.ts`
Expected: PASS (existing + new). Also run `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/server/cache/response-cache.ts lib/server/cache/response-cache.test.ts
git commit -m "feat(cache): cosine + findSimilarCachedResponse for semantic near-match"
```

---

### Task 2: Wire file-mode similarity into the summarize route

**Files:**
- Modify: `app/api/summarize/route.ts`

No new test: there is no summarize-route test harness, and the route imports `ai`/structured-output with no DI seam (a route test would be the repo's first and brittle). The matching logic is fully covered by Task 1's pure tests; this task is verified by `bun run typecheck` + `bun run lint` and a manual trace. The route wiring is intentionally thin (compute embedding once, one lookup, store with embedding on miss).

- [ ] **Step 1: Add imports**

In `app/api/summarize/route.ts`, add `findSimilarCachedResponse` to the existing import from `@/server/cache/response-cache`:

```ts
import {
  findSimilarCachedResponse,
  getCachedResponse,
  responseCacheKey,
  setCachedResponse,
} from '@/server/cache/response-cache'
```

Add a new import for the embeddings provider (place after the model-provider import):

```ts
import { embedText, isEmbeddingConfigured } from '@/server/embeddings/provider'
```

- [ ] **Step 2: Insert the similarity lookup + embedding-bearing store**

The current cache block reads:

```ts
  const cached = getCachedResponse(cacheKey)
  if (cached !== undefined) return NextResponse.json(cached)
  // Cache + respond on the success paths only (never error responses).
  const respondCached = (payload: unknown) => {
    setCachedResponse(cacheKey, payload)
    return NextResponse.json(payload)
  }
```

Replace it with (adds the file-mode Phase-2 path; non-file modes are unchanged):

```ts
  const cached = getCachedResponse(cacheKey)
  if (cached !== undefined) return NextResponse.json(cached)

  // Semantic near-match (PLAN-semantic-caching Phase 2) — file mode only.
  // On an exact-key miss, embed the file text once and look for a recent
  // summary of a near-identical document (same model). Advisory: any
  // embedding failure just falls through to the model call. Inert unless
  // an embeddings provider is configured.
  const similarityScope = `summarize|file|${modelId}`
  let fileEmbedding: number[] | undefined
  if (body.mode === 'file' && isEmbeddingConfigured()) {
    try {
      fileEmbedding = await embedText(body.text)
      const similar = findSimilarCachedResponse({
        scope: similarityScope,
        embedding: fileEmbedding,
      })
      if (similar !== undefined) return NextResponse.json(similar)
    } catch {
      // Embedding provider unavailable/errored — skip similarity, run the model.
      fileEmbedding = undefined
    }
  }

  // Cache + respond on the success paths only (never error responses).
  const respondCached = (payload: unknown) => {
    setCachedResponse(
      cacheKey,
      payload,
      body.mode === 'file' && fileEmbedding
        ? { embedding: fileEmbedding, scope: similarityScope }
        : undefined,
    )
    return NextResponse.json(payload)
  }
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors). `body.text` is in scope inside the `body.mode === 'file'` narrow; `modelId` is already defined above the block.

- [ ] **Step 4: Manual trace (no command — confirm by reading)**

Confirm: (a) exact-key hit still returns first; (b) for non-file modes nothing changed (`fileEmbedding` stays undefined → `respondCached` passes `undefined` opts → 2-arg behavior); (c) when embeddings are unconfigured, file mode behaves exactly like Phase 1; (d) the embedding is computed at most once and reused by `respondCached`.

- [ ] **Step 5: Commit**

```bash
git add app/api/summarize/route.ts
git commit -m "feat(summarize): semantic near-match cache on file mode"
```

---

### Task 3: Correct the stale plan doc

**Files:**
- Modify: `docs/PLAN-semantic-caching.md`

- [ ] **Step 1: Read the doc's storage description**

Run: `grep -n "pgvector\|response_cache\|Supabase\|in-process\|Phase 2\|Phase 1" docs/PLAN-semantic-caching.md`
Read the surrounding sections so the correction is accurate.

- [ ] **Step 2: Update the status + storage description**

Edit `docs/PLAN-semantic-caching.md` so it reflects what shipped:
- Phase 1 shipped as an **in-process bounded LRU + TTL** (`lib/server/cache/response-cache.ts`), NOT the Supabase `response_cache` pgvector table the original plan sketched (the summarize/extract routes have no Supabase session).
- Phase 2 shipped as an **in-process embedding-similarity near-match on `file` summarize mode** (`cosine` + `findSimilarCachedResponse`, scope `kind|mode|model`, threshold 0.97), reusing the shipped embeddings provider — a **deliberate** continuation of the in-process model. Note the limitation: the cache (and its vectors) don't survive a restart and aren't shared cross-instance — acceptable for the single-VM deploy target. Note follow-ups left open: `project-breakdown` mode; a persistent/cross-instance pgvector variant if the deploy model ever changes.
- Mark the doc status line as Phase 1 + Phase 2 (file mode) shipped.

Keep the edit tight — update the inaccurate sections, don't rewrite the whole document.

- [ ] **Step 3: Commit**

```bash
git add docs/PLAN-semantic-caching.md
git commit -m "docs: correct semantic-caching plan to match shipped in-process design"
```

---

### Task 4: Full gate + PR

**Files:** none (verification only).

- [ ] **Step 1: TS gate**

Run: `bun run check`
Expected: typecheck + lint clean; `bun test` — confirm `bun test lib/server/cache/response-cache.test.ts` passes and no NEW failures elsewhere (the whole-suite `bun test` has pre-existing env failures: `app/api/tasks` needs live Postgres, `lib/server/.../minimax` needs network, `services/agent-ts` missing its `postgres` dep — those are unrelated).

- [ ] **Step 2: user-manual drift check**

Run: `bun run docs:user-manual:check`
Expected: up to date (no env vars / panels added).

- [ ] **Step 3: Push + open the PR**

```bash
git push -u origin feat/semantic-cache-phase-2
gh pr create --base dev --title "feat: semantic caching Phase 2 (in-process near-match, file mode)" --body "Implements docs/superpowers/specs/2026-06-14-semantic-cache-phase-2-design.md."
```

(Per the repo's PR rules, auto-subscribe if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **Why the cache module never imports the embeddings provider:** the route owns the one `embedText` call (it has the text); the cache only compares vectors. This keeps `response-cache.ts` pure and unit-testable with plain arrays (Task 1 needs no embedder mock).
- **Threshold strictness:** `findSimilarCachedResponse` seeds `bestScore = threshold` and requires `score >= threshold` AND `score >= bestScore`, so a score exactly at the floor wins only if nothing higher exists, and a guard `-1` can never clear a positive floor.
- **Env gate:** with no `EMBEDDINGS_BASE_URL`/`OLLAMA_BASE_URL`, `isEmbeddingConfigured()` is false → the whole Phase-2 path is a no-op and `file` mode behaves exactly like Phase 1. So default CI/deploys are unaffected.
- **`extract` and non-file summarize modes are deliberately untouched** — they keep 2-arg `setCachedResponse` (exact-key only).
