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

### Phase 3 — UI polish (≈ half day, optional)

- "Last sync" badge in the AccountMenu showing how many messages have
  been indexed.
- A "Recalled" pill above the assistant turn when the skill fired,
  listing 1–3 source links (click → opens that conversation at the
  cited message).
- Manual re-index button for users whose embedding model changes
  (model upgrade) or who flip the toggle on after months of chat.

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
