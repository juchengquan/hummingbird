# Cross-conversation memory — chat-driven remember/forget — Design

**Status:** Approved design (2026-06-20). A memory polish increment on top
of Slice 1 (facts — `#248`) + Slice 2 (trust/lifecycle — `#249`).

## Goal

Let the model add or remove a memory fact directly when the user asks
("remember that I…" / "forget that…"), via two model-callable tools —
alongside the existing async auto-extractor. Embedding-free; RLS-scoped;
available only when memory is on for the turn.

## Decisions locked (brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Forget targeting | **Exact-text match** — the model passes the fact's verbatim text from the injected memory list; the tool matches exact, else case-insensitive contains, else none. No id plumbing, no id exposure. |
| D2 | Tool surface | **Auto-on when memory is on** — the route adds the tools when `memory_enabled && !memoryBypass`. No new user-facing toggle (the `memory_enabled` switch already governs memory; a memory-off chat gets no memory tools). |
| D3 | Shape | **Two tools** — `rememberFact` + `forgetFact` (clearer for the model than one multiplexed tool). |

## Architecture

```
user: "remember I prefer dark mode"  → model calls rememberFact({fact, category?})
                                         → insert user_memories (RLS, source_conversation_id = current)
user: "forget that I prefer dark mode" → model calls forgetFact({fact: "<verbatim listed bullet>"})
                                         → load active facts → matchFactsToForget(facts, text) → delete by id (RLS)
```
The tools are registered in the chat route's tool map **only when**
`memory_enabled && !memoryBypass`. Slice-1 injection/extraction and the
Slice-1 manage panel operate on the same `user_memories` rows unchanged.

## Components & boundaries

### `matchFactsToForget` — pure (the testable core)
`lib/server/memory/forget-match.ts`:
`matchFactsToForget(facts: { id: string; fact: string }[], text: string): string[]`
- Normalize (trim, lowercase) for comparison.
- **Exact match** (normalized equality) → return those ids.
- Else **contains match** (a fact contains the text or vice-versa) → those ids.
- Else `[]`.
Pure, unit-tested; the tool does the I/O around it.

### Tools — `lib/server/memory/tools.ts`
- `buildMemoryTools(ctx)` → `{ rememberFact, forgetFact }` (AI SDK `tool()`s), where `ctx` carries what the execute needs (the request-scoped authed Supabase client / a way to get it, + the current `conversationId`). Both use the **user** client (`getSupabaseServerClient`) → RLS bounds everything to the signed-in user; best-effort (never throw out of `execute` — return a soft result).
- `rememberFact`: `inputSchema z.object({ fact: z.string().min(1).max(500), category: z.string().max(40).optional() })`; inserts `{ user_id, fact, category, source_conversation_id }`; returns `{ ok: true }`.
- `forgetFact`: `inputSchema z.object({ fact: z.string().min(1).max(500) })`; loads the user's active `{id, fact}`, `matchFactsToForget`, deletes by id; returns `{ ok: true, removed: <count> }` (or `{ ok: true, removed: 0, note: "No matching memory found." }`).

### Route wiring — `app/api/chat/route.ts`
Where the route already adds non-skill tools (the render-UI tool, ~line 418) and computes the memory block: when **`memory_enabled && !body.memoryBypass`**, add `tools.rememberFact` + `tools.forgetFact`. Reuse a single memory-state read (e.g. extend the Slice-1 load to return `{ enabled, facts }`, or a small `isMemoryEnabled()`), so the profiles check isn't duplicated. A tiny pure `shouldOfferMemoryTools({ enabled, memoryBypass })` keeps the gate testable.

### Prompt guidance
A short line, present whenever the tools are offered (even with zero facts, so "remember" works from empty): *"When the user asks you to remember something, call `rememberFact`. To forget, call `forgetFact` with the exact text of the listed memory."* Lives alongside the Slice-1 memory block (render it when tools are offered regardless of fact count) and/or the tool descriptions.

## Error handling / security
- All reads/writes via the request-scoped **user** Supabase client — RLS bounds to `auth.uid()`; a user can't remember/forget into another user's memory.
- Tools only exist when `memory_enabled && !memoryBypass` → memory-off chats and opted-out/anonymous users never see them.
- `forgetFact` with no match → `removed: 0` + note (non-fatal); the model can tell the user nothing matched.
- `execute` is best-effort; DB failure → a soft error result, never throws.

## Testing
- **`matchFactsToForget` (pure, TDD):** exact match (case-insensitive); contains match (substring either direction); no match → []; multiple contains → all matching ids; whitespace normalization.
- **`shouldOfferMemoryTools` (pure):** true iff `enabled && !memoryBypass`.
- **Manual smoke (Supabase + model):** "remember I prefer dark mode" → fact appears in Settings → Memory + influences a later chat; "forget that I prefer dark mode" → gone; a memory-off chat → model has no remember/forget tools; second user can't touch the first's facts (RLS).

## Scope / out
- No "Memory updated" transparency cue (separate deferred item).
- No bulk ops / undo; forget is exact-or-contains text match (no fuzzy/semantic — embedding-free).
- Arm A (message-embedding recall) remains deferred.
