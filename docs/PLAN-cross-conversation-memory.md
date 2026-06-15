# Plan: Cross-conversation memory

Status: **planning** — no code yet. Revised 2026-06-15 after a
prior-art study of ChatGPT / Claude / Copilot (see "Prior art" below):
the design is now a **two-arm model** — episodic message recall
(original plan, kept) **plus** an extracted-facts profile (new).

Cross-conversation memory so the assistant can carry facts, decisions,
names, and preferences across chats. Two complementary arms:

- **Arm A — episodic recall.** A retrieval layer over every persisted
  message; a `memoryRecall` skill embeds the incoming message and
  prepends the top-K semantically-similar past messages to the system
  prompt. Answers *"what did I say about X last week?"*
- **Arm B — extracted-facts profile.** A small, always-on set of
  durable facts about the user (role, stack, preferences, ongoing
  projects) distilled from conversations, injected every turn and
  exposed in a **"manage my memories"** screen. Answers *"the model
  already knows my setup without me re-explaining."*

The two arms mirror the structure every major product converged on
(ChatGPT's separate "saved memories" + "reference chat history"
toggles; Copilot's "hybrid" model). Arm A is our differentiator at the
infra level (semantic recall over the full transcript); Arm B is the
table-stakes layer users can actually *see and edit*.

## Why

Hummingbird already feels like one tool with many chats; the model
treats each chat as a fresh context. Users notice — "I told you about
my Postgres setup last week" is the canonical complaint. A proper
memory layer fixes this without the hand-curated "memories" list
pattern (which decays as users forget to curate) — Arm B's facts are
auto-distilled, not hand-entered, but stay user-editable.

Few apps do this well. The ones that do — Mem, Pi — are entire
products built around it. Shipping a credible v1 is genuinely
distinctive.

## Prior art & the two-arm model (research, 2026-06-15)

A verified study of how the leaders build memory (primary sources:
OpenAI's memory announcement, Anthropic's Claude memory support doc,
Microsoft's M365 Copilot personalization docs, plus the Mem0 paper
arXiv:2504.19413). Key findings:

- **All three converge on extracted, structured facts — not raw-message
  RAG — for the always-on layer.** ChatGPT's "saved memories" are
  extracted stable facts written via a dedicated tool (on "remember
  this" or when the model detects a salient fact). Claude stores a
  **summarized/synthesized profile** (role, projects, comms + coding
  prefs), refreshed within 24h of a chat being created/edited/deleted.
  Copilot stores **inferred facts** (job role, common tasks, skills),
  auto-merging related ones and updating stale ones.
- **But the leaders run two layers, not one.** ChatGPT exposes "saved
  memories" *and* "reference chat history" as separate toggles;
  Copilot calls its mix of saved + inferred + custom-instructions
  "hybrid." Our message-RAG plan is a strong fit for the *recall* arm;
  what we were missing is the *facts* arm.
- **Extracted facts are dramatically cheaper to inject than full
  history.** The Mem0 paper measured **~91% lower p95 latency and >90%
  token-cost savings** vs feeding the whole transcript. (The flashier
  "beats OpenAI accuracy by 26%" claim did **not** survive adversarial
  verification — excluded.)
- **A facts layer is the only thing that enables a "view/edit/delete my
  memories" UX.** You cannot meaningfully show a user a list of
  thousands of message embeddings; you *can* show ~50 editable facts.
  Claude (Settings → Capabilities, pencil-edit, Pause vs Reset) and
  Copilot (view/delete individual or all) both ship this. It is
  table-stakes for trust.
- **Transparency + temporary mode are table-stakes.** ChatGPT notifies
  "memory updated" on write and offers **Temporary Chat** that neither
  reads nor writes memory. Copilot purges facts derived from a deleted
  chat within 7 days.
- **Defaults split by audience.** Consumer products tend opt-out/on
  (ChatGPT, Copilot); enterprise gates at the org level. Our
  **sign-in-gated opt-in** is the conservative, defensible default and
  stays.

Implication for this plan: **keep Arm A as designed** (it's the harder,
more distinctive infra and it reuses the shipped pgvector substrate),
and **add Arm B** (extracted facts + manage-UI + transparency/temporary
mode), which is what users actually see and what every competitor has.

## Goal & scope cuts

**v1 ships — Arm A (episodic recall):**

- Background embedding pipeline that vectorises every persisted
  user + assistant message.
- `pgvector` storage + cosine-similarity retrieval scoped to
  `auth.uid()` (no cross-user leakage).
- A `memoryRecall` `ServerSkill` that, when on for the turn, runs the
  user's incoming message against the index and prepends the top-K
  hits to the system prompt.
- A per-user toggle in `AccountMenu` to gate the embedding cost — the
  pipeline only runs for users who opted in.

**v1.5 ships — Arm B (extracted-facts profile):** *(new, from the
prior-art study — see the dedicated "Arm B" section for the full
design)*

- A `user_memories` table of distilled, durable facts (own-rows RLS),
  embedded with the same substrate for fact-level dedup/retrieval.
- An async extractor that distills salient stable facts from turns and
  **merges/updates** rather than appends (no duplicate-fact bloat).
- A tiny always-on profile block injected every turn (cheap; the Mem0
  cost result is the justification).
- A **"manage my memories"** screen (list / edit / delete-one /
  clear-all) — the real settings surface, replacing the bare toggle.

**Out of v1 (revisit if users ask):**

- The "Related conversations" strip under the chat input (explicit
  recall). Auto-recall via the skill is the higher-leverage surface;
  the strip can layer on later.
- Re-ranking with a cross-encoder. Cosine similarity over a small
  model is enough for chat-context recall.
- Multilingual / per-language embedding. Match the existing
  English-only posture in `to_tsvector` calls.
- Cross-workspace search UI (the recall skill already crosses
  workspaces; what's deferred is the read-only browser for hits).

## Storage backend is not yet decided

This plan is written assuming **pgvector** (semantic similarity over
embeddings). Whether the project actually uses a vector store — and
where it lives — is an **open decision** captured in
[`PLAN-local-rag.md`](PLAN-local-rag.md). Two things to know:

- A **non-vector fallback exists**: the shipped Postgres full-text
  search (`tsvector`) could back a *lexical* "search my old messages"
  recall with zero new infra. It's a weaker, different product
  (keyword match, not semantic), but it removes the vector-store
  dependency entirely. See `PLAN-local-rag.md` "Option Ø".
- If vectors *are* used, the default is Supabase pgvector (Option A
  there). Everything below assumes that; swapping in the FTS fallback
  changes only the retrieval query in Phase 2, not the FE.

The **frontend surface below is identical regardless of backend** —
toggle, skill, attribution pill don't care whether the hit came from
cosine similarity or FTS.

## Frontend surface

v1 is deliberately backend-heavy; the visible surface is small, and
most of the value is *invisible* (better answers). Four touch points,
all reusing UI patterns that already exist:

### 1. Opt-in toggle — `AccountMenu` (Phase 1)

A single **"Enable memory"** switch in the account menu. Off by
default, **sign-in gated** (server-side embeddings → no anonymous
mode; the row simply doesn't render when signed out). Flipping it on
starts background indexing of existing messages. A companion
destructive **"Clear my memory"** row wipes the embeddings. This is
the entire settings surface.

### 2. A skill toggle — Skills tab + active-chips (Phase 2)

`memoryRecall` is a normal `ServerSkill` (Brain icon), so it plugs
into machinery that already ships: it appears in the **Skills tab**
with the same workspace/conversation cascade as web search, and as a
**chip in the active-skills strip** above the input. The user turns
"recall from my past chats" on per-conversation like any other skill.

> **Two-step-opt-in wrinkle.** Today this means a user must flip *both*
> the AccountMenu toggle (index my data) *and* the skill (use it this
> chat). Recommendation: when the AccountMenu toggle is switched on,
> auto-enable the `memoryRecall` skill at the workspace-default level
> so it "just works", leaving the per-conversation cascade to override.
> Flagged as a small UX call to make at build time.

*(Optional: since it's a skill, it can get a `/recall` slash trigger
for free via `slashTriggers` — one line. Not required for v1.)*

### 3. The recall itself — invisible in v1

When the skill is on, each turn silently embeds the message, finds
top matches from *other* conversations, and prepends them to the
system prompt. **No UI during the turn.** The model is instructed to
attribute inline ("you mentioned in *Postgres setup*…"), so the only
visible sign in v1 is that attribution appearing in the answer text.

### 4. Attribution pill — above the assistant message (Phase 3)

The one genuinely new piece of FE. When the recall skill fired for a
turn, render a compact **"Recalled from N chats"** pill above the
assistant bubble, mirroring the existing web-search **Sources strip**
(`components/panels/sources-strip.tsx`) interaction model:

- **Data:** the recall step already fetched `{ messageId,
  conversationId, conversationTitle, snippet, distance }` per hit.
  Persist the 1–3 surfaced hits onto the assistant `Message` as a new
  optional field (e.g. `Message.recalledFrom?: RecallSource[]`) so the
  pill survives reload — same durability pattern as `toolCalls` /
  `generatedImages`.
- **Render:** a small pill row; each source is a chip showing the
  source conversation title + a one-line snippet. ≤2 inline, ≥3
  collapses to "Recalled from 3 chats ▸" that expands.
- **Click:** opens the source conversation and scrolls/flashes the
  cited message — reuse the `scroll-and-flash` already built for
  `[N]` citation markers + the conversation-jump from the ⌘K palette.
- **Privacy nuance:** the pill exposes that *this* conversation pulled
  from *that* one. Fine for a single user; revisit if conversations
  ever become shareable (the recalled snippet shouldn't leak into a
  shared transcript — strip `recalledFrom` from share/export, same as
  reasoning is stripped today).

### What's deliberately NOT on the FE in v1

- **No "browse my memory" screen** — no UI to see/search/edit what's
  indexed beyond an indexed-count badge + the wipe button. A read-only
  memory browser is deferred.
- **Nothing for anonymous users** — the whole feature is hidden
  unless signed in (a real UI branch).
- **No inline "recalling…" spinner** during the turn — the recall is a
  single fast query folded into the existing typing indicator.

## Architecture

```
+---------------+      +--------------+      +----------------+
| New / edited  | ---> | embed queue  | ---> | Embedding API  |
| message       |      | (Postgres or |      | (open-weight   |
+---------------+      |  in-process) |      |  or OpenAI)    |
                       +------+-------+      +--------+-------+
                              |                       |
                              v                       v
                       +---------------------------------+
                       | message_embeddings table        |
                       | (message_id, embedding vec(1024)|
                       |  user_id, conversation_id)      |
                       +----------+----------------------+
                                  |
                                  | top-K cosine, RLS-filtered
                                  v
                       +---------------------------------+
                       | /api/recall (server skill exec) |
                       +---------------------------------+
```

Source of truth at runtime stays the Zustand store — embeddings only
exist server-side and are queried at chat time. Nothing on the
client changes shape.

## Arm B — extracted-facts profile (NEW)

The piece the prior-art study added. Arm A recalls *episodes* (what you
said); Arm B maintains a *profile* (who you are / how you work) that's
small enough to inject every turn and to show in an editable list.

### Storage — `user_memories`

A second table alongside `message_embeddings`, reusing the shipped
768-d embedding substrate for fact-level dedup + optional retrieval:

```sql
create table user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact text not null,                       -- "Runs Postgres 16 on Hetzner"
  category text,                            -- 'stack' | 'preference' | 'project' | 'profile' | …
  embedding vector(768),                    -- for merge/dedup + optional semantic select
  source_message_id uuid references messages(id) on delete set null,
  source_conversation_id uuid references conversations(id) on delete set null,
  status text not null default 'active',    -- 'active' | 'paused' (user-hidden) ; hard-delete to remove
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_memories enable row level security;
create policy "own memories" on user_memories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create index on user_memories using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

Facts are small and few (target: a soft cap of ~50–100 active facts per
user; prune lowest-value when exceeded). Unlike `message_embeddings`,
this table is **user-facing** — every row maps to one line in the
manage screen.

### Write path — the extractor (merge, don't append)

A cheap async step (after a turn, or a periodic sweep over recent
turns — NOT inline in the chat response path):

1. Run a small/cheap model over the latest turn(s) with a strict
   extraction prompt: emit only **durable, stable** facts (role, stack,
   recurring preferences, ongoing projects) as short atomic statements;
   skip ephemeral/task-specific content. Return `[]` for most turns.
2. For each candidate fact, embed it and **cosine-match against the
   user's existing `user_memories`**:
   - close match (≥ threshold) → **update/merge** the existing row
     (refresh `fact`, `updated_at`, source) instead of inserting a
     duplicate. This is the Copilot "merge related, update outdated"
     behavior and the single most important anti-bloat mechanism.
   - no match → insert.
3. Emit a transparency signal on write (see Trust & lifecycle).

Gating: only runs for opted-in users (same `profiles.memory_enabled`
flag as Arm A). The extra model call is the main new cost — keep it on
a cheap model and async so it never adds chat latency.

### Retrieval / injection — always-on, tiny

The active profile is small, so **inject all of it** (or the top-N by
recency/category if a user is over the soft cap) as a compact block at
the top of the system prompt every turn for opted-in users — no
similarity query needed for the common case. This is what makes the
model "already know" the user. (Optionally, for users over the cap,
semantically select the most relevant facts via the `embedding` column
— the column is there for that, but v1.5 can ship with
inject-all-active.)

```text
What you know about this user (they can edit/remove these in Settings):
- Stack: Postgres 16 on a Hetzner box; Next.js + Bun.
- Preference: terse answers, no preamble.
- Project: building "Hummingbird", a multi-panel chat app.
```

This block is separate from, and cheaper than, Arm A's per-turn recall
hits — the two compose (profile always-on + episodic recall when the
skill fires).

### Manage UI — the real settings surface

Replaces the bare toggle as the primary surface (Claude/Copilot both
ship this; it's table-stakes):

- A **"Memory" settings panel**: a list of the user's active facts,
  grouped by category. Per-row **edit** (inline) and **delete**; a
  **"Clear all"** destructive action. Mirrors the existing destructive
  patterns (e.g. delete-conversation) and the list ergonomics of the
  Skills tab.
- The AccountMenu keeps the **opt-in toggle** + an **"N facts
  remembered"** count that deep-links into the panel.
- "Tell the model to remember/forget in chat" is a nice-to-have
  (Claude supports it); v1.5 can rely on the auto-extractor + manual
  edit and add chat-driven edits later.

## Trust & lifecycle (NEW — applies to both arms)

Table-stakes the leaders ship; cheap to add and the main thing that
makes memory feel safe:

- **Transparency cue on write.** When Arm B writes/updates a fact,
  surface a subtle "Memory updated" affordance (mirrors ChatGPT). Arm
  A's recall already surfaces via the attribution pill (Phase 3).
- **Temporary chat.** A per-conversation mode that **neither reads nor
  writes** memory — no profile injection, no recall, no extraction
  (mirrors ChatGPT Temporary Chat). The strongest single trust feature;
  implement as a conversation flag the chat route + extractor honor.
- **Decay / source deletion.** When a source conversation (or message)
  is deleted, purge derived state: `message_embeddings` already cascades
  via FK; for `user_memories`, on source deletion either re-derive or
  drop facts whose only source is gone (Copilot purges within 7 days —
  a periodic sweep is fine). `source_*` FKs are `on delete set null` so
  a deleted source doesn't orphan-error; the sweep reconciles.
- **Pause vs wipe.** "Pause memory" (stop creating, keep existing) vs
  "Reset/Clear" (hard delete) — both arms. `status = 'paused'` covers
  Arm B; Arm A's toggle-off already stops indexing while keeping rows.

## Phases

Each is a standalone PR. Earlier phases deliver value alone.

### Phase 1 — Storage + embedding pipeline (≈ 1 day)

**Migration** — `supabase/migrations/00XX_message_embeddings.sql`:

```sql
create extension if not exists vector;

create table message_embeddings (
  message_id uuid primary key references messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  embedding vector(1024) not null,
  created_at timestamptz not null default now()
);

create index on message_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table message_embeddings enable row level security;
create policy "own embeddings" on message_embeddings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
```

**Embedding model.** Default to `text-embedding-3-small` (1536-d,
~$0.02 / 1M tokens) through the AI Gateway. Truncate the table's
`embedding` column to 1024-d by taking the leading dimensions —
preserves 99% of the quality at 33% storage savings (OpenAI's
documented dimension-reduction recipe). Allow override via env
(`MEMORY_EMBEDDING_MODEL`).

**Pipeline.** New server-only `lib/server/memory/embed-worker.ts`:

- A Supabase-realtime listener on `messages` (or a polling sweeper
  if realtime isn't enabled) picks up new rows where there's no
  corresponding `message_embeddings` entry.
- Batches up to 100 messages per call to the embedding endpoint.
- Skips rows with `compressed = true` (they're not currently
  relevant) and `kind = 'recap'` (don't double-index the same
  content).
- Idempotent: re-runs are safe because the join key is `message_id`.

**Opt-in toggle.** New column on `profiles`:
`memory_enabled boolean not null default false`. The embed worker
only processes messages from users who set it true. Add a row in
`AccountMenu` to flip it.

### Phase 1.5 — Arm B: extracted facts + manage UI (≈ 1–1.5 days)

The "Arm B" design section above is the spec; this is the build
breakdown. Sequenced right after Phase 1 because it only needs the
embedding substrate (shipped) — **not** the recall skill — and it's the
visible, table-stakes value (the manage screen). Can land before or in
parallel with Phase 2.

- **Migration** `supabase/migrations/00YY_user_memories.sql` — the
  `user_memories` table + RLS + ivfflat index (see Arm B → Storage).
- **Extractor** `lib/server/memory/extract-worker.ts` — async, gated on
  `memory_enabled`. Cheap-model extraction prompt → atomic durable
  facts; embed each; **cosine-merge** against existing rows
  (update-or-insert); never inline in the chat response path. (See Arm
  B → Write path.)
- **Injection** — in the chat route's system-prompt assembly, prepend
  the active-profile block for opted-in users (inject-all-active in
  v1.5; honor the temporary-chat flag). Distinct from the `memoryRecall`
  skill — the profile is always-on, recall is per-turn-when-on.
- **Manage UI** — a "Memory" settings panel (list / inline-edit /
  delete-one / clear-all, grouped by category) + the AccountMenu "N
  facts remembered" deep-link. Reuse existing list + destructive-action
  patterns.
- **Transparency cue** — "Memory updated" affordance on write.

### Phase 2 — `memoryRecall` ServerSkill (≈ half day)

**New file** `lib/server/skills/memory-recall.ts`:

- `buildMemoryRecallTool(...)`: no model-callable tool — the skill
  works by mutating the system prompt, not by exposing a tool.
- `promptFragment(requestEntry, ctx)`:
  1. Embed the user's most recent message (single call, ~80 ms).
  2. Query `message_embeddings` ordered by `embedding <=> $1`
     limit 5, joined to `messages` for the content.
  3. Filter out: messages from the current conversation (no point
     reminding the model of context it already has), messages with
     cosine distance > 0.4 (low-quality hits add noise).
  4. Render top-K as a numbered list with timestamp + "from
     conversation: <title>" inline.

```text
You have access to relevant past conversations. Reference these
when they apply, citing as "you mentioned in <conversation title>":

1. [Jan 12, in "Postgres setup"] "I'm running PG 16 on a Hetzner box…"
2. [Feb 03, in "weekly digest design"] "decided to keep the digest…"
3. […]
```

**Per-IP / per-user rate limit.** Share the existing chat web-tool
budget — the recall call is one embedding + one similarity query per
turn, similar cost profile.

**Registry wiring.** Push to `SERVER_SKILLS`; declare in
`lib/shared/skills/registry.ts` with the `Brain` icon. Default off
even for opted-in users — explicit opt-in per workspace via the
existing skills cascade.

### Phase 3 — UI polish (≈ 1 day, optional)

The "Frontend surface" section above is the spec; this is the
build breakdown.

- **Attribution pill** (`components/panels/recall-strip.tsx`, new) —
  rendered by `chat-message.tsx` above the assistant bubble when
  `message.recalledFrom?.length`. Mirror `sources-strip.tsx`:
  - New `Message.recalledFrom?: RecallSource[]` on
    `lib/shared/types.ts`, where `RecallSource = { messageId,
    conversationId, conversationTitle, snippet }`. Persisted +
    synced like `toolCalls` (needs a `messages.recalled_from jsonb`
    column + the `diffMessages` / reconcile additions — same shape as
    the `generated_images` follow-up that already shipped).
  - The chat route's `memoryRecall` step emits the surfaced hits on a
    new SSE frame (`{ type: 'recall', sources: [...] }`); the client
    parser writes them onto the placeholder via a
    `setMessageRecallSources(messageId, sources)` mutator. Same
    pattern as `tool_result` / `tool_image`.
  - Click a chip → reuse the conversation-jump + scroll-and-flash
    from the ⌘K palette and the `[N]` citation markers.
  - Strip `recalledFrom` from Copy / Export / Share (it's attribution
    metadata, not message content — same exclusion list as
    `reasoning`).
- **"N messages indexed" badge** in the AccountMenu — a count from
  `select count(*) from message_embeddings where user_id = …`,
  refreshed when the menu opens.
- **Manual re-index button** in the AccountMenu for users whose
  embedding model changed (upgrade) or who flipped the toggle on
  after months of chat — enqueues all un-indexed messages.

## Verification

End-to-end with a real Supabase + AI Gateway:

1. Flip the toggle in AccountMenu. Verify the embed worker indexes the
   user's existing messages without blocking new chats.
2. Two-conversation test: in conv A, tell the model a unique fact
   ("my dog is named Pickle"). In conv B with the recall skill on,
   ask "what's my dog's name?" — verify the answer cites Pickle and
   the source conversation.
3. RLS test: signed in as user B, confirm `select * from
   message_embeddings` returns zero rows from user A's data.
4. Compressed messages don't appear in recall hits.
5. Rate-limit: 30 turns/min hits the existing chat ceiling cleanly.
6. Toggle off: new messages stop being indexed; existing rows stay
   (so flipping back on is instant). Add a separate "Clear my memory"
   destructive action in AccountMenu for full wipe.

## Out of scope

- A separate "Related conversations" strip under the chat input. The
  recall skill is the primary surface; the strip can be a Phase 4 if
  users ask.
- Cross-encoder re-ranking. The cosine top-5 with a strict distance
  threshold is enough for chat-context recall; revisit if precision
  becomes a complaint.
- Embedding artifacts, files, or URL bookmarks. Just messages for v1;
  the file FTS skill already covers attachments.
- A `searchMemory({ query })` tool the model can call mid-turn. Push
  the top-K via the system prompt instead — cheaper and more reliable.

## References (prior-art study, 2026-06-15)

Primary sources behind the "Prior art" section and the Arm B design
(claims adversarially verified; low-confidence ones excluded):

- OpenAI — *Memory and new controls for ChatGPT*
  (openai.com/index/memory-and-new-controls-for-chatgpt): two separate
  toggles (saved memories / reference chat history), "memory updated"
  cue, Temporary Chat reads+writes nothing.
- Anthropic — *Use Claude's chat search and memory*
  (support.claude.com, article 11817273): summarized/synthesized
  profile, ~24h refresh, view/edit (pencil) + Pause vs Reset,
  enterprise org-level toggle vs no Team org control.
- Microsoft — *Copilot personalization & memory*
  (learn.microsoft.com/.../copilot-personalization-memory) and
  *Manage Copilot memory* (support.microsoft.com): hybrid
  saved+inferred+custom-instructions, stored in the Exchange mailbox
  (not a vector store), auto-merge/update, opt-out/on-by-default,
  view/delete individual or all, 7-day purge on source deletion.
- Mem0 — *Building Production-Ready AI Agents with Scalable Long-Term
  Memory* (arXiv:2504.19413): extract-consolidate-retrieve salient
  facts; ~91% lower p95 latency and >90% token savings vs full-context.
  (Its "26% better than OpenAI on LOCOMO" claim did not survive
  verification and is intentionally not relied upon.)
