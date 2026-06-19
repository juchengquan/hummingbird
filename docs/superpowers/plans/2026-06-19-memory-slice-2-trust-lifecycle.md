# Cross-conversation memory — Slice 2 (trust & lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-conversation "memory off" toggle (this chat neither injects facts nor extracts from its turns) + decay (facts purged when their source conversation is deleted).

**Architecture:** Decay is a pure DB change — flip `user_memories.source_conversation_id` to `ON DELETE CASCADE`. Bypass is a nested `Conversation.memoryOff` flag → the client sends `ChatRequest.memoryBypass` (route skips the Slice-1 inject step) and skips `extractAfterTurn`. A toggle in the chat header sets it. No persist-contract change (nested Conversation field).

**Tech Stack:** TypeScript, Next.js, Supabase, Zustand, Zod, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-19-memory-slice-2-trust-lifecycle-design.md` · **Builds on:** #248 (Slice 1).

---

## File structure

**New:** `supabase/migrations/0027_memory_decay_cascade.sql`

**Modified:**
- `lib/shared/types.ts` — `Conversation.memoryOff?: boolean`.
- `lib/client/hooks/store/slices/conversations.ts` — `setConversationMemoryOff`.
- `lib/shared/api-schemas.ts` (+ `.test.ts`) — `ChatRequestSchema.memoryBypass`.
- `app/api/chat/route.ts` — skip the inject step when `memoryBypass`.
- `lib/client/hooks/use-chat-send.ts` — send `memoryBypass`; skip `extractAfterTurn` when `memoryOff`.
- `components/panels/chat-header.tsx` — "Memory: off" toggle.

**No persist change:** `memoryOff` is a nested field on `Conversation` (already in the persisted `conversations` key), like `codeResults`/`generatedImages` — no `STORE_VERSION` bump.

---

## Task 1: Decay — FK cascade migration

**Files:** Create `supabase/migrations/0027_memory_decay_cascade.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Memory decay: when a conversation is deleted, purge the facts extracted
-- from it. (source_message_id stays SET NULL — editing/regenerating one
-- message must not drop a still-valid fact.)
alter table user_memories
  drop constraint user_memories_source_conversation_id_fkey;
alter table user_memories
  add constraint user_memories_source_conversation_id_fkey
  foreign key (source_conversation_id) references conversations(id) on delete cascade;
```
> Postgres auto-names the FK from `0026` as `user_memories_source_conversation_id_fkey`. Confirm by inspecting `0026_user_memories.sql` (the column was `source_conversation_id uuid references conversations(id) on delete set null`, which yields that default constraint name).

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0027_memory_decay_cascade.sql
git commit -m "feat(memory): decay — purge facts when source conversation is deleted

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `Conversation.memoryOff` + store setter

**Files:** Modify `lib/shared/types.ts`, `lib/client/hooks/store/slices/conversations.ts`

- [ ] **Step 1: Add the field**

In `lib/shared/types.ts`, add to the `Conversation` interface (beside `systemPrompt`):
```ts
  /** Per-conversation memory bypass. When true, this chat neither injects
   *  remembered facts nor extracts new ones (a "memory off" chat). Absent
   *  / false = normal (memory applies for opted-in users). */
  memoryOff?: boolean
```

- [ ] **Step 2: Add the setter (mirror `setConversationSystemPrompt`)**

In `lib/client/hooks/store/slices/conversations.ts`, add to the slice interface:
```ts
  setConversationMemoryOff: (conversationId: string, value: boolean) => void
```
and the impl (beside `setConversationSystemPrompt`):
```ts
  setConversationMemoryOff: (conversationId, value) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, memoryOff: value, updatedAt: new Date() }
          : c
      ),
    })),
```

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add lib/shared/types.ts lib/client/hooks/store/slices/conversations.ts
git commit -m "feat(memory): Conversation.memoryOff flag + setConversationMemoryOff

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire schema + route inject-skip (TDD on schema)

**Files:** Modify `lib/shared/api-schemas.ts` (+ `.test.ts`), `app/api/chat/route.ts`

- [ ] **Step 1: Write the failing schema test** (append to `lib/shared/api-schemas.test.ts`)

```ts
describe("ChatRequestSchema.memoryBypass", () => {
  const base = { messages: [{ role: "user", content: "hi" }] }
  test("accepts memoryBypass true/false/absent", () => {
    expect(ChatRequestSchema.safeParse({ ...base, memoryBypass: true }).success).toBe(true)
    expect(ChatRequestSchema.safeParse({ ...base, memoryBypass: false }).success).toBe(true)
    expect(ChatRequestSchema.safeParse(base).success).toBe(true)
  })
  test("rejects a non-boolean memoryBypass", () => {
    expect(ChatRequestSchema.safeParse({ ...base, memoryBypass: "yes" }).success).toBe(false)
  })
})
```
> Match the test file's real `base`/`ChatRequestSchema` import (the custom-instructions / sandboxFiles tests there show the fixture shape).

- [ ] **Step 2: Run → FAIL.** **Step 3: Add the field**

In `lib/shared/api-schemas.ts`, inside `ChatRequestSchema` (near `workspaceSystemPrompt`, ~line 138):
```ts
  /** When true, bypass cross-conversation memory for this turn: the route
   *  injects no remembered facts. The client sets it from the
   *  conversation's `memoryOff` and also skips post-turn extraction. */
  memoryBypass: z.boolean().optional(),
