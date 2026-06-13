# Semantic caching Phase 2 (in-process, file-mode) — Design

Status: **approved design — ready for implementation plan.**
Origin: `docs/PLAN-semantic-caching.md` Phase 2 ("semantic similarity / near-match"). Phase 1 (exact-key LRU) shipped in `lib/server/cache/response-cache.ts`.

## Why

Phase 1's cache only hits on a **byte-identical** request — a one-character edit to a file misses and pays for a fresh summary. Phase 2 adds an embedding-similarity near-match so a lightly-edited or paraphrased input can reuse a recent summary. Scoped to the **`file` summarize mode** for v1: re-summarising an edited document is the canonical near-duplicate case, and a file has a single clean text to embed.

The embedding pipeline this needs already shipped (`lib/server/embeddings/provider.ts` — `embedText`, `isEmbeddingConfigured`, `EMBEDDING_DIM = 768`), so Phase 2 is now unblocked.

## Scope / non-goals (YAGNI)

- **`file` summarize mode only.** `conversation` / `compress` (message arrays — awkward to embed, near-dup rare) and `project-breakdown` (plausible but lower-frequency) stay exact-key for now; adding `project-breakdown` later is a trivial follow-up. `extract` is **never** semantically cached (structured extraction must stay byte-exact).
- **In-process**, mirroring Phase 1's storage. NOT the persistent pgvector `response_cache` table the plan doc sketches — that would require wiring per-user Supabase auth into the summarize route (scope-creep Phase 1 deliberately avoided). The in-process choice means the cache (and its vectors) don't survive a restart and aren't shared cross-instance — acceptable for the single-VM deploy target, and a **deliberate, documented** divergence (this design corrects the stale plan doc in the same PR).
- No env-tunable threshold, no new dependencies, no migration, no schema change.

## Architecture — keep the cache module embedding-agnostic

