# Plan: Local RAG vector store — where do the embeddings live?

Status: **🪜 driver chosen (Supabase pgvector); substrate shipping.**
Decision (2026-06-11): use **Supabase pgvector** — Supabase is already
the store (no new dependency), it's the lowest-effort path, and it
keeps RLS/own-rows for free. The alternatives (self-host Postgres /
in-browser PGlite) stay documented below for if/when the
deploy posture changes.

**Substrate (PR 1, this slice):** an env-gated embedding provider
(`lib/server/embeddings/provider.ts`, OpenAI-compatible / Ollama,
`EMBEDDING_DIM = 768` / `nomic-embed-text`), a pure paragraph-aware
`chunkText` (`lib/server/embeddings/chunk.ts`), and migration
`0023_file_embeddings.sql` — a `file_sections` chunk table (own-rows
RLS) + ivfflat cosine index + a `match_file_sections` nearest-neighbour
RPC. **Inert until an embedding provider is configured** (no
`EMBEDDINGS_BASE_URL` / `OLLAMA_BASE_URL` → nothing writes, FTS stays
the only path).

**Follow-ups (consumers):** PR 2 — chunk + embed file text on the
extraction path (write `file_sections`). PR 3 — a **hybrid
`searchFiles`** that blends FTS (`search_file_sections`) with vector
(`match_file_sections`). Once the substrate lands it also unblocks
semantic-caching Phase 2, citation grounding, multimodal retrieval,
and cross-conversation memory.

Captures the architecture options for a local/self-hostable vector
store so the choice is made deliberately when a RAG feature
(`PLAN-cross-conversation-memory.md`, file-RAG) needs it.

This is **infrastructure**, not a feature. It answers **two**
questions, in order:

1. **Do we use a vector store at all?** Semantic retrieval (embeddings
   + cosine similarity) is the "real" version, but the shipped
   Postgres full-text search could back a cheaper *lexical* recall
   with zero new infra. Logged as **Option Ø** below. **Not yet
   decided** — the team hasn't committed to vectors.
2. **If vectors: where do they live?** When we add `pgvector`-style
   retrieval, does it have to run through Supabase? Short answer —
   no, but the alternatives (A / B / C) have sharply different
   cost/effort profiles depending on what "local" means.

Resolve (1) first. If the answer is "FTS is enough", the A/B/C
matrix is moot and this whole doc collapses to Option Ø.

## Background — what exists today

- The app talks to its database via **`@supabase/supabase-js`**
  (PostgREST + GoTrue), not raw Postgres. "Use Postgres directly"
  means adding a new client path, not swapping a connection string.
- **No pgvector today.** The shipped file search
  (`lib/server/skills/file-search.ts`, migrations `0007` /
  `0009`) uses Postgres **full-text search** (`tsvector`), not
  embeddings. Any vector RAG is net-new regardless of where it lives.
- The app has **two runtime modes**:
  - **Anonymous** — localStorage only, no server DB, works offline.
  - **Signed-in** — Supabase sync for workspaces / conversations /
    files / etc.
- This split is the crux: **server-side vectors only work
  signed-in; client-side vectors work in anonymous mode too.**

## The decision hinges on one question

**What does "local" mean here?** Three distinct drivers, each
pointing at a different option:

1. **Dev convenience** — "I don't want to hit Supabase cloud while
   developing." → already solved (local Supabase CLI).
2. **Privacy / offline** — "user data never leaves the device." →
   in-browser vector store.
3. **Self-hosting** — "run the whole stack on my own box, no
   Supabase dependency." → self-hosted Postgres + pgvector.

The rest of this doc lays out all three so whoever picks up the RAG
feature can choose with eyes open.

## Option Ø — No vectors: reuse Postgres full-text search

Before any vector store, the honest baseline: **do we need embeddings
at all?** The app already runs Postgres FTS (`tsvector`) for file
search (`lib/server/skills/file-search.ts`, migrations `0007`/`0009`).
The same machinery could back message recall:

```sql
-- no new extension; messages already have content
alter table messages
  add column content_tsv tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;
create index on messages using gin (content_tsv);
```

Recall becomes a `plainto_tsquery` ranked by `ts_rank`, scoped to
`auth.uid()` via the existing RLS — basically the file-search RPC
pointed at `messages`.

**Effort:** Lowest of all. One migration + one RPC. No embedding
pipeline, no embedding cost, no model choice, no new client.

**Pros:**
- Zero new infrastructure or dependencies. Ships in well under a day.
- No per-message embedding cost, no third-party text egress.
- Reuses the exact pattern already proven by file search.

**Cons:**
- **Lexical, not semantic.** "what's my dog's name?" won't match an
  earlier "my golden retriever Pickle" unless a keyword overlaps.
  This is the crux: it's a *different, weaker product* than the
  "the model remembers what I told it" pitch in
  `PLAN-cross-conversation-memory.md`.