```

- [ ] **Step 4: Skip injection in the route**

In `app/api/chat/route.ts`, change the Slice-1 inject line (~486):
```ts
  const memoryBlock = body.memoryBypass
    ? undefined
    : (renderMemoryBlock(await loadActiveFacts()) ?? undefined)
```
(`loadActiveFacts` is skipped entirely when bypassed — no DB call.)

- [ ] **Step 5: Run schema test + typecheck + lint; commit**

```bash
bun test lib/shared/api-schemas.test.ts && bun run typecheck && bun run lint
git add lib/shared/api-schemas.ts lib/shared/api-schemas.test.ts app/api/chat/route.ts
git commit -m "feat(memory): ChatRequest.memoryBypass — route skips fact injection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Client — send `memoryBypass` + skip extraction

**Files:** Modify `lib/client/hooks/use-chat-send.ts`

- [ ] **Step 1: Send `memoryBypass` in the chat body**

In `lib/client/hooks/use-chat-send.ts`, the regular (non-task) chat send body is assembled around line 479 (where `workspaceSystemPrompt` is set). Add `memoryBypass` from the active conversation (`conv` is resolved ~line 231 as `conversations.find((c) => c.id === targetConvId)`):
```ts
            workspaceSystemPrompt,
            ...(conv?.memoryOff ? { memoryBypass: true } : {}),
```
(Only the chat route injects memory in Slice 1, so the task-mode body at ~line 275 needs no change.)

- [ ] **Step 2: Skip extraction for memory-off chats**

In the post-turn extract block (~line 822), tighten the gate from `if (memoryEnabled)` to also honor the conversation flag:
```ts
          if (memoryEnabled && !conv?.memoryOff) {
```
(`conv` is in scope from line 231. If it isn't at that point in the closure, read it fresh: `useStore.getState().conversations.find((c) => c.id === targetConvId)?.memoryOff`.)

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add lib/client/hooks/use-chat-send.ts
git commit -m "feat(memory): client sends memoryBypass + skips extract for memory-off chats

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: UI — "Memory: off" toggle in the chat header

**Files:** Modify `components/panels/chat-header.tsx`

- [ ] **Step 1: Add the toggle**

`chat-header.tsx` already surfaces the per-conversation **"Thread instructions"** control (~line 305) and renders `ThreadInstructionsDialog` (~line 498) — read that block to find the menu/control container + how it gets the active conversation. Add a sibling **"Memory: off"** toggle (a switch or a menu item) for the active conversation:
- Read the active conversation's `memoryOff` (the header already has the active conversation to drive "Thread instructions •"); reflect it.
- On change, call `useStore.getState().setConversationMemoryOff(conversationId, next)` (or via a `useStore((s) => s.setConversationMemoryOff)` selector, matching how the header calls `setConversationSystemPrompt`/other mutators).
- Label e.g. "Use memory in this chat" (on by default) or "Memory off"; match the header's existing control idiom (menu item with a checkmark, or a Switch row). Keep copy consistent with the "Thread instructions" entry.

> Match the header's actual control pattern (dropdown menu items vs inline buttons). If the header reads the active conversation via a selector/prop, reuse it; don't introduce a new lookup.

- [ ] **Step 2: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add components/panels/chat-header.tsx
git commit -m "feat(memory): per-conversation 'memory off' toggle in the chat header

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verification + PR

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new schema test + existing).
- [ ] **Step 4:** `bun run build` → succeeds.
- [ ] **Step 5:** `bun run audit:bundle` → clean.
- [ ] **Step 6: Manual smoke** (needs Supabase + model): with memory enabled —
  1. Toggle a chat to "memory off" → its turns add no facts (check Settings → Memory) and existing facts aren't reflected by the model in that chat.
  2. A normal chat still extracts + injects.
  3. Produce a fact in conversation X, then **delete X** → the fact disappears from Settings → Memory (decay cascade).
- [ ] **Step 7: Open the PR into `dev`.** Body: summary (per-conversation memory-off toggle + decay-on-conversation-delete; pause/wipe already shipped), spec + plan links, test list, smoke results. Push `feat/memory-slice-2-trust`; commit trailer as above.

---

## Out of scope

Full ephemeral "Temporary Chat" (non-persisted conversations); grace-period decay (immediate cascade chosen); chat-driven remember/forget; "Memory updated" cue; Arm A embeddings.

## Risks

- **FK constraint name** — confirm `user_memories_source_conversation_id_fkey` against `0026` before the `drop constraint` (a wrong name fails the migration). It's the Postgres default for that column/table, so it should match.
- **`conv` scope in `use-chat-send`** — `memoryBypass` (send) and the extract-skip both need the conversation's `memoryOff`; `conv` is resolved at ~line 231. If a closure captures a stale `conv`, read fresh via `useStore.getState()` (as the extract block already does for the assistant text).
- **Header control idiom** — match the existing per-conversation control pattern; the toggle is the only judgment-heavy bit (everything else is mechanical).
- **Back-compat** — `memoryOff`/`memoryBypass` default falsy → existing chats behave exactly as Slice 1.
```
