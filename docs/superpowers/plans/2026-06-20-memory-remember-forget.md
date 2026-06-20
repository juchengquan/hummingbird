# Memory chat-driven remember/forget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `rememberFact` + `forgetFact` model-callable tools so the model can add/remove a memory fact when the user asks — available only when memory is on for the turn.

**Architecture:** A pure `matchFactsToForget` (exact-then-contains text match) + a pure `shouldOfferMemoryTools` gate. `buildMemoryTools` exposes the two AI-SDK tools (RLS-scoped via the authed server client). The chat route computes memory state once (`loadMemoryState → {enabled, facts}`), uses it for the Slice-1 injection, and — when `enabled && !memoryBypass` — adds the two tools + a short prompt note. Embedding-free; reuses Slice-1's `user_memories`.

**Tech Stack:** TypeScript, Next.js, AI SDK `tool()`, Zod, Supabase (RLS), bun:test.

**Spec:** `docs/superpowers/specs/2026-06-20-memory-remember-forget-design.md` · **Builds on:** #248 (Slice 1), #249 (Slice 2).

---

## File structure

**New:**
- `lib/server/memory/forget-match.ts` (+ `.test.ts`) — pure `matchFactsToForget` + `shouldOfferMemoryTools`.
- `lib/server/memory/tools.ts` — `buildMemoryTools(ctx)` + `MEMORY_TOOLS_NOTE`.

**Modified:**
- `lib/server/memory/load-facts.ts` — add `loadMemoryState(): Promise<{ enabled: boolean; facts: {fact;category}[] }>` (one profiles read for both the block + the tool gate).
- `app/api/chat/route.ts` — use `loadMemoryState`; add memory tools + note when `enabled && !memoryBypass`.

---

## Task 1: Pure helpers — `matchFactsToForget` + `shouldOfferMemoryTools` (TDD)

**Files:** Create `lib/server/memory/forget-match.ts` + `forget-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"

import { matchFactsToForget, shouldOfferMemoryTools } from "./forget-match"

const facts = [
  { id: "f1", fact: "Prefers dark mode" },
  { id: "f2", fact: "Runs Postgres 16 on Hetzner" },
]

describe("matchFactsToForget", () => {
  test("exact match (case-insensitive) → that id", () => {
    expect(matchFactsToForget(facts, "prefers dark mode")).toEqual(["f1"])
  })
  test("no exact but contains (fact contains text) → those ids", () => {
    expect(matchFactsToForget(facts, "dark mode")).toEqual(["f1"])
  })
  test("contains the other direction (text contains fact) → match", () => {
    expect(matchFactsToForget([{ id: "f3", fact: "dark mode" }], "I prefer dark mode")).toEqual(["f3"])
  })
  test("multiple contains matches → all ids", () => {
    const f = [{ id: "a", fact: "likes tea" }, { id: "b", fact: "likes tea in the morning" }]
    expect(matchFactsToForget(f, "likes tea").sort()).toEqual(["a", "b"])
  })
  test("exact wins over contains (returns only the exact)", () => {
    const f = [{ id: "a", fact: "tea" }, { id: "b", fact: "tea with milk" }]
    expect(matchFactsToForget(f, "tea")).toEqual(["a"])
  })
  test("no match → []", () => {
    expect(matchFactsToForget(facts, "skydiving")).toEqual([])
  })
  test("whitespace is normalized", () => {
    expect(matchFactsToForget(facts, "  Prefers Dark Mode  ")).toEqual(["f1"])
  })
})

describe("shouldOfferMemoryTools", () => {
  test("true iff enabled && !memoryBypass", () => {
    expect(shouldOfferMemoryTools({ enabled: true, memoryBypass: false })).toBe(true)
    expect(shouldOfferMemoryTools({ enabled: true, memoryBypass: true })).toBe(false)
    expect(shouldOfferMemoryTools({ enabled: false, memoryBypass: false })).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Write `forget-match.ts`**

```ts
import "server-only"

const norm = (s: string) => s.trim().toLowerCase()

/** Pick which fact ids a forget request targets. Exact (normalized) match
 *  wins; otherwise any fact that contains the text or is contained by it;
 *  otherwise none. Pure. */
export function matchFactsToForget(
  facts: { id: string; fact: string }[],
  text: string,
): string[] {
  const t = norm(text)
  if (!t) return []
  const exact = facts.filter((f) => norm(f.fact) === t).map((f) => f.id)
  if (exact.length) return exact
  return facts
    .filter((f) => {
      const nf = norm(f.fact)
      return nf.includes(t) || t.includes(nf)
    })
    .map((f) => f.id)
}

