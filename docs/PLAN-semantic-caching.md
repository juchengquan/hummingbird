# Plan: Semantic caching for deterministic calls

Status: **🪜 phased — Phase 1 (exact-key cache) shipped; Phase 2
(embedding-similarity) gated on the embedding pipeline.** Phase 1:
[#183](https://github.com/juchengquan/hummingbird/pull/183) on
2026-06-10 — `lib/server/cache/response-cache.ts` (in-process
bounded LRU + TTL, key = SHA-256 over `[CACHE_VERSION, kind, model,
stableStringify(input)]`); `/api/summarize` all four modes +
`/api/extract` cache success payloads only. Implementation note: used
an in-process cache rather than the Supabase table the plan sketched
because those routes have no Supabase session today (would mean
wiring per-user auth in — scope creep). Promoted from
[MASTER_PLAN § Later](MASTER_PLAN.md) (second research round,
2026-06-09) to **Next**. Origin: 2026 semantic-caching practice — see
[Sources](#sources).

## Why

This is **distinct** from the gateway *prompt* caching closed as
won't-do (inspirations #4 Part 1, which was about provider-side
prefix caching). Semantic caching matches a *new* request against
*prior* ones and serves the stored answer — reportedly ~31% of LLM
queries are semantic near-duplicates, and stacking app-level semantic
caching on provider caching reports 60-80% cost cuts.

Chat turns rarely repeat verbatim, so caching the conversational stream
is the wrong target. But Hummingbird makes a cluster of **deterministic,
low-temperature** server calls that *do* repeat:

- **`/api/summarize`** — file summaries, conversation TL;DRs, compress
  recaps, project breakdowns (`generateText`, temp 0.3).
- **Follow-up suggestions** — the post-turn JSON suggestion call.
- **`/api/extract`** — the auto-summary on file upload.

Re-summarising the *same file* or re-deriving suggestions for an
*unchanged* tail is pure waste. Caching *these* is a clean cost +
latency win with zero conversational-UX risk.

## Non-goals — what this is NOT

- **Not caching the chat stream.** Conversational turns are
  context-dependent and rarely repeat; caching them risks stale or
  wrong answers. Strictly the deterministic non-chat calls.
- **Not provider prefix caching.** That's the closed gateway item;
  orthogonal. This can stack on top of it.
- **Not a new vector database.** Phase 1 needs no embeddings at all
  (see below). Phase 2 reuses whatever embedding pipeline the
  Ollama/hybrid-search work lands — it does not introduce its own.
- **Not user-visible.** A cache hit returns the same shape as a miss;
  no UI surface beyond an optional "cached" debug flag.

## The embedding-pipeline reality (why this is phased)

A codebase survey confirms **there is no embedding pipeline today** —
retrieval is full-text (`tsvector`) only; `pgvector`/embeddings are
planned (hybrid search + cross-conversation memory) but unbuilt. So
"semantic" similarity matching can't land first. The plan splits:

- **Phase 1 — exact-key cache (no embeddings).** Normalise the request
  (mode + model + a canonical hash of the input) and cache the
  response. Catches the highest-value repeats — the *same* file
  re-summarised, the *same* conversation tail, an unchanged extract —
  with zero new infra.
- **Phase 2 — semantic similarity (after embeddings exist).** Once the
  Ollama-embeddings / hybrid-search pipeline lands, add an
  embedding-similarity lookup so *near*-duplicate inputs (a lightly
  edited file, a paraphrased goal) also hit.

## Decisions to pin before code

1. **Storage.** Phase 1: a Supabase `response_cache` table (no new
   infra) keyed by `(user_id, mode, model, input_hash)` → `response
   jsonb` + `created_at` + TTL, under own-rows RLS. Phase 2: add an
   `embedding vector` column (pgvector) for the similarity query, OR a
   Redis vector cache if hot-path latency demands it. **Default:
   Supabase table both phases; revisit Redis only if p99 lookup hurts.**
2. **What's cacheable.** Only calls with `temperature ≤ 0.3` and a
   deterministic contract — `summarize` (all four modes), suggestions,
   extract-summary. Never anything user-facing-creative.
3. **Keying / normalisation.** `input_hash = sha256(canonicalise(mode,
   model, normalisedInput))`. Normalisation strips volatile bits
   (timestamps, ids) so the *same* file/conversation hashes stably.
   The canonicaliser is a pure, tested function — getting it wrong
   either misses hits or serves wrong answers, so it's the crux.
4. **TTL + invalidation.** Default 30-day TTL; a file/conversation edit
   changes the input → new hash → natural miss (no explicit
   invalidation needed). A global `CACHE_VERSION` salt lets a prompt
   change bust the whole cache.
5. **Similarity threshold (Phase 2).** Cosine ≥ 0.97 to serve (tight —
   a wrong summary is worse than a cache miss). Tunable per mode.
6. **Where the cache lives in the call path.** A thin wrapper in
   `lib/server/cache/` that each deterministic handler opts into —
   `withResponseCache(key, () => generateText(...))`. Mirror in
   `services/agent-py` + `agent-ts` so caching works on every backend.

## Shape — code surface

### Phase 1 — exact-key cache

- `supabase/migrations/0024_response_cache.sql` — the table + RLS +
  a `(user_id, mode, model, input_hash)` unique index + a TTL sweep
  (or `created_at` filter on read).
- `lib/shared/cache/cache-key.ts` — pure `canonicaliseInput(mode,
  model, input)` + `hashInput(...)`. Tested hard.
- `lib/server/cache/response-cache.ts` —
  `withResponseCache({ userId, mode, model, input }, fn)`: look up →
  hit returns stored `response`; miss runs `fn`, stores, returns.
- Wire into `app/api/summarize/route.ts`, `app/api/extract/route.ts`,
  and the suggestion call in `app/api/chat/route.ts`. Python/TS twins
  in the service routers.

### Phase 2 — semantic similarity

- Migration adds `embedding vector(384)` (or the chosen dim) +
  an ivfflat/hnsw index.
- `response-cache.ts` gains a similarity path: embed the normalised
  input via the (by-then-existing) embedding helper, query nearest
  within threshold, serve on hit; fall through to exact-key + miss.

## Sequencing — PR series

1. **PR 1 — exact-key cache.** Migration + pure key/hash + the
   `withResponseCache` wrapper + wire the three Next.js call sites.
   Measurable hit-rate via a debug counter. Ship value with zero
   embedding dependency.
2. **PR 2 — service-backend parity.** The Python + TS twins so caching
   works through agent-py / agent-ts too.
3. **PR 3 (gated on embeddings) — semantic similarity.** Add the
   embedding column + the nearest-neighbour path once the embedding
   pipeline lands. Threshold tuning + per-mode config.

## Tests

- **Canonicalisation/hash (PR 1)** — same logical input → same hash;
  volatile-field changes don't change the hash; genuinely different
  inputs differ. ~10 cases, pure.
- **`withResponseCache` (PR 1)** — miss runs fn once + stores; second
  call hits without running fn; TTL expiry → miss; `CACHE_VERSION` bump
  → miss.
- **No-cache guard (PR 1)** — creative/high-temp calls bypass the cache
  (regression guard so chat is never cached).
- **Manual smoke** — upload the same file twice → second extract is
  instant + flagged cached; re-summarise an unchanged conversation →
  hit; edit one message → miss.

## Open questions before PR 1

1. **Per-user vs shared cache.** Sharing across users maximises hit
   rate but leaks content across tenants. **Default: per-user keyed
   (RLS) — never share cached content across users.**
2. **Cost of the embedding call (Phase 2).** Embedding every input to
   check the cache has its own cost. **Default: exact-key first
   (free); only embed on an exact-key miss, so the embedding cost is
   bounded to non-trivial lookups.**
3. **Compress mode correctness.** A stale recap could mislead. **Default:
   include the full message-tail hash in the key so any new message
   misses.**

## Reopen / future work

- **Cross-backend shared cache** — if the three backends should share a
  cache, centralise it (the same multi-tenant gate as everything else).
- **Cache analytics** — surface hit-rate + saved-cost in a dev panel
  (pairs with the parked Langfuse observability).

## Sources

- [Semantic caching for AI agents (2026)](https://www.buildmvpfast.com/blog/semantic-caching-ai-agents-cost-optimization)
- [GPTCache / Redis vector cache setup (2026)](https://www.spheron.network/blog/semantic-cache-llm-inference-gpu-cloud/)
- [Top semantic caching solutions (2026)](https://www.getmaxim.ai/articles/top-semantic-caching-solutions-for-ai-applications-in-2026/)
