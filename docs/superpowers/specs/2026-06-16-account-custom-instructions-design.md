# Account-level custom instructions — Design

**Status:** Approved design (2026-06-16). New standalone feature —
distinct from the cross-conversation memory plan
(`PLAN-cross-conversation-memory.md`), though they share the
"personalization" surface conceptually.

**Goal:** A global, per-user **custom instructions** layer — the missing
fourth tier beneath the existing workspace / conversation / agent
system-prompt cascade — applied to every chat by default. Two fields
("about you" + "how to respond"), local-first with cloud sync,
always-on as the foundational base under every other tier.

## Why

Hummingbird already has three system-prompt tiers
(`docs/_done/PLAN-conversation-system-prompt.md`):

| Tier | Scope | Storage |
|---|---|---|
| Workspace `system_prompt` | one workspace | `workspaces.system_prompt` |
| Conversation `systemPrompt` | one chat | `0021_conversation_system_prompt.sql` |
| Agent/persona `systemPrompt` | invoked via `/slug` | `0020_agents.sql` |

What's missing is the **account level** — the ChatGPT "Custom
Instructions" / Claude personal-preferences layer: standing free text
the user writes once that applies to *every* chat in *every* workspace.
`docs/PLAN-cross-product-inspirations.md` flags this gap directly. This
spec adds that tier.

It is the *manual* sibling of the memory plan's **Arm B** (auto-extracted
facts). Both feed the same personalization need; this one is
user-authored and explicit. They are deliberately separate features.

## Decisions locked (brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Storage & availability | **Local-first + cloud sync.** Store singleton persisted to `localStorage` (works anonymous); synced to `profiles` columns when signed in. Matches how the workspace/conversation text tiers already behave. |
| D2 | Input shape | **Two fields** — `about` ("What should the model know about you?") + `style` ("How should the model respond?"). ChatGPT-style; maps onto the cascade's context/voice split. |
| D3 | Behavior under a persona | **Always apply.** Account instructions are the foundational base on every turn; a persona still replaces the *workspace* voice but does **not** erase account instructions. |

## Architecture

The feature is a thin new tier threaded through the existing
prompt-assembly path. No new runtime services.

### Data model

Two singleton string fields per user:

