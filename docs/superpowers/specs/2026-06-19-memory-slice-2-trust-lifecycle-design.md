# Cross-conversation memory — Slice 2 (trust & lifecycle) — Design

**Status:** Approved design (2026-06-19). Slice 2 of cross-conversation
memory. Builds on Slice 1 (facts, embedding-free — `#248`).

## Goal

Make memory safe to live with: a **per-conversation "memory off" toggle**
(this chat neither injects facts nor extracts from its turns), and
**decay** (facts are purged when their source conversation is deleted).
Pause-vs-wipe already shipped in Slice 1.

## Decisions locked (brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Bypass scope | **Per-conversation "memory off" toggle** (`Conversation.memoryOff`). Chat is still saved; only memory is bypassed. Full ephemeral "Temporary Chat" is a separate larger feature, **deferred**. |
| D2 | Decay | **Immediate cascade** — `user_memories.source_conversation_id` FK → `ON DELETE CASCADE`. Deleting a conversation purges its derived facts. Server-enforced. |
| D3 | Pause vs wipe | **Already shipped** (Slice 1: `memory_enabled` off = pause/keep; Memory panel "Clear all" = wipe). No new work. |

## Architecture

```
Decay:    delete conversation → (FK ON DELETE CASCADE) → user_memories rows with that
          source_conversation_id are purged. Pure DB; no app code.

Bypass:   Conversation.memoryOff (store) ──► client sets ChatRequest.memoryBypass + skips extract
              route inject step: memoryBypass ? no block : renderMemoryBlock(loadActiveFacts())
```

## Components & boundaries

### Decay — migration `0027_memory_decay_cascade.sql`
Drop and re-add the `source_conversation_id` foreign key with
`ON DELETE CASCADE`:
```sql
alter table user_memories drop constraint user_memories_source_conversation_id_fkey;
alter table user_memories
  add constraint user_memories_source_conversation_id_fkey
  foreign key (source_conversation_id) references conversations(id) on delete cascade;
```
(Confirm the exact auto-generated constraint name from `0026` — Postgres
names it `<table>_<column>_fkey` by default.) `source_message_id` keeps
`ON DELETE SET NULL` (editing/regenerating a single message must not drop a
still-valid fact). No app code — deleting a conversation (via the sync
layer) cascades to its facts.

### Per-conversation "memory off" toggle
- **Type + store** — add `memoryOff?: boolean` to `Conversation`
  (`lib/shared/types.ts`) and a `setConversationMemoryOff(conversationId,
  value)` mutator in the conversations slice (mirror an existing
  per-conversation field setter). **Nested field on the already-persisted
  `conversations` key → NO top-level persist change, NO `STORE_VERSION`
  bump** (same as `codeResults`/`generatedImages`).
- **Wire** — `ChatRequestSchema` (`lib/shared/api-schemas.ts`) gains
  `memoryBypass: z.boolean().optional()`. The client sets it from the
  active conversation's `memoryOff` when assembling the chat body
  (`use-chat-send.ts`, beside `workspaceSystemPrompt`).
- **Inject skip (server)** — the chat route's Slice-1 inject step becomes:
  `const memoryBlock = body.memoryBypass ? undefined : (renderMemoryBlock(await loadActiveFacts()) ?? undefined)`.
  Optionally extract a tiny pure `shouldInjectMemory(body)` for testability.
- **Extract skip (client)** — in `use-chat-send.ts`, skip
  `extractAfterTurn(...)` when the conversation's `memoryOff` is true
  (gated alongside the existing `memoryEnabled` check).
- **UI** — a per-conversation **"Memory: off"** toggle in the chat's
  per-conversation controls (next to the existing "Thread instructions"
  entry / the conversation menu where `Conversation.systemPrompt` is
  edited). A small switch reflecting + setting `conv.memoryOff`.

### Pause vs wipe — already shipped (no work)
Slice 1's `memory_enabled` toggle (off → no extract/inject, facts kept)
is "pause"; the Memory panel's "Clear all" is "wipe". Noted for completeness.

## Error handling / security
- Decay is a DB constraint — atomic with the conversation delete, RLS
  already scopes both tables to the user.
- Bypass is fail-safe in the privacy direction: if `memoryBypass` is set,
  the route injects nothing and the client extracts nothing; a missing/false
  flag falls back to Slice-1 behavior (gated on `memory_enabled`).
- `memoryOff` defaults to falsy (memory on for opted-in users) — back-compat
  for existing conversations.

## Testing
- **Schema:** `ChatRequestSchema` accepts `memoryBypass` (and absent is fine).
- **Inject decision (pure):** `shouldInjectMemory({ memoryBypass: true })` →
  false; absent/false → true (the route then still self-gates on sign-in +
  `memory_enabled` via `loadActiveFacts`).
- **Client wiring:** `memoryOff` → request carries `memoryBypass: true` +
  `extractAfterTurn` skipped (unit where practical).
- **Manual smoke (needs Supabase + model):**
  1. Toggle a chat to "memory off" → its turns add no facts; existing facts
     aren't injected (model doesn't "know" them in that chat).
  2. A normal chat still extracts + injects.
  3. Produce a fact in conversation X, then **delete X → the fact disappears**
     from Settings → Memory (decay cascade).

## Scope / out
- Full ephemeral "Temporary Chat" (non-persisted conversations) — deferred
  (separate arc).
- Grace-period decay (7-day sweep) — not needed (immediate cascade chosen).
- Still deferred from the memory roadmap: chat-driven remember/forget, the
  "Memory updated" transparency cue, and Arm A (message-embedding recall).