- English-stemming only (same caveat as file search).
- A future upgrade to vectors is additive, not a migration — but
  you'd be rebuilding the retrieval half.

**Pick this if:** the goal is a cheap "search my old messages" recall
and semantic matching isn't a hard requirement — or as a **Phase 0**
that ships value immediately while the vector decision is made.
(Hybrid FTS+vector fusion later is a known, well-trodden upgrade.)

## Option A — Supabase pgvector (hosted or local CLI)

The path of least resistance. pgvector is a Postgres extension;
Supabase ships it in both hosted projects and the local CLI Docker
stack (`docs/SUPABASE_LOCAL.md`).

```sql
-- migration 00XX_message_embeddings.sql
create extension if not exists vector;

create table message_embeddings (
  message_id uuid primary key references messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

create index on message_embeddings using hnsw (embedding vector_cosine_ops);

alter table message_embeddings enable row level security;
create policy "own embeddings" on message_embeddings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Retrieval is a `SECURITY DEFINER` RPC doing cosine similarity scoped
to `auth.uid()` — the same RLS pattern every other table uses.

**Effort:** Low. Migration + RPC + the embedding pipeline follow
existing patterns. This is exactly what `PLAN-cross-conversation-
memory.md` assumes.

**Pros:**
- Reuses RLS, the sync layer, the migration tooling, the
  `@supabase/supabase-js` client. Zero new infra concepts.
- Local CLI gives offline-*dev* without touching the cloud.
- `hnsw` index scales to millions of vectors comfortably.

**Cons:**
- Only works in **signed-in mode**. Anonymous users get no RAG.
- "Local" only in the dev-convenience sense — production still
  points at Supabase cloud (or a self-hosted Supabase, which is its
  own ops burden).

**Pick this if:** the driver is dev convenience, or you're fine
requiring sign-in for RAG features.

## Option B — Self-hosted plain Postgres + pgvector

Drop Supabase for the vector store; run a bare Postgres with the
pgvector extension and talk to it with a direct client
(`postgres.js` or `pg`).

**Effort:** Medium. New server-side DB client, new connection
management, and — critically — **you reimplement the user scoping
that RLS gave you for free.** Every query must filter by `user_id`
explicitly; a missed filter is a cross-user data leak.

**Pros:**
- No Supabase dependency for the vector path. Fits a "self-host the
  whole thing" posture.
- Full control over the Postgres instance (tuning, extensions,
  backups).

**Cons:**
- Loses RLS — user scoping moves into application code, which is
  error-prone and harder to audit.
- The existing sync layer (`lib/client/sync/`) doesn't cover a
  second database; embeddings would be a separate, un-synced store.
- Two databases to operate if the rest of the app still uses
  Supabase. If you self-host *all* of it, you're effectively
  self-hosting Supabase piecemeal (PostgREST + GoTrue + Storage),
  which is more work than running Supabase's own self-host image.

**Pick this if:** the driver is full self-hosting AND you're willing
to take on the RLS-in-app-code burden, OR you self-host the entire
Supabase stack (in which case this collapses back into Option A
pointed at your own instance).

## Option C — Fully in-browser (PGlite + pgvector, or JS ANN)

Vectors never leave the device. Two sub-variants:

### C1 — PGlite + pgvector (WASM Postgres in the browser)

[PGlite](https://pglite.dev) is ElectricSQL's WASM build of Postgres;
it supports the `vector` extension. The same SQL from Option A runs
in the browser against an IndexedDB-backed Postgres.

**Pros:**
- True local / offline. Works in anonymous mode.
- **SQL ports over from Option A** — if we ever want to graduate a
  user's local index to the cloud, the schema is identical.
- No server round-trip for retrieval.

**Cons:**
- PGlite is ~3 MB WASM. Acceptable but not free on first load.
- Single-tab — IndexedDB-backed Postgres doesn't multiplex across
  tabs cleanly. Need a leader-election or accept last-tab-wins.

### C2 — JS ANN library (`hnswlib-wasm`, `voy`, or a plain cosine scan)

A lighter vector index in IndexedDB with a JS similarity search.
For the realistic N (a few thousand messages per user) even a plain
in-memory cosine scan is fast enough — no ANN index needed below
~10k vectors.

**Pros:**
- Smallest footprint. A plain cosine scan is ~30 lines, no WASM.
- Trivially works offline / anonymous.

**Cons:**
- Doesn't share SQL with the server path — divergent code if we
  later add a cloud index.
- Hand-rolled; no battle-tested index behaviour.

### The shared catch for both C variants — embeddings

Storing vectors locally is the easy half. **Computing** them is the
hard half:

- **In-browser model** (`transformers.js` + a small embedding model
  like `all-MiniLM-L6-v2`): genuinely offline, free, but a
  **30–100 MB model download** on first use and slow on CPU
  (hundreds of ms per embed). Acceptable for background indexing,
  rough for interactive.
- **Embeddings API** (OpenAI `text-embedding-3-small`, or an
  open-weight host): fast and cheap, but **defeats "offline"** and
  sends message text to a third party — which undercuts the privacy
  driver that motivated going local in the first place.

So C is only coherent if paired with **in-browser embeddings** —
otherwise you've kept the vectors local but shipped the text to an
API anyway.

**Pick this if:** the driver is privacy / offline AND you accept the
in-browser-embedding cost (model download + CPU time).

## Recommendation matrix

First decide **whether** vectors are needed; then **where**.

| Goal / driver | Option | Why |
|---|---|---|
| Cheap "search my old messages", semantic match not required | **Ø** (Postgres FTS) | Zero new infra; reuses the file-search pattern; ships in <1 day |
| Ship *something* now, decide vectors later | **Ø as Phase 0**, then A | FTS delivers value immediately; vectors layer on (hybrid fusion) without a migration |
| Semantic recall, dev convenience | **A** (local Supabase CLI) | Already wired; `supabase start` runs pgvector in Docker |
| Semantic recall, require-sign-in is fine | **A** (hosted) | Lowest effort for vectors; RLS for free; scales (hnsw) |
| Semantic recall, full self-hosting | **A pointed at self-hosted Supabase** | Less work than reimplementing RLS in app code (Option B) |
| Semantic recall, privacy / offline / anonymous | **C1** (PGlite + pgvector) | True local; SQL ports to cloud later; needs in-browser embeddings |
| Semantic recall, smallest footprint, small N | **C2** (cosine scan in IndexedDB) | No WASM, ~30 LOC, fine under ~10k vectors |

### Recommendation (pending the team's call — not yet decided)

**The decision is deliberately left open; the options above are all
logged so whoever picks this up chooses with eyes open.** With that
said, the leaning, in priority order:

1. **If unsure whether semantic recall is worth the cost → start with
   Option Ø (FTS).** It's the cheapest way to ship *a* recall feature
   and learn whether users want more. It is *not* a dead end: adding
   vectors later is additive (hybrid FTS+vector), not a rewrite of
   storage.
2. **If semantic recall is a committed product goal → Option A
   (Supabase pgvector).** Unless privacy/offline is an explicit
   requirement, the cost/benefit overwhelmingly favours it — reuses
   RLS, sync, migrations, and the existing client; the local CLI
   covers dev convenience. This is what
   `PLAN-cross-conversation-memory.md` assumes.
3. **If privacy/offline is the real driver → Option C1** (PGlite +
   pgvector). Principled, SQL parity with A so it's not a dead end —
   but budget for the in-browser embedding model, which is the actual
   hard part, not the vector storage.

The single most consequential call is **#1 vs #2** — lexical vs
semantic. It's a product question (how smart must "memory" feel?),
not an infra one, so it's logged here for the team rather than
defaulted.

## Hybrid worth noting

A/C aren't mutually exclusive long-term: **anonymous users get C1
(local PGlite index), signed-in users get A (cloud pgvector), and
on sign-in the local index migrates to the cloud** because the SQL
is identical. This mirrors the app's existing localStorage→Supabase
graduation on sign-in. It's more work than either alone, but it's
the only option that serves both modes without a second
embedding-compute path — both would use the same in-browser OR same
server-side embedder, chosen once. Defer unless both audiences
matter.

## What this doc does NOT decide

- The embedding model / dimension (1536 above is a placeholder for
  OpenAI `text-embedding-3-small`; an open-weight 384-dim model
  changes the column type).
- Chunking strategy for long messages / files.
- The retrieval surface (skill vs. strip) — that's
  `PLAN-cross-conversation-memory.md`'s job.
- Re-ranking, hybrid FTS+vector fusion with the existing
  `tsvector` search — a later optimisation.

## Next step

Two decisions, in order:

1. **Vectors or not?** (Option Ø vs everything else.) A product call:
   does "memory" need to feel *semantic*, or is keyword search over
   old messages enough for v1? If FTS is enough, stop here — implement
   Option Ø and fold it into `PLAN-cross-conversation-memory.md`'s
   retrieval step (the FE surface there is unchanged).
2. **If vectors: which driver?** (dev convenience / require-sign-in /
   privacy-offline / self-host.) That collapses A/B/C to one option,
   at which point implementation folds into
   `PLAN-cross-conversation-memory.md` (message recall) or a new
   file-RAG plan (retrieval over `files.full_text`).

Neither is decided yet — this doc exists to make the choice
deliberate, not to pre-empt it.
