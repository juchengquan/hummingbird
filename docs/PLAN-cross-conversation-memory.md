# Plan: Cross-conversation memory with retrieval

Status: **planning** — no code yet.

A retrieval layer over every persisted message so the assistant can
recall facts, decisions, names, and snippets the user mentioned in
other chats. Surfaced as a `memoryRecall` skill (auto-prepend top-K
hits to the system prompt) and a "Related conversations" strip the
user can include explicitly.

## Why

Hummingbird already feels like one tool with many chats; the model
treats each chat as a fresh context. Users notice — "I told you about
my Postgres setup last week" is the canonical complaint. A proper
retrieval layer fixes this without the hand-curated "memories" list
pattern (which decays as users forget to curate).

Few apps do this well. The ones that do — Mem, Pi — are entire
products built around it. Shipping a credible v1 is genuinely
distinctive.

## Goal & scope cuts

**v1 ships:**

- Background embedding pipeline that vectorises every persisted
  user + assistant message.
- `pgvector` storage + cosine-similarity retrieval scoped to
  `auth.uid()` (no cross-user leakage).
- A `memoryRecall` `ServerSkill` that, when on for the turn, runs the
  user's incoming message against the index and prepends the top-K
  hits to the system prompt.
- A per-user toggle in `AccountMenu` to gate the embedding cost — the
  pipeline only runs for users who opted in.

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
