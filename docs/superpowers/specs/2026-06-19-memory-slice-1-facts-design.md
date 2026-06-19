# Cross-conversation memory — Slice 1 (summary/facts, embedding-free) — Design

**Status:** Approved design (2026-06-19). Slice 1 of the cross-conversation
memory feature. **Direction change from the original plan:** summary-first
and **embedding-free** — the raw-message embedding RAG arm ("Arm A") is
**deferred**; this slice builds the extracted-facts profile ("Arm B") as
the primary mechanism. See the revised `docs/PLAN-cross-conversation-memory.md`.

## Why this direction

The prior-art study (ChatGPT / Claude / Copilot, recorded in the plan)
found the leaders use **extracted, structured facts / summaries — not
raw-message RAG — for the always-on layer**, and a facts layer is the only
thing that enables a real "view/edit my memories" UI. Decision (2026-06-19):
ship the **facts/summary approach with no embeddings or vector store** —
simpler, more controllable, and the user-visible value. Message-embedding
recall is deferred (revisit only if always-on facts prove insufficient).

## Goal

For opted-in (signed-in) users, the assistant maintains a small set of
**distilled facts** (role, stack, preferences, ongoing projects)
auto-extracted from conversations, **injected into every chat**, and
editable in a "manage my memories" screen. **No message embeddings, no
vector store.**

## Decisions locked

| # | Decision | Choice |
|---|---|---|
| D1 | Mechanism | **Extracted facts (summaries), embedding-free.** No `message_embeddings`, no vector store, no similarity retrieval. |
| D2 | Extraction trigger | **On-turn, best-effort, async** — after a turn finalizes, a cheap-model call distills facts (gated on sign-in + `memory_enabled`). |
| D3 | Dedup | **LLM merge-don't-append** — existing active facts are passed to the extractor so it returns new/updated/unchanged; no embedding similarity. |
| D4 | Injection | **Always-on, inject-all-active** — the small profile is prepended to the system prompt every turn (no retrieval). |
| D5 | Control | An AccountMenu **"Enable memory"** toggle (gates extraction + injection) + a **"Memory" manage panel** (list/edit/delete/clear). Sign-in-gated. |
| D6 | Arm A (embeddings) | **Deferred** — not in this slice; revisit later. |

## Architecture

```
turn finishes → POST /api/memory/extract  (best-effort, gated: signed-in + memory_enabled)
   cheap model: given {recent turn} + {existing active facts}, return facts to add/update
   merge (LLM-driven, no embeddings) → upsert user_memories
                                   │
next turn (opted-in) → route step prepends ALL active facts as a system-prompt block
                                   │
Memory settings panel: list / edit / delete / clear active facts
```

No vector store anywhere; `user_memories` is plain rows of text facts.

## Components & boundaries

### Storage — migration `0026_user_memories.sql`
```sql
create table user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact text not null,
  category text,                              -- 'stack'|'preference'|'project'|'profile'|…
  source_conversation_id uuid references conversations(id) on delete set null,
  source_message_id uuid references messages(id) on delete set null,
  status text not null default 'active',      -- 'active' | 'paused'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table user_memories enable row level security;
create policy "own memories" on user_memories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```
**No embedding column.** Plus `alter table profiles add column memory_enabled boolean not null default false`.

### Extractor — `POST /api/memory/extract` + `lib/server/memory/extract.ts`
- Route gated on sign-in + `memory_enabled`; no-op (200) otherwise.
- Input: the just-finished turn's text (user + assistant) + conversation id.
- Loads the user's existing **active** facts (RLS), builds a strict
  extraction prompt: emit only durable/stable facts as short atomic
  statements; for each, decide add / update-existing(id) / skip; return
  `[]` for most turns. A **pure** `mergeFacts(existing, extracted)` helper
  computes the upsert/patch set (the model call is injected → unit-tested).
- Upserts `user_memories` (RLS). Cheap model; fully async (never blocks chat).
- **Client:** fire it best-effort after a turn when `memory_enabled` (mirrors the file-RAG `POST /api/embed` post-extraction pattern).

### Injection — per-turn route step
In `app/api/chat/route.ts`, a `maybeInjectMemory()` step (beside the
existing image/code steps): for opted-in signed-in users, load active facts
(RLS) and prepend a compact block to the system prompt:
```
What you know about this user (they can edit/remove these in Settings):
- Stack: Postgres 16 on Hetzner; Next.js + Bun.
- Preference: terse answers, no preamble.
```
A **pure** `renderMemoryBlock(facts)` builds the text (empty → no block) —
unit-tested. Injection is unconditional-when-enabled (no similarity query).

### Control surface
- **`profiles.memory_enabled` toggle** in AccountMenu ("Enable memory"),
  sign-in-gated (row hidden when signed out).
- **"Memory" settings panel** (new): lists active facts by category with
  per-row **edit** (inline) + **delete**, and **"Clear all."** The real
  surface. Plus a "N facts remembered" count.
- Facts sync as their own rows (own-row RLS); the panel reads/writes via
  the existing authed server client (same pattern as file-search / the
  custom-instructions sync).

### Transparency
A subtle **"Memory updated"** cue when the extractor adds/changes a fact
(cheap; mirrors ChatGPT). Temporary-chat bypass deferred.

## Error handling / security
- Extraction is best-effort + async: any failure is swallowed (chat
  unaffected). Returns `[]`/no-op when ungated.
- All reads/writes are **RLS-scoped** to the signed-in user (no cross-user
  facts). Anonymous/signed-out: feature hidden, zero server calls.
- Inject step degrades to no block on any load failure.

## Testing
- **`mergeFacts` (pure):** add new, update existing by id, skip unchanged,
  cap enforcement — model output injected.
- **`renderMemoryBlock` (pure):** facts → block; empty → none; category grouping.
- **`/api/memory/extract` gating:** signed-out / `memory_enabled` false → no-op.
- **Manage panel mutators / wiring** (unit where practical).
- **Manual smoke:** state a durable fact → appears in the Memory panel →
  a new chat reflects it without re-explaining → edit/delete/clear work →
  toggle off stops extraction; RLS isolation holds.

## Scope / out
- **Embeddings / message-RAG recall (Arm A): deferred.**
- Later slices: temporary-chat bypass + decay-on-source-delete + pause vs
  wipe; chat-driven "remember/forget"; multilingual; (and Arm A if ever
  revived).

## Plan reconciliation
`docs/PLAN-cross-conversation-memory.md` is revised alongside this spec:
its Arm B becomes the **primary** mechanism (embedding-free), Arm A
(message embeddings) is marked **deferred**, and the `user_memories`
embedding column is removed from the schema sketch.