- `customInstructionsAbout` — identity/context ("What should the model
  know about you?")
- `customInstructionsStyle` — voice/format ("How should the model
  respond?")

**Local-first store.** A focused new slice
`lib/client/hooks/store/slices/account-instructions.ts` exporting an
`AccountInstructionsSlice` (the two fields + a `setAccountInstructions`
mutator), composed into the store like every other slice. Persisted to
`localStorage` via the persist allowlist.

> **Persist contract.** Adding persisted keys is a frozen-contract
> change: bump `STORE_VERSION` and add a `runMigrations` step (no-op
> upgrade — new keys default to `""`), and update the pinned key set in
> `store/persist.test.ts`. Per CLAUDE.md's persist rules.

**Cloud sync.** Migration `00ZZ_account_custom_instructions.sql` adds to
`profiles`:

```sql
alter table profiles
  add column custom_instructions_about text not null default '',
  add column custom_instructions_style text not null default '';
```

`profiles` is already own-row RLS, so no new policy is needed. Sync
posture mirrors existing synced settings: on sign-in, read the columns
and merge into the store (server value wins for a signed-in user on
first load); on save while signed in, write-through to `profiles`.
Anonymous users never touch Supabase — the fields live only in
`localStorage`.

**Caps.** 4,000 characters per field (concise but generous; the
per-entity prompts are 20k, but the account layer is meant to be short).
Enforced in the schema and the UI counter.

### Cascade integration — always-on base

Extend `composeSystemPrompts` in `lib/shared/agents/resolve.ts` to take
the two account fields and weave them in **general → specific**, so the
account layer always applies and survives persona switches:

```
voice   = [accountStyle, (agentSystemPrompt || workspaceSystemPrompt)]
context = [accountAbout, conversationSystemPrompt]
result  = [voice, context]   // each filtered for empties, joined "\n\n"
```

- `accountStyle` leads the **voice** section; the persona/workspace voice
  follows and can refine it (later = more specific).
- `accountAbout` leads the **context** section; the conversation context
  follows.
- The existing rules are unchanged: persona replaces the *workspace*
  voice; conversation context is additive. The account layer simply sits
  beneath both and is never dropped.
- All-empty account fields → output byte-identical to today (regression
  guard).

The signature gains two params (account fields first, as the base):

```ts
export function composeSystemPrompts(
  customInstructionsStyle: string | undefined,
  customInstructionsAbout: string | undefined,
  workspaceSystemPrompt: string | undefined,
  conversationSystemPrompt: string | undefined,
  agentSystemPrompt: string,
): string | undefined
```

### Wire path

- Add `customInstructionsAbout` + `customInstructionsStyle`
  (`z.string().max(4000).optional()`) to **both** `ChatRequestSchema`
  definitions in `lib/shared/api-schemas.ts` (the in-Next variant and
  the remote-backend variant — keep them in parity).
- The client includes both fields in the chat request body wherever it
  already attaches `workspaceSystemPrompt`.
- `buildSystemPrompt` (`lib/server/chat/prompt-builders.ts`) and the
  chat route read them from the request and pass them to
  `composeSystemPrompts`.

### UI

A **"Custom instructions"** dialog opened from `AccountMenu`, mirroring
`components/chat/thread-instructions-dialog.tsx`:

- Two labeled textareas: "What should the model know about you?" and
  "How should the model respond?" (ChatGPT copy).
- Save on explicit **Save** (not per-keystroke), char counters, 4,000
  cap each.
- Available **signed-in or anonymous** (local-first), unlike the
  sign-in-gated memory toggle.

## Components & boundaries

| Unit | Responsibility |
|---|---|
| `store/slices/account-instructions.ts` | Holds the two fields + mutator; persisted. |
| `store/migrate.ts` + `store/persist.ts` | Version bump + key allowlist for the new persisted keys. |
| `lib/shared/agents/resolve.ts` | `composeSystemPrompts` weaves the account base into voice/context. |
| `lib/shared/api-schemas.ts` | Two new optional capped fields on both `ChatRequestSchema`s. |
| `lib/server/chat/prompt-builders.ts` + chat route | Thread fields into `composeSystemPrompts`. |
| `components/.../custom-instructions-dialog.tsx` | The two-textarea editor (new). |
| `AccountMenu` | Entry point to open the dialog. |
| `00ZZ_account_custom_instructions.sql` + sync | `profiles` columns + load/merge/write-through. |

## Testing

- **Unit (`resolve.ts`):** account fields always apply under an active
  persona; general→specific ordering (account leads each section);
  empties trimmed; all-empty → identical to pre-feature output
  (regression). New `composeSystemPrompts` arg order is exercised.
- **Schema:** both `ChatRequestSchema` variants accept the two fields and
  reject over-cap (>4,000) input.
- **Persist:** the new keys appear in the pinned allowlist; the
  `STORE_VERSION` bump + migration step are covered by
  `store/persist.test.ts`.
- **Manual:** set both fields → a new chat reflects them; invoke a
  persona (`/slug`) → account instructions still apply; sign-in →
  fields round-trip to `profiles` and back; anonymous → fields persist
  in `localStorage` with no Supabase calls.

## Out of scope (v1)

- Per-conversation toggle to disable custom instructions for one chat.
- Temporary-chat bypass (will align with the memory plan's temporary
  chat when that lands — both should honor one "no personalization this
  turn" flag).
- "Generate from my chats" suggestions for the fields.
- Multiple named instruction profiles.
- Enterprise/admin org-level controls.

## Risks

- **Prompt-budget stacking.** Account + workspace + conversation +
  persona can now all contribute. The 4,000-cap per account field bounds
  it; the cascade already joins and trims. Watch total system-prompt
  size if a user maxes every tier (acceptable for v1; revisit if it
  bites).
- **Sync race / precedence.** Signed-in first-load merge must define a
  clear winner (server value wins on load) to avoid a stale-localStorage
  clobber. Specified above; pin it in the sync code.
- **`composeSystemPrompts` signature change** ripples to all callers —
  mechanical, caught by typecheck; the all-empty regression test guards
  behavior.