/** Offer the remember/forget tools only when memory is on for this turn. */
export function shouldOfferMemoryTools(opts: {
  enabled: boolean
  memoryBypass?: boolean
}): boolean {
  return opts.enabled && !opts.memoryBypass
}
```

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/memory/forget-match.test.ts && bun run typecheck
git add lib/server/memory/forget-match.ts lib/server/memory/forget-match.test.ts
git commit -m "feat(memory): pure matchFactsToForget + shouldOfferMemoryTools (TDD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `loadMemoryState` (one read for block + gate)

**Files:** Modify `lib/server/memory/load-facts.ts`

- [ ] **Step 1: Add `loadMemoryState`**

Add alongside `loadActiveFacts` (reuse the same authed-client + RLS pattern). It returns the enabled flag **and** the facts from a single profiles + memories read:

```ts
/** Memory state for the current request: whether the user opted in, plus
 *  their active facts. One profiles read serves both the inject block and
 *  the remember/forget tool gate. Never throws. */
export async function loadMemoryState(): Promise<{
  enabled: boolean
  facts: { fact: string; category: string | null }[]
}> {
  try {
    const supabase = await getSupabaseServerClient()
    if (!supabase) return { enabled: false, facts: [] }
    const { data: prof } = await supabase.from("profiles").select("memory_enabled").single()
    if (!prof?.memory_enabled) return { enabled: false, facts: [] }
    const { data } = await supabase
      .from("user_memories")
      .select("fact, category")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
    return {
      enabled: true,
      facts: (data ?? []).map((r) => ({ fact: r.fact as string, category: (r.category as string) ?? null })),
    }
  } catch {
    return { enabled: false, facts: [] }
  }
}
```
(Keep `loadActiveFacts` as-is for now, or have it delegate to `loadMemoryState().facts` — either is fine; the route switches to `loadMemoryState`.)

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/memory/load-facts.ts
git commit -m "feat(memory): loadMemoryState — enabled flag + facts in one read

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The tools — `buildMemoryTools`

**Files:** Create `lib/server/memory/tools.ts`

- [ ] **Step 1: Write the tools**

```ts
import "server-only"

import { tool } from "ai"
import { z } from "zod"

import { getSupabaseServerClient } from "@/server/supabase/server"

import { matchFactsToForget } from "./forget-match"

/** System-prompt nudge shown whenever the tools are offered (even with no
 *  facts yet, so "remember" works from empty). */
export const MEMORY_TOOLS_NOTE =
  "When the user asks you to remember something about them, call `rememberFact`. " +
  "When they ask you to forget something, call `forgetFact` with the exact text " +
  "of the listed memory."

export function buildMemoryTools(ctx: { conversationId?: string | null }) {
  const rememberFact = tool({
    description:
      "Save a durable fact about the user to long-term memory (used across future chats). Call when the user asks you to remember something.",
    inputSchema: z.object({
      fact: z.string().min(1).max(500),
      category: z.string().max(40).optional(),
    }),
    async execute({ fact, category }) {
      try {
        const supabase = await getSupabaseServerClient()
        if (!supabase) return { ok: false, error: "not signed in" }
        const { data: userRes } = await supabase.auth.getUser()
        const userId = userRes?.user?.id
        if (!userId) return { ok: false, error: "not signed in" }
        await supabase.from("user_memories").insert({
          user_id: userId,
          fact,
          category: category ?? null,
          source_conversation_id: ctx.conversationId ?? null,
        })
        return { ok: true }
      } catch {
        return { ok: false, error: "could not save" }
      }
    },
  })

  const forgetFact = tool({
    description:
      "Remove a remembered fact from long-term memory. Pass the exact text of the memory as shown in the listed memories.",
    inputSchema: z.object({ fact: z.string().min(1).max(500) }),
    async execute({ fact }) {
      try {
        const supabase = await getSupabaseServerClient()
        if (!supabase) return { ok: false, removed: 0, error: "not signed in" }
        const { data } = await supabase
          .from("user_memories")
          .select("id, fact")
          .eq("status", "active")
        const rows = (data ?? []).map((r) => ({ id: r.id as string, fact: r.fact as string }))
        const ids = matchFactsToForget(rows, fact)
        if (ids.length === 0) return { ok: true, removed: 0, note: "No matching memory found." }
        await supabase.from("user_memories").delete().in("id", ids)
        return { ok: true, removed: ids.length }
      } catch {
        return { ok: false, removed: 0, error: "could not remove" }
      }
    },
  })

  return { rememberFact, forgetFact }
}
```
> Confirm `getSupabaseServerClient` import path + the AI SDK `tool({ inputSchema, execute })` shape against the codebase (matches `code-interpreter.ts`). RLS bounds the insert/select/delete to the user.

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/memory/tools.ts
git commit -m "feat(memory): rememberFact + forgetFact tools (RLS, exact/contains forget)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route wiring + prompt note

**Files:** Modify `app/api/chat/route.ts`

- [ ] **Step 1: Use `loadMemoryState` + offer the tools**

Replace the Slice-1 memory-block computation (~lines 487–490) so one read drives both the block and the tool gate, and add the tools + note when offered. (The `tools` object is built earlier ~368–418 and is in scope here, before it's passed to the model.)

```ts
import { loadMemoryState } from '@/server/memory/load-facts'
import { renderMemoryBlock } from '@/server/memory/render'
import { shouldOfferMemoryTools } from '@/server/memory/forget-match'
import { buildMemoryTools, MEMORY_TOOLS_NOTE } from '@/server/memory/tools'
// (drop the old loadActiveFacts import if now unused)