`response-cache.ts` stores and compares **vectors passed in**; it does NOT import the embeddings provider. The summarize **route** owns calling `embedText` (it's the one site with the text). This keeps the cache module pure (unit-testable with plain vectors, no embedder mock) and confines the embedding dependency to one call site.

## Cache module changes — `lib/server/cache/response-cache.ts`

```ts
const SIMILARITY_THRESHOLD = 0.97   // module const; tune by editing + bumping CACHE_VERSION

interface Entry {
  value: unknown
  expires: number
  embedding?: number[]   // present only for entries the caller opted into similarity for
  scope?: string         // e.g. "summarize|file|<modelId>" — similarity only matches same scope
}
```

- **`setCachedResponse(key, value, opts?: { embedding?: number[]; scope?: string })`** — backward-compatible third arg. Existing 2-arg callers (the `extract` route, the other summarize modes) are unchanged and store no embedding, so they never participate in similarity.
- **`cosine(a: number[], b: number[]): number`** — pure. Returns `-1` (treated as "no match") when lengths differ (guards an `EMBEDDING_DIM` change across a restart) or either norm is zero; otherwise dot / (‖a‖·‖b‖).
- **`findSimilarCachedResponse<T>({ scope, embedding, threshold }): T | undefined`** — iterates `store` entries; considers only those with a matching `scope`, a present `embedding`, and not expired (drops expired ones it encounters, like `getCachedResponse`); computes `cosine` against each; returns the value of the highest-scoring entry whose cosine ≥ `threshold` (and LRU-touches that entry). `undefined` if none qualify.

`getCachedResponse` / `responseCacheKey` / `__clearResponseCache` are unchanged.

## Route wiring — `app/api/summarize/route.ts` (`file` mode only)

The scope string is `"summarize|file|${modelId}"` — `kind | mode | model`. Including `mode` is essential so a future `project-breakdown` entry (same kind + model) can never be returned for a `file` request.

Flow (only when `body.mode === 'file'`):
1. Exact-key lookup first (unchanged) → return on hit.
2. On exact miss, if `isEmbeddingConfigured()`:
   - `const embedding = await embedText(body.text)` (wrapped — see error handling)
   - `const similar = findSimilarCachedResponse({ scope, embedding, threshold: SIMILARITY_THRESHOLD })`
   - on hit → return it (no model call).
3. On full miss → `generateText` as today, then `setCachedResponse(cacheKey, payload, { embedding, scope })` so the result is reachable by both exact key and future similarity.

`body.text` is embedded as a **single document-level vector** (the goal is coarse "is this roughly the same document" matching, not chunk-level retrieval). `text` is capped at 50 000 chars by the request schema; the provider handles length (truncating if it must) — acceptable for a cache-match signal.

Non-file modes keep calling the 2-arg `setCachedResponse` (no behavior change). The embedding computed in step 2 is reused in step 3 (embed at most once per request).

**Cost guard:** an embed call happens at most once, and only on an exact-key miss with embeddings configured. Zero embed calls when embeddings are unconfigured → the path is a complete no-op and `file` mode behaves exactly like Phase 1.

## Error handling

- `isEmbeddingConfigured()` false → skip the similarity path entirely (default deploys unaffected; safe no-op). On a full miss, `setCachedResponse` is called WITHOUT an embedding (so the entry is exact-key only) — i.e. identical to Phase 1.
- `embedText` throws → catch, log nothing noisy, fall through to the model call (and store exact-key only). Caching is advisory; it must never block or fail the response.
- Dim mismatch / empty vector at compare time → `cosine` returns `-1`, the entry is skipped.

## Testing

**`lib/server/cache/response-cache.test.ts`** (pure, mirrors the existing `bun:test` structure + `__clearResponseCache` in `afterEach`; passes vectors directly — no embedder mock):
- identical vector → similarity hit returns the stored value;
- cosine just above `0.97` → hit; just below → miss (`undefined`);
- scope mismatch (same vector, different `scope` string) → miss;
- length-mismatch vector → miss (cosine guard);
- expired entry with an embedding → not returned (and dropped);
- LRU eviction still works when entries carry embeddings;
- 2-arg `setCachedResponse` still works (no embedding/scope → never matched by `findSimilarCachedResponse`).

**Route-level** (`app/api/summarize/route.ts`): with a mocked `embedText`,
- similarity hit → `generateText` called 0 times, returns the cached payload;
- full miss → `generateText` called once, then a subsequent near-duplicate request hits via similarity;
- `isEmbeddingConfigured()` false → behaves exactly like Phase 1 (no embed call, exact-key only).

Mirror the existing summarize route test setup if present; otherwise the cache-module tests carry the core logic and the route test asserts the wiring.

## Correctness tradeoff (explicit)

A similarity hit serves a *near*-duplicate's summary, not a byte-identical one. This is inherent to semantic caching; the tight `0.97` threshold bounds it, it is confined to `file` **summaries** (advisory output, not structured data), and `extract` is excluded entirely. The threshold and `CACHE_VERSION` are the levers if a near-match ever feels too loose.

## Touch-point summary

| File | Change |
|---|---|
| `lib/server/cache/response-cache.ts` | `SIMILARITY_THRESHOLD`; `Entry.embedding`/`scope`; 3-arg `setCachedResponse`; `cosine`; `findSimilarCachedResponse` |
| `app/api/summarize/route.ts` | file-mode miss path: embed once + similarity lookup + store embedding/scope |
| `lib/server/cache/response-cache.test.ts` | similarity / scope / threshold / cosine-guard / LRU tests |
| (route test, if a harness exists) | mocked-`embedText` wiring assertions |
| `docs/PLAN-semantic-caching.md` | correct the stale storage description (Phase 1 = in-process LRU; Phase 2 stays in-process — documented divergence + its limits) |

## Scope estimate

S–M. Two source files + tests; no migration, no auth, no new deps. The cosine/store/lookup changes are mechanical; the judgment is the threshold + the documented in-process divergence.
