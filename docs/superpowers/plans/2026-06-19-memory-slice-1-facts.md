# Cross-conversation memory — Slice 1 (summary/facts, embedding-free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opted-in (signed-in) users get an auto-maintained set of distilled **facts** (role, stack, preferences, projects), injected into every chat and editable in a "Memory" settings panel. **No embeddings, no vector store.**

**Architecture:** A `user_memories` text-fact table (own-row RLS) + a `profiles.memory_enabled` toggle. After a turn, the client fires a best-effort `POST /api/memory/extract`; a cheap structured-model call distills facts and a pure `mergeFacts` computes the upsert against existing facts (merge-don't-append, no similarity). On each turn, a route step loads the user's active facts and a pure `renderMemoryBlock` prepends them to the system prompt (inject-all-active). A settings panel lists/edits/deletes facts. Mirrors the custom-instructions PR (#241) for the profiles toggle + sync + settings UI, and PR-2 for the request-scoped authed Supabase client.

**Tech Stack:** TypeScript, Next.js, Supabase (RLS), AI SDK `generateObject` via `generateStructured`, Zod, Zustand, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-19-memory-slice-1-facts-design.md` · **Plan:** `docs/PLAN-cross-conversation-memory.md` (revised — Arm B primary, embedding-free, Arm A deferred).

---

## File structure

**New:**
- `supabase/migrations/0026_user_memories.sql`
- `lib/server/memory/types.ts` — `MemoryFact`, `FactOp`, the extractor schema.
- `lib/server/memory/merge.ts` (+ `.test.ts`) — pure `mergeFacts`.
- `lib/server/memory/render.ts` (+ `.test.ts`) — pure `renderMemoryBlock`.
- `lib/server/memory/load-facts.ts` — `loadActiveFacts(userId)` (authed client).
- `lib/server/memory/extract.ts` — `extractFacts(...)` (structured model call + merge + upsert).
- `app/api/memory/extract/route.ts` — gated extraction endpoint.
- `lib/client/memory/extract-after-turn.ts` — client best-effort fire.
- `lib/client/supabase/memory.ts` — client RLS read/write of facts + `memory_enabled` (sync template = `account-instructions.ts`).
- `components/chat/memory-panel.tsx` — the "Memory" manage panel.

**Modified:**
- `lib/server/chat/prompt-builders.ts` — `buildSystemPrompt` gains `memoryBlock?`.
- `app/api/chat/route.ts` — load facts + pass `memoryBlock`.
- `lib/client/hooks/store/slices/account-instructions.ts` *(or a new `memory` slice)* — `memoryEnabled` flag + setter. **(See Task 5 note: pick one.)**
- `lib/client/hooks/use-chat-send.ts` — fire `extractAfterTurn` post-turn when enabled.
- `lib/client/hooks/use-sync.ts` — load `memory_enabled` on sign-in.
- `components/auth/account-menu.tsx` — "Enable memory" toggle + Memory-panel entry.

---

## Task 1: Migration — `user_memories` + toggle

**Files:** Create `supabase/migrations/0026_user_memories.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Cross-conversation memory: distilled, user-editable facts (embedding-free).
create table user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact text not null,
  category text,
  source_conversation_id uuid references conversations(id) on delete set null,
  source_message_id uuid references messages(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_memories enable row level security;
create policy "own memories" on user_memories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index user_memories_user_status_idx on user_memories (user_id, status);

alter table profiles
  add column if not exists memory_enabled boolean not null default false;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/0026_user_memories.sql
git commit -m "feat(memory): user_memories table + profiles.memory_enabled (slice 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
> The `0026` number is the next free slot (latest is `0025_account_custom_instructions.sql`). Confirm before writing.

---

## Task 2: Pure helpers — `mergeFacts` + `renderMemoryBlock` (TDD)

**Files:** Create `lib/server/memory/types.ts`, `merge.ts` (+`.test.ts`), `render.ts` (+`.test.ts`)

- [ ] **Step 1: Types** — `lib/server/memory/types.ts`

```ts
import "server-only"

import { z } from "zod"

/** A stored fact row (subset used by the helpers). */
export interface MemoryFact {
  id: string
  fact: string
  category: string | null
}

/** Soft cap on active facts per user. */
export const MEMORY_FACT_CAP = 100

/** The extractor's structured output: a list of ops against the user's
 *  existing facts. `add` = new fact; `update` = revise an existing fact
 *  by id. (No `delete` from extraction — users delete via the panel.) */
export const FactOpSchema = z.object({
  op: z.enum(["add", "update"]),
  id: z.string().optional(), // required for "update"
  fact: z.string().min(1).max(500),
  category: z.string().max(40).optional(),
})
export type FactOp = z.infer<typeof FactOpSchema>

export const ExtractionSchema = z.object({ facts: z.array(FactOpSchema).max(20) })
export type Extraction = z.infer<typeof ExtractionSchema>
```

- [ ] **Step 2: Write the failing `merge.test.ts`**

```ts
import { describe, expect, test } from "bun:test"

import { mergeFacts } from "./merge"
import type { MemoryFact } from "./types"

const existing: MemoryFact[] = [
  { id: "f1", fact: "Runs Postgres 16", category: "stack" },
]

describe("mergeFacts", () => {
  test("add → insert", () => {
    const r = mergeFacts(existing, [{ op: "add", fact: "Prefers TypeScript", category: "preference" }])
    expect(r.inserts).toEqual([{ fact: "Prefers TypeScript", category: "preference" }])
    expect(r.updates).toEqual([])
  })
  test("update with a valid existing id → update", () => {
    const r = mergeFacts(existing, [{ op: "update", id: "f1", fact: "Runs Postgres 17", category: "stack" }])
    expect(r.updates).toEqual([{ id: "f1", fact: "Runs Postgres 17", category: "stack" }])
    expect(r.inserts).toEqual([])
  })
  test("update with an unknown id is dropped (no insert, no update)", () => {
    const r = mergeFacts(existing, [{ op: "update", id: "nope", fact: "x" }])
    expect(r.inserts).toEqual([])
    expect(r.updates).toEqual([])
  })
  test("inserts respect the cap (existing + inserts ≤ MEMORY_FACT_CAP)", () => {
    const many: MemoryFact[] = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, fact: `f${i}`, category: null }))
    const r = mergeFacts(many, [{ op: "add", fact: "overflow" }])
    expect(r.inserts).toEqual([]) // already at cap
  })
  test("category defaults to null when omitted", () => {
    const r = mergeFacts([], [{ op: "add", fact: "solo" }])
    expect(r.inserts[0]).toEqual({ fact: "solo", category: null })
  })
})
```

- [ ] **Step 3: Write `merge.ts`**

```ts
import "server-only"

import { MEMORY_FACT_CAP, type FactOp, type MemoryFact } from "./types"

export interface MergePlan {
  inserts: { fact: string; category: string | null }[]
  updates: { id: string; fact: string; category: string | null }[]
}

/** Turn the extractor's ops into a concrete insert/update plan against the
 *  user's existing facts. Pure: validates `update` ids, drops unknowns,
 *  and caps total active facts. No embeddings / similarity. */
export function mergeFacts(existing: MemoryFact[], ops: FactOp[]): MergePlan {
  const ids = new Set(existing.map((f) => f.id))
  const inserts: MergePlan["inserts"] = []
  const updates: MergePlan["updates"] = []
  let activeCount = existing.length
  for (const op of ops) {
    const category = op.category ?? null
    if (op.op === "update") {
      if (op.id && ids.has(op.id)) updates.push({ id: op.id, fact: op.fact, category })
      // unknown id → drop (the model hallucinated an id)
      continue
    }
    // op === "add"
    if (activeCount >= MEMORY_FACT_CAP) continue
    activeCount++
    inserts.push({ fact: op.fact, category })
  }
  return { inserts, updates }
}
```

- [ ] **Step 4: `merge` tests green** — `bun test lib/server/memory/merge.test.ts`.

- [ ] **Step 5: Write the failing `render.test.ts`**

```ts
import { describe, expect, test } from "bun:test"

import { renderMemoryBlock } from "./render"

describe("renderMemoryBlock", () => {
  test("empty → null", () => {
    expect(renderMemoryBlock([])).toBeNull()
  })
  test("renders a labelled bullet block the user is told they can edit", () => {
    const out = renderMemoryBlock([
      { fact: "Runs Postgres 16", category: "stack" },
      { fact: "Terse answers", category: "preference" },
    ])
    expect(out).toContain("edit")
    expect(out).toContain("- Runs Postgres 16")
    expect(out).toContain("- Terse answers")
  })
  test("facts with no category still render", () => {
    expect(renderMemoryBlock([{ fact: "solo", category: null }])).toContain("- solo")
  })
})
```

- [ ] **Step 6: Write `render.ts`**

```ts
import "server-only"

/** Render the always-on memory block for the system prompt, or null when
 *  there are no facts. Plain bullets (small set, injected whole). */
export function renderMemoryBlock(
  facts: { fact: string; category: string | null }[],
): string | null {
  if (facts.length === 0) return null
  const lines = facts.map((f) => `- ${f.fact}`)
  return [
    "What you know about this user (they can view/edit/remove these in Settings → Memory):",
    ...lines,
  ].join("\n")
}
```

- [ ] **Step 7: `render` tests green; typecheck; commit**

```bash
bun test lib/server/memory/merge.test.ts lib/server/memory/render.test.ts && bun run typecheck
git add lib/server/memory/types.ts lib/server/memory/merge.ts lib/server/memory/merge.test.ts lib/server/memory/render.ts lib/server/memory/render.test.ts
git commit -m "feat(memory): pure mergeFacts + renderMemoryBlock helpers (TDD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Injection — `memoryBlock` in the system prompt

**Files:** Modify `lib/server/chat/prompt-builders.ts`, `app/api/chat/route.ts`; create `lib/server/memory/load-facts.ts`

- [ ] **Step 1: `loadActiveFacts`** — `lib/server/memory/load-facts.ts`

```ts
import "server-only"

import { getSupabaseServerClient } from "@/server/supabase/server"

/** Load the signed-in user's active facts (RLS-scoped), gated on
 *  `profiles.memory_enabled`. Returns [] when signed-out, disabled, or on
 *  any error — never throws. */
export async function loadActiveFacts(): Promise<{ fact: string; category: string | null }[]> {
  try {
    const supabase = await getSupabaseServerClient()
    if (!supabase) return []
    const { data: prof } = await supabase.from("profiles").select("memory_enabled").single()
    if (!prof?.memory_enabled) return []
    const { data } = await supabase
      .from("user_memories")
      .select("fact, category")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
    return (data ?? []).map((r) => ({ fact: r.fact as string, category: (r.category as string) ?? null }))
  } catch {
    return []
  }
}
```
> `.single()` on profiles + the `user_memories` select are RLS-bounded to the user. Match the `getSupabaseServerClient` import used by `lib/server/code-sandbox/download-user-file.ts`.

- [ ] **Step 2: Add `memoryBlock` to `buildSystemPrompt`**

In `lib/server/chat/prompt-builders.ts`, add `memoryBlock?: string` to `BuildSystemPromptOptions`, and prepend it in the `base` array (first, so the model reads "who the user is" before generic guidance), e.g.:
```ts
  const base = [
    opts.memoryBlock?.trim() || undefined,
    trimmedWorkspace,
    "You are a helpful chat assistant inside the Hummingbird app. " +
      "Answer concisely and use Markdown formatting when useful.",
    skillsLine,
    mcpLine,
    remixLine,
  ].filter(Boolean).join("\n\n")
```

- [ ] **Step 3: Wire the route**

In `app/api/chat/route.ts`, before the `buildSystemPrompt({ ... })` call (~line 487), load + render the block, and pass it:
```ts
import { loadActiveFacts } from '@/server/memory/load-facts'
import { renderMemoryBlock } from '@/server/memory/render'
// ...
const memoryBlock = renderMemoryBlock(await loadActiveFacts()) ?? undefined
// ... in the buildSystemPrompt call:
buildSystemPrompt({
  workspaceSystemPrompt: body.workspaceSystemPrompt,
  memoryBlock,
  // ...existing fields
})
```
(`loadActiveFacts` self-gates on sign-in + `memory_enabled`, so this is a no-op for everyone else — just an empty block.)

- [ ] **Step 4: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add lib/server/memory/load-facts.ts lib/server/chat/prompt-builders.ts app/api/chat/route.ts
git commit -m "feat(memory): inject active facts into the system prompt (always-on)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> If `prompt-builders.test.ts` pins the composed output, add a case: `memoryBlock` present → appears first; absent → output unchanged.

---

## Task 4: Extraction — model call + upsert

**Files:** Create `lib/server/memory/extract.ts`, `app/api/memory/extract/route.ts`

- [ ] **Step 1: `extractFacts`** — `lib/server/memory/extract.ts`

```ts
import "server-only"

import { generateStructured } from "@/server/ai/structured"
import { getSupabaseServerClient } from "@/server/supabase/server"

import { mergeFacts } from "./merge"
import { ExtractionSchema, type MemoryFact } from "./types"

const MODEL = process.env.MEMORY_EXTRACT_MODEL || "openai/gpt-4o-mini"

const PROMPT = (turn: string, existing: MemoryFact[]) =>
  [
    "You maintain a durable memory of stable facts about a user from their chats.",
    "From the conversation turn below, extract ONLY durable, stable facts worth",
    "remembering long-term (role, tech stack, recurring preferences, ongoing",
    "projects). Skip ephemeral/task-specific details. Return `facts: []` if the",
    "turn has nothing durable (this is common).",
    "",
    "For each fact, emit an op: `add` for a new fact, or `update` with the `id`",
    "of an existing fact it revises/replaces. Do NOT duplicate an existing fact.",
    "",
    "Existing facts (id — fact):",
    existing.length ? existing.map((f) => `${f.id} — ${f.fact}`).join("\n") : "(none)",
    "",
    "Conversation turn:",
    turn,
  ].join("\n")

/** Extract + merge + upsert durable facts for the signed-in user. Gated +
 *  best-effort: returns silently on any failure. Conversation/message ids
 *  are optional provenance. */
export async function extractFacts(input: {
  turnText: string
  conversationId?: string
}): Promise<void> {
  const supabase = await getSupabaseServerClient()
  if (!supabase) return
  const { data: prof } = await supabase.from("profiles").select("memory_enabled").single()
  if (!prof?.memory_enabled) return
  const { data: userRes } = await supabase.auth.getUser()
  const userId = userRes?.user?.id
  if (!userId) return

  const { data: rows } = await supabase
    .from("user_memories").select("id, fact, category").eq("status", "active")
  const existing: MemoryFact[] = (rows ?? []).map((r) => ({
    id: r.id as string, fact: r.fact as string, category: (r.category as string) ?? null,
  }))

  let extraction
  try {
    extraction = await generateStructured({
      modelId: MODEL,
      schema: ExtractionSchema,
      prompt: PROMPT(input.turnText, existing),
      temperature: 0,
      maxOutputTokens: 800,
    })
  } catch {
    return // model/config failure → skip
  }

  const plan = mergeFacts(existing, extraction.facts)
  if (plan.inserts.length) {
    await supabase.from("user_memories").insert(
      plan.inserts.map((i) => ({
        user_id: userId, fact: i.fact, category: i.category,
        source_conversation_id: input.conversationId ?? null,
      })),
    )
  }
  for (const u of plan.updates) {
    await supabase.from("user_memories")
      .update({ fact: u.fact, category: u.category, updated_at: new Date().toISOString() })
      .eq("id", u.id)
  }
}
```
> Confirm `generateStructured`'s option names against `lib/server/ai/structured.ts` (`modelId`/`schema`/`prompt`/`temperature`/`maxOutputTokens`). Pick a real cheap model id available in the gateway/provider config for `MEMORY_EXTRACT_MODEL`'s default.

- [ ] **Step 2: The route** — `app/api/memory/extract/route.ts`

```ts
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { extractFacts } from '@/server/memory/extract'

const BodySchema = z.object({
  turnText: z.string().min(1).max(50_000),
  conversationId: z.string().max(64).optional(),
})

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  // extractFacts self-gates (sign-in + memory_enabled) and never throws.
  await extractFacts(parsed.data)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add lib/server/memory/extract.ts app/api/memory/extract/route.ts
git commit -m "feat(memory): /api/memory/extract — structured fact extraction + upsert

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Toggle + sync + post-turn fire

**Files:** Create `lib/client/supabase/memory.ts`, `lib/client/memory/extract-after-turn.ts`; modify a store slice, `use-sync.ts`, `use-chat-send.ts`, `account-menu.tsx`

- [ ] **Step 1: Client supabase helpers** — `lib/client/memory/extract-after-turn.ts` + `lib/client/supabase/memory.ts`

`extract-after-turn.ts` (best-effort POST):
```ts
import "client-only"

import { apiUrls } from "@/client/api-client" // or hardcode "/api/memory/extract"

export function extractAfterTurn(turnText: string, conversationId: string): void {
  void fetch("/api/memory/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnText, conversationId }),
  }).catch(() => {})
}
```
`memory.ts` (read/write `memory_enabled`, mirroring `account-instructions.ts`): `fetchMemoryEnabled(userId)` and `writeMemoryEnabled(userId, enabled)` via `getSupabaseBrowserClient()` (best-effort, RLS).

- [ ] **Step 2: Store flag** — add `memoryEnabled: boolean` + `setMemoryEnabled` to a slice. **Decision:** add to the existing `account-instructions` slice (rename considerations aside, it's the "personalization settings" slice) OR a tiny new `memory` slice. Persist it (so the toggle state survives reload; the profiles value is authoritative on sign-in load). Bump `STORE_VERSION` + add the persisted key + migration + `persist.test.ts` (per the frozen-persist contract — same as the account-instructions slice did).

- [ ] **Step 3: Sync on auth** — in `lib/client/hooks/use-sync.ts`, alongside the account-instructions load, `fetchMemoryEnabled(userId)` → `setMemoryEnabled(...)` (server-wins on load).

- [ ] **Step 4: Fire after a turn** — in `lib/client/hooks/use-chat-send.ts`, after a turn's assistant message finalizes, if `memoryEnabled`, call `extractAfterTurn(<user+assistant text of this turn>, conversationId)`. (Read `memoryEnabled` from the store the way the hook reads other store state.)

- [ ] **Step 5: AccountMenu toggle** — in `components/auth/account-menu.tsx`, add an "Enable memory" switch (sign-in-gated row) bound to `memoryEnabled`; on change, `setMemoryEnabled` + `writeMemoryEnabled(userId, next)`; when turning ON, also kick a backfill (Step 6 of Task 7 / optional: a one-shot `extractAfterTurn` over recent history is out of v1 — note it). Mirror the custom-instructions menu-item pattern.

- [ ] **Step 6: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add -A
git commit -m "feat(memory): memory_enabled toggle + sync + post-turn extraction fire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **Adaptation:** Steps 2–4 must match the codebase's real patterns — copy the `account-instructions` slice/persist/sync wiring (it's the exact template for a profiles-backed singleton setting) and the hook's existing store-access + turn-finalization point. If the turn-finalization point in `use-chat-send.ts` is unclear, report DONE_WITH_CONCERNS rather than guess.

---

## Task 6: Memory manage panel

**Files:** Create `components/chat/memory-panel.tsx`; modify `components/auth/account-menu.tsx`

- [ ] **Step 1: The panel** — `components/chat/memory-panel.tsx`

A dialog (mirror `custom-instructions-dialog.tsx`) that, when open, fetches the user's active facts via the browser Supabase client (RLS) and lists them grouped by category. Per-row **edit** (inline text) + **delete**; a **"Clear all"** destructive action. Writes via the browser client (RLS):
- list: `from("user_memories").select("id, fact, category").eq("status","active").order("updated_at",{ascending:false})`
- edit: `.update({ fact, updated_at }).eq("id", id)`
- delete: `.delete().eq("id", id)`
- clear all: `.delete().eq("status","active")` (RLS scopes to the user)
Show an empty state ("No memories yet — they'll appear here as you chat") and a count. Use the existing Dialog/Button/Input primitives.

- [ ] **Step 2: AccountMenu entry** — add a "Memory" item opening the panel (mirror the custom-instructions entry; sign-in-gated).

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add components/chat/memory-panel.tsx components/auth/account-menu.tsx
git commit -m "feat(memory): manage-memories panel (list/edit/delete/clear) + AccountMenu entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verification + PR

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new `merge`/`render` + any prompt-builder/persist tests).
- [ ] **Step 4:** `bun run build` → succeeds.
- [ ] **Step 5:** `bun run audit:bundle` → no server-only paths/secrets in client chunks (`lib/server/memory/*` is `server-only`).
- [ ] **Step 6: Manual smoke** (needs Supabase + a gateway model): sign in, enable memory; say "I run Postgres 16 on Hetzner and prefer terse answers"; confirm a fact appears in Settings → Memory; start a new chat → the model reflects it without re-explaining; edit + delete a fact; "Clear all" empties it; toggle off → extraction stops; sign in as another user → no cross-user facts (RLS).
- [ ] **Step 7: Open the PR into `dev`.** Body: summary (cross-conversation memory Slice 1 — summary/facts, embedding-free; toggle + manage panel; Arm A deferred), spec + plan links, automated-test list, manual-smoke results. Push `feat/memory-summary-slice-1`; commit trailer as above.

---

## Out of scope (later slices / deferred)

- **Embeddings / message-RAG recall (Arm A)** — deferred.
- Backfill of historical messages on enable; temporary-chat bypass; decay-on-source-delete; pause vs wipe; chat-driven "remember/forget"; "Memory updated" cue polish; multilingual.

## Risks

- **Authed Supabase client in the chat route + extract route** — must be the request-scoped **user** client (`getSupabaseServerClient`, as PR-2 used), never service-role; RLS bounds all reads/writes to the user.
- **Extractor cost/noise** — one cheap-model call per turn for opted-in users; `temperature: 0`, returns `[]` for most turns, async/best-effort so it never blocks chat. Confirm a real cheap model id for `MEMORY_EXTRACT_MODEL`.
- **Prompt-bloat** — injecting all active facts; the `MEMORY_FACT_CAP` (100) + short facts bound it. Revisit if it grows.
- **`generateStructured` option names + model availability** — confirm against `lib/server/ai/structured.ts` + the provider config.
- **Persist contract** — adding the `memoryEnabled` persisted key needs the `STORE_VERSION` bump + migration + `persist.test.ts` update.