const memState = body.memoryBypass
  ? { enabled: false, facts: [] as { fact: string; category: string | null }[] }
  : await loadMemoryState()

const offerMemoryTools = shouldOfferMemoryTools({
  enabled: memState.enabled,
  memoryBypass: body.memoryBypass,
})
if (offerMemoryTools) {
  const memTools = buildMemoryTools({ conversationId: /* the chat's conversation id if the route has it, else */ null })
  tools.rememberFact = memTools.rememberFact
  tools.forgetFact = memTools.forgetFact
}

// Memory block: facts (if any) + the tools note (when offered, so "remember"
// works even with zero facts).
const memoryBlock = memState.enabled
  ? ([renderMemoryBlock(memState.facts), offerMemoryTools ? MEMORY_TOOLS_NOTE : null]
      .filter(Boolean)
      .join("\n\n") || undefined)
  : undefined
```
Keep passing `memoryBlock` to `buildSystemPrompt(...)` as before.

> `tools` is a plain record (`tools[name] = ...` is used for MCP + render-UI). Use the same assignment style. For `conversationId`: pass the chat's conversation id if the route/body exposes it (grep the route + `ChatRequestSchema` for a conversation id field); if there isn't one, pass `null` — `source_conversation_id` is nullable and an explicit user-remembered fact simply won't be conversation-scoped for decay.

- [ ] **Step 2: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add app/api/chat/route.ts
git commit -m "feat(memory): offer rememberFact/forgetFact tools + note when memory is on

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Verification + PR

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new `forget-match` tests + existing memory/persist).
- [ ] **Step 4:** `bun run build` → succeeds.
- [ ] **Step 5:** `bun run audit:bundle` → clean (`lib/server/memory/*` is `server-only`).
- [ ] **Step 6: Manual smoke** (Supabase + model, memory enabled): "remember I prefer dark mode" → the model calls `rememberFact`; the fact appears in Settings → Memory and is reflected in a later chat. "forget that I prefer dark mode" → `forgetFact` removes it. A **memory-off** chat (Slice 2) → the model has no remember/forget tools. Second user can't affect the first's facts (RLS).
- [ ] **Step 7: Open the PR into `dev`.** Body: summary (chat-driven remember/forget tools, auto-on when memory enabled, exact/contains forget, embedding-free), spec + plan links, test list, smoke results. Push `feat/memory-remember-forget`; commit trailer as above.

---

## Out of scope

"Memory updated" transparency cue (separate deferred item); bulk ops / undo; fuzzy/semantic forget (embedding-free — exact/contains only); Arm A message-embedding recall (deferred).

## Risks

- **Authed client** — `rememberFact`/`forgetFact` must use the request-scoped **user** client (`getSupabaseServerClient`); RLS bounds insert/select/delete to the user. Never service-role.
- **`tools` assembly order** — memory tools must be added before `tools` is handed to the model (the memState computation at ~487 is before the model call; confirm `tools` is still mutable there — it's the same object the render-UI tool was added to).
- **conversationId availability** — if the chat route has no conversation id, remembered facts get `source_conversation_id = null` (won't decay on conversation delete; acceptable for explicitly-remembered facts).
- **Forget over-match** — contains-match could delete more than intended; mitigated by exact-match-wins + the model passing verbatim text + `removed` count returned so the model can report what it did.
```
