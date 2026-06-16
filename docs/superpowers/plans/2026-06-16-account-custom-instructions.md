# Account-level custom instructions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global, per-user **custom instructions** layer (two fields: "about you" + "how to respond") beneath the existing workspace/conversation/agent system-prompt cascade — local-first with optional cloud sync, always-on as the foundational base.

**Architecture:** The system-prompt cascade is composed **client-side** by `composeSystemPrompts` (`lib/shared/agents/resolve.ts`) and the composed string is sent over the existing `workspaceSystemPrompt` wire field. **Therefore the account layer needs NO `ChatRequestSchema` or `buildSystemPrompt` change** (this corrects the spec's "Wire path" section, which predated confirming client-side composition). The work is: a persisted store slice for the two fields, two new base params on `composeSystemPrompts`, wiring its two call sites to read the slice, a settings dialog, and (last, separable) cloud sync via a new `profiles` column pair.

**Tech Stack:** TypeScript 5.x · Bun · Zustand (slices pattern) · React 19.2 · shadcn/ui (Dialog) · Supabase (sync only)

**Spec:** `docs/superpowers/specs/2026-06-16-account-custom-instructions-design.md`

**Loop:** Tasks 1–3 deliver the complete, working feature for all users (local-first). Task 4 (cloud sync) is separable and can land later. TDD for the pure cascade + persist contract; the UI gets a manual check.

---

## File Structure

**New files:**
- `lib/client/hooks/store/slices/account-instructions.ts` — the two fields + setter + selector hook (`AccountInstructionsSlice`).
- `components/chat/custom-instructions-dialog.tsx` — the two-textarea editor (mirrors `thread-instructions-dialog.tsx`).
- `supabase/migrations/0025_account_custom_instructions.sql` — `profiles` columns (Task 4 only).

**Modified files:**
- `lib/client/hooks/use-store.ts` — compose the new slice + extend `AppState`.
- `lib/client/hooks/store/persist.ts` — add the two keys to `partializeState`.
- `lib/client/hooks/store/persist.test.ts` — add the two keys to `EXPECTED_PERSISTED_KEYS`; bump pinned `STORE_VERSION`.
- `lib/client/hooks/store/migrate.ts` — bump `STORE_VERSION` 29 → 30 + no-op migration block.
- `lib/shared/agents/resolve.ts` — `composeSystemPrompts` gains two leading account params (base layer).
- `lib/shared/agents/resolve.test.ts` — migrate existing calls to the new signature + new account-behavior tests.
- `lib/client/hooks/use-chat-send.ts:222` — pass account fields into `composeSystemPrompts`.
- `components/panels/project-tasks-panel.tsx:230` — pass account fields into `composeSystemPrompts`.
- `components/auth/account-menu.tsx` — entry point to open the dialog.

**Untouched (explicit non-changes):**
- `lib/shared/api-schemas.ts` (`ChatRequestSchema`) and `lib/server/chat/prompt-builders.ts` (`buildSystemPrompt`) — composition is client-side; the composed string rides the existing `workspaceSystemPrompt` field.
- `lib/client/hooks/use-explain-stream.ts` — the selection-explainer doesn't compose the cascade; account instructions there are out of scope for v1.

---

## Task 1: Account-instructions store slice + persist contract

**Files:**
- Create: `lib/client/hooks/store/slices/account-instructions.ts`
- Modify: `lib/client/hooks/use-store.ts`
- Modify: `lib/client/hooks/store/persist.ts`
- Modify: `lib/client/hooks/store/migrate.ts`
- Modify: `lib/client/hooks/store/persist.test.ts`

- [ ] **Step 1.1: Write the slice**

Create `lib/client/hooks/store/slices/account-instructions.ts`:

```ts
import "client-only"

import { useShallow } from "zustand/react/shallow"

import { useStore } from "../../use-store"
import type { SliceCreator } from "../types"

/** Per-field cap for account-level custom instructions. The account
 *  layer is meant to be concise (cf. workspace/conversation prompts at
 *  20k); enforced again in the dialog UI + trimmed at compose time. */
export const ACCOUNT_INSTRUCTIONS_MAX = 4000

/**
 * Account-level custom instructions — the global, always-on base of the
 * system-prompt cascade. Two free-text fields the user authors once:
 *   - `customInstructionsAbout`: "What should the model know about you?"
 *   - `customInstructionsStyle`: "How should the model respond?"
 * Local-first (persisted to localStorage); synced to `profiles` when
 * signed in (see Task 4). Composed into every chat by
 * `composeSystemPrompts` beneath workspace/conversation/persona.
 */
export interface AccountInstructionsSlice {
  customInstructionsAbout: string
  customInstructionsStyle: string
  setAccountInstructions: (patch: {
    about?: string
    style?: string
  }) => void
}

export const createAccountInstructionsSlice: SliceCreator<
  AccountInstructionsSlice
> = (set) => ({
  customInstructionsAbout: "",
  customInstructionsStyle: "",
  setAccountInstructions: (patch) =>
    set((s) => ({
      customInstructionsAbout:
        patch.about !== undefined
          ? patch.about.slice(0, ACCOUNT_INSTRUCTIONS_MAX)
          : s.customInstructionsAbout,
      customInstructionsStyle:
        patch.style !== undefined
          ? patch.style.slice(0, ACCOUNT_INSTRUCTIONS_MAX)
          : s.customInstructionsStyle,
    })),
})

/** Selector hook — the two fields as a stable object. */
export const useAccountInstructions = () =>
  useStore(
    useShallow((s) => ({
      about: s.customInstructionsAbout,
      style: s.customInstructionsStyle,
    })),
  )
```

- [ ] **Step 1.2: Compose the slice into the store**

In `lib/client/hooks/use-store.ts`:

Add the import (next to the other slice imports, e.g. after the `chat` slice import on line 9):

```ts
import {
  createAccountInstructionsSlice,
  type AccountInstructionsSlice,
} from "./store/slices/account-instructions"
```

Add `AccountInstructionsSlice` to the `AppState` interface's `extends` list (the list starting at line 151, e.g. after `ChatSlice`):

```ts
    AccountInstructionsSlice,
```

Add the spread into the `create<AppState>()` body (next to the other `...create*Slice(set, get, api)` lines, e.g. after `...createChatSlice(set, get, api),` on line 173):

```ts
      ...createAccountInstructionsSlice(set, get, api),
```

- [ ] **Step 1.3: Persist the two fields**

In `lib/client/hooks/store/persist.ts`, add to the object returned by `partializeState` (the block starting line 21), after `chatReasoningEffort`:

```ts
  customInstructionsAbout: state.customInstructionsAbout,
  customInstructionsStyle: state.customInstructionsStyle,
```

- [ ] **Step 1.4: Bump the store version + no-op migration**

In `lib/client/hooks/store/migrate.ts`:

Change `export const STORE_VERSION = 29` to `export const STORE_VERSION = 30`.

Add a migration block at the END of `runMigrations` (just before the final `return persistedState` / `return state`):

```ts
  if (fromVersion < 30) {
    // Account-level custom instructions added. New persisted keys
    // (customInstructionsAbout / customInstructionsStyle) default to ""
    // via the slice's initial state when absent from older blobs — no
    // backfill needed; this block exists to honor the
    // version-bump-per-persist-change contract.
  }
```

- [ ] **Step 1.5: Update the frozen persist test**

In `lib/client/hooks/store/persist.test.ts`:

Add the two keys to the `EXPECTED_PERSISTED_KEYS` array (the list ending around line 56), after `"chatReasoningEffort"`:

```ts
  "customInstructionsAbout",
  "customInstructionsStyle",
```

Change the pinned version assertion `expect(STORE_VERSION).toBe(29)` to `expect(STORE_VERSION).toBe(30)`.

- [ ] **Step 1.6: Run the persist + store tests**

Run: `bun test lib/client/hooks/store/persist.test.ts`
Expected: PASS — the persisted key set now includes the two new keys and `STORE_VERSION` is 30.

- [ ] **Step 1.7: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 1.8: Commit**

```bash
git add lib/client/hooks/store/slices/account-instructions.ts lib/client/hooks/use-store.ts lib/client/hooks/store/persist.ts lib/client/hooks/store/migrate.ts lib/client/hooks/store/persist.test.ts
git commit -m "feat(store): account custom-instructions slice (local-first)

Two persisted singleton fields (customInstructionsAbout /
customInstructionsStyle, 4000-char cap each) + setter + selector hook.
Wires into the store composition + persist allowlist; STORE_VERSION
29 -> 30 with a no-op migration per the frozen-persist contract.

Spec: docs/superpowers/specs/2026-06-16-account-custom-instructions-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Weave account instructions into `composeSystemPrompts` + call sites

**Files:**
- Modify: `lib/shared/agents/resolve.ts`
- Modify: `lib/shared/agents/resolve.test.ts`
- Modify: `lib/client/hooks/use-chat-send.ts`
- Modify: `components/panels/project-tasks-panel.tsx`

- [ ] **Step 2.1: Write the failing tests**

In `lib/shared/agents/resolve.test.ts`:

First, **migrate every existing `composeSystemPrompts(...)` call to the new 5-arg signature** by prepending `undefined, undefined,` (the two account fields) to each call. For example:
- `composeSystemPrompts(undefined, undefined, "")` → `composeSystemPrompts(undefined, undefined, undefined, undefined, "")`
- `composeSystemPrompts("Be concise.", undefined, "")` → `composeSystemPrompts(undefined, undefined, "Be concise.", undefined, "")`
- `composeSystemPrompts("Be concise.", "", "You are a critic.")` → `composeSystemPrompts(undefined, undefined, "Be concise.", "", "You are a critic.")`

(Apply this prepend to all ~12 existing calls; their expected outputs are unchanged because the two account args are empty.)

Then append a new describe block:

```ts
describe("composeSystemPrompts — account base layer", () => {
  test("account style leads the voice; account about leads the context", () => {
    expect(
      composeSystemPrompts(
        "Be terse.",            // account style
        "I'm a Postgres DBA.",  // account about
        "You are the Acme bot.",// workspace
        "We're debugging a deadlock.", // conversation
        "",                     // no persona
      ),
    ).toBe(
      "Be terse.\n\nYou are the Acme bot.\n\nI'm a Postgres DBA.\n\nWe're debugging a deadlock.",
    )
  })

  test("account instructions survive an active persona (always-on base)", () => {
    const out = composeSystemPrompts(
      "Be terse.",
      "I'm a Postgres DBA.",
      "You are the Acme bot.", // workspace — replaced by persona
      "",
      "You are a code critic.", // persona
    )
    expect(out).toContain("Be terse.")        // account style kept
    expect(out).toContain("I'm a Postgres DBA.") // account about kept
    expect(out).toContain("You are a code critic.") // persona voice
    expect(out).not.toContain("You are the Acme bot.") // workspace dropped
  })

  test("only account fields set → both render (style then about)", () => {
    expect(
      composeSystemPrompts("Be terse.", "I'm a DBA.", undefined, undefined, ""),
    ).toBe("Be terse.\n\nI'm a DBA.")
  })

  test("empty/whitespace account fields are trimmed out (regression)", () => {
    expect(
      composeSystemPrompts("  ", "  ", "Be concise.", undefined, ""),
    ).toBe("Be concise.")
  })

  test("all five empty → undefined", () => {
    expect(
      composeSystemPrompts(undefined, undefined, undefined, undefined, ""),
    ).toBeUndefined()
  })
})
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test lib/shared/agents/resolve.test.ts`
Expected: FAIL — `composeSystemPrompts` still has the 3-arg signature, so the migrated calls pass the wrong args and the new block's expectations don't match.

- [ ] **Step 2.3: Update `composeSystemPrompts`**

In `lib/shared/agents/resolve.ts`, replace the function (currently lines 81–96) with:

```ts
export function composeSystemPrompts(
  customInstructionsStyle: string | undefined,
  customInstructionsAbout: string | undefined,
  workspaceSystemPrompt: string | undefined,
  conversationSystemPrompt: string | undefined,
  agentSystemPrompt: string,
): string | undefined {
  const cs = customInstructionsStyle?.trim() ?? ""
  const ca = customInstructionsAbout?.trim() ?? ""
  const w = workspaceSystemPrompt?.trim() ?? ""
  const c = conversationSystemPrompt?.trim() ?? ""
  const a = agentSystemPrompt.trim()
  // Account instructions are the always-on base. Voice = how-to-respond
  // (account style first, then persona-or-workspace which can refine it).
  // Context = who/what (account about first, then conversation context).
  // Persona still replaces the *workspace* voice; the account base and
  // conversation context are never dropped.
  const voice = [cs, a || w].filter(Boolean).join("\n\n")
  const context = [ca, c].filter(Boolean).join("\n\n")
  const pieces = [voice, context].filter(Boolean)
  if (pieces.length === 0) return undefined
  return pieces.join("\n\n")
}
```

Update the function's JSDoc above it to mention the account base layer and the four-tier order (account → workspace/persona → conversation).

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `bun test lib/shared/agents/resolve.test.ts`
Expected: PASS (migrated existing calls + the new account block).

- [ ] **Step 2.5: Wire the chat-send call site**

In `lib/client/hooks/use-chat-send.ts`, the `composeSystemPrompts` call is at ~line 222. Read the two account fields from the store the same way other store values are read in this hook (e.g. add `customInstructionsAbout` and `customInstructionsStyle` to the existing `useStore` destructuring / selector this hook already uses for `conversations`, `workspaces`, etc.), then pass them as the two leading args:

```ts
      const workspaceSystemPrompt = withUserSkillInstructions(
        composeSystemPrompts(
          customInstructionsStyle,
          customInstructionsAbout,
          activeWorkspace?.systemPrompt,
          conv?.systemPrompt,
          options?.agentSystemPrompt ?? ""
        ),
        userSkills,
        activeWorkspaceId
      )
```

(If this hook reads store state via `useStore.getState()` rather than a selector, read `getState().customInstructionsAbout/Style` at send time instead — match the file's existing access pattern.)

- [ ] **Step 2.6: Wire the project-tasks call site**

In `components/panels/project-tasks-panel.tsx`, the `composeSystemPrompts` call is at ~line 230 ("Run as task"). Read the two account fields from the store (match how this component reads other store values), and pass them as the leading args:

```ts
      workspaceSystemPrompt: composeSystemPrompts(
        customInstructionsStyle,
        customInstructionsAbout,
        workspace.systemPrompt,
        undefined,
        resolved.systemPrompt
      ),
```

- [ ] **Step 2.7: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: typecheck clean (both callers now match the 5-arg signature); lint 0 errors (pre-existing warnings in `app/api/summarize/route.ts` + `services/agent-ts/*` are unrelated).

- [ ] **Step 2.8: Commit**

```bash
git add lib/shared/agents/resolve.ts lib/shared/agents/resolve.test.ts lib/client/hooks/use-chat-send.ts components/panels/project-tasks-panel.tsx
git commit -m "feat(chat): apply account custom instructions as cascade base

composeSystemPrompts gains two leading params (account style + about).
Style leads the voice section (ahead of persona/workspace); about leads
the context section (ahead of the conversation prompt). The account base
always applies and survives persona activation. Both client call sites
(chat send + run-as-task) pass the store fields; the composed string
still rides the existing workspaceSystemPrompt wire field, so no schema
or server change is needed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Custom-instructions dialog + AccountMenu entry

**Files:**
- Create: `components/chat/custom-instructions-dialog.tsx`
- Modify: `components/auth/account-menu.tsx`

- [ ] **Step 3.1: Read the dialog template**

Read `components/chat/thread-instructions-dialog.tsx` in full — the new dialog mirrors it (controlled `open`/`onClose`, a local `draft` seeded from the store in a `useEffect`, save-on-explicit-Save calling a store setter then `onClose`, char counter, `Dialog`/`DialogContent`/`DialogFooter` shadcn parts).

- [ ] **Step 3.2: Write the dialog**

Create `components/chat/custom-instructions-dialog.tsx`:

```tsx
"use client"
import "client-only"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useStore } from "@/client/hooks/use-store"
import {
  ACCOUNT_INSTRUCTIONS_MAX,
  useAccountInstructions,
} from "@/client/hooks/store/slices/account-instructions"

/**
 * Account-level custom instructions editor. Two free-text fields applied
 * to every chat as the base of the system-prompt cascade. Local-first;
 * syncs to the user's profile when signed in. Opened from AccountMenu.
 */
export function CustomInstructionsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const setAccountInstructions = useStore((s) => s.setAccountInstructions)
  const { about, style } = useAccountInstructions()
  const [aboutDraft, setAboutDraft] = useState("")
  const [styleDraft, setStyleDraft] = useState("")

  useEffect(() => {
    if (open) {
      setAboutDraft(about)
      setStyleDraft(style)
    }
  }, [open, about, style])

  const save = () => {
    setAccountInstructions({ about: aboutDraft, style: styleDraft })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Custom instructions</DialogTitle>
          <DialogDescription>
            Applied to every chat, across all workspaces — beneath any
            workspace voice, thread instructions, or active persona.
          </DialogDescription>
        </DialogHeader>

        <label className="text-sm font-medium" htmlFor="ci-about">
          What should the model know about you?
        </label>
        <textarea
          id="ci-about"
          value={aboutDraft}
          onChange={(e) => setAboutDraft(e.target.value.slice(0, ACCOUNT_INSTRUCTIONS_MAX))}
          maxLength={ACCOUNT_INSTRUCTIONS_MAX}
          rows={5}
          className="w-full resize-y rounded border border-[var(--border)] bg-[var(--background)] p-2 text-sm outline-none focus:ring-1 focus:ring-[var(--ring)]"
          placeholder="e.g. I'm a backend engineer; I run Postgres 16 on Hetzner; I prefer TypeScript."
        />
        <div className="text-right text-xs text-[var(--muted-foreground)]">
          {aboutDraft.length}/{ACCOUNT_INSTRUCTIONS_MAX}
        </div>

        <label className="text-sm font-medium" htmlFor="ci-style">
          How should the model respond?
        </label>
        <textarea
          id="ci-style"
          value={styleDraft}
          onChange={(e) => setStyleDraft(e.target.value.slice(0, ACCOUNT_INSTRUCTIONS_MAX))}
          maxLength={ACCOUNT_INSTRUCTIONS_MAX}
          rows={5}
          className="w-full resize-y rounded border border-[var(--border)] bg-[var(--background)] p-2 text-sm outline-none focus:ring-1 focus:ring-[var(--ring)]"
          placeholder="e.g. Be terse and direct. No preamble. Show code first, explanation after."
        />
        <div className="text-right text-xs text-[var(--muted-foreground)]">
          {styleDraft.length}/{ACCOUNT_INSTRUCTIONS_MAX}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

> Match the exact shadcn import paths + className idioms actually used in `thread-instructions-dialog.tsx` (e.g. whether it uses a shared `Textarea` component or a raw `<textarea>`); adapt if the project has a `Textarea` UI primitive.

- [ ] **Step 3.3: Add the AccountMenu entry**

In `components/auth/account-menu.tsx`, add a menu item that opens the dialog. Add local state `const [ciOpen, setCiOpen] = useState(false)`, a clickable row labeled **"Custom instructions"** (matching the menu's existing item markup) that calls `setCiOpen(true)`, and render `<CustomInstructionsDialog open={ciOpen} onClose={() => setCiOpen(false)} />`. The item is shown unconditionally (local-first — no sign-in gate), unlike sign-in-gated rows.

- [ ] **Step 3.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean / 0 errors.

- [ ] **Step 3.5: Manual check**

Run `bun dev`; open AccountMenu → Custom instructions; set both fields → Save; start a new chat and confirm the model reflects them (and still does after invoking a persona via `/slug`). Reload → fields persist (localStorage).

- [ ] **Step 3.6: Commit**

```bash
git add components/chat/custom-instructions-dialog.tsx components/auth/account-menu.tsx
git commit -m "feat(ui): custom instructions dialog + AccountMenu entry

Two-textarea editor (about-you / how-to-respond, 4000 cap, char
counters) opened from the account menu; available signed-in or
anonymous (local-first). Saves to the account-instructions slice.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Cloud sync via `profiles` (separable — can land later)

**Files:**
- Create: `supabase/migrations/0025_account_custom_instructions.sql`
- Modify: the auth/sync bootstrap (`lib/client/hooks/use-auth.ts` and/or `lib/client/hooks/use-sync.ts` — whichever owns post-sign-in profile load)

> **Note:** `profiles` carries no synced settings today (only `id` + `email`), and the entity-row sync layer (`lib/client/sync/handlers.*`) syncs arrays of rows, not singletons. So this is a small, purpose-built profile read/write, not a new sync handler. Tasks 1–3 already ship a complete local-first feature; this task adds cross-device persistence for signed-in users.

- [ ] **Step 4.1: Migration**

Create `supabase/migrations/0025_account_custom_instructions.sql`:

```sql
alter table profiles
  add column if not exists custom_instructions_about text not null default '',
  add column if not exists custom_instructions_style text not null default '';
```

(`profiles` is already own-row RLS; no new policy needed.)

- [ ] **Step 4.2: Load on sign-in (server wins on first load)**

In the post-sign-in profile bootstrap (find where the signed-in user's profile row is first read — `use-auth.ts`/`use-sync.ts`), after fetching the profile, merge the columns into the store:

```ts
const { data } = await supabase
  .from("profiles")
  .select("custom_instructions_about, custom_instructions_style")
  .eq("id", userId)
  .single()
if (data) {
  useStore.getState().setAccountInstructions({
    about: data.custom_instructions_about ?? "",
    style: data.custom_instructions_style ?? "",
  })
}
```

Rationale: on a signed-in device the cloud value is authoritative on load, preventing a stale-localStorage clobber.

- [ ] **Step 4.3: Write-through on save**

Make `setAccountInstructions` (or a thin wrapper called by the dialog's `save`) upsert to `profiles` when a session exists. Simplest: in the dialog's `save`, after the store set, fire a best-effort write when signed in:

```ts
const session = /* existing session accessor */
if (session?.user?.id) {
  void supabase.from("profiles").update({
    custom_instructions_about: aboutDraft,
    custom_instructions_style: styleDraft,
  }).eq("id", session.user.id)
}
```

Best-effort (no await/block); anonymous users skip it entirely. Match the project's existing supabase-client access pattern.

- [ ] **Step 4.4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean / 0 errors.

- [ ] **Step 4.5: Manual round-trip check**

Signed in: set fields → Save → reload (or another device) → fields load from `profiles`. Signed out: set fields → confirm no Supabase write and fields persist via localStorage only.

- [ ] **Step 4.6: Commit**

```bash
git add supabase/migrations/0025_account_custom_instructions.sql lib/client/hooks/use-auth.ts lib/client/hooks/use-sync.ts
git commit -m "feat(sync): cloud-sync account custom instructions via profiles

Adds profiles.custom_instructions_{about,style} (own-row RLS). Loads
them into the store on sign-in (server wins on first load) and
write-through best-effort on save. Anonymous users stay local-only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: End-to-end verification + PR

**Files:** none modified — verification only.

- [ ] **Step 5.1: Full local gate**

Run:
```bash
bun run typecheck
bun run lint
bun run test
```
Expected: typecheck clean; lint 0 errors (pre-existing warnings OK); all tests pass incl. the new `resolve` account block + the updated `persist` test.

- [ ] **Step 5.2: Build + bundle audit**

Run:
```bash
bun run build
bun run audit:bundle
```
Expected: build succeeds; audit reports no server-only paths/secrets in client chunks (this feature is client + isomorphic, plus one SQL migration).

- [ ] **Step 5.3: Open the PR into `dev`**

Push the branch and open a PR into `dev`. Body: summary (account-level custom instructions, two fields, local-first + cloud sync, always-on cascade base), spec + plan links, the manual test plan from Steps 3.5 + 4.5, and the note that no `ChatRequestSchema`/`buildSystemPrompt` change was needed (client-side composition). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Out of scope (v1)

- Per-conversation toggle to disable custom instructions for one chat.
- Temporary-chat bypass — defer to align with the memory plan's temporary chat (both honor one "no personalization this turn" flag).
- Account instructions in the selection-explainer (`use-explain-stream.ts`) — it doesn't compose the cascade.
- "Generate from my chats" field suggestions; multiple named profiles; enterprise/admin controls.

## Risks

- **Signature ripple.** `composeSystemPrompts` gains two params; both callers + ~12 test calls update mechanically (typecheck + the all-empty regression test guard it).
- **Sync precedence.** Server-wins-on-load (Step 4.2) prevents a stale-localStorage clobber; keep the load before any local save can fire.
- **Prompt-budget stacking.** Account + workspace + conversation + persona can all contribute now; the 4,000-cap per field bounds it. Revisit only if it bites.
