# Plan: Prompt library

Status: **✅ All 3 phases shipped**.
Phase 1 ([#50](https://github.com/juchengquan/hummingbird/pull/50))
— sidebar group, dialogs, click-to-insert.
Phase 2 ([#53](https://github.com/juchengquan/hummingbird/pull/53))
— Supabase `prompts` table (migration `0011`), `diffPrompts` sync
handler, reconcile in/out, RLS. Prompts roam across devices for
signed-in users.
Phase 3 (this PR) — the **`@<slug>`** trigger in the chat input.
`@` for prompts, `/` for skills (two symbols, no shared namespace).
Pure `lib/shared/prompts/mention-parser.ts` + a second instance of
the symbol-agnostic `SlashAutocomplete` component over the `prompts`
slice; picking a prompt expands its template into the input (variable
fill modal first when it has `{{markers}}`). See the "two-symbol
model" section in `_done/PLAN-slash-commands.md`.

User-scoped saved prompt templates with placeholder variables, listed
in the left sidebar (alongside Workspaces / Chats / Documents) and
expanded inline before being sent as the next chat turn. Click a
prompt in the sidebar to insert it into the current chat input;
prompts with `{{variable}}` markers prompt for fills via a small
modal first.

The original plan placed prompt management in the chat-header kebab
menu. **The implementation moves it to a fourth sidebar group** —
prompts are user-scoped/global, not per-conversation actions, so they
fit the existing left-sidebar taxonomy (persistent collections the
user browses) more naturally than a per-chat kebab. Same `<SidebarGroup>`
shape, same search affordance, same hover-revealed row actions as the
Documents section.

## Phasing

This document describes the full feature. The implementation ships in
phases:

- **Phase 1 (this PR — `claude/prompt-library`):** local-only.
  Zustand slice + sidebar group + create/edit/delete dialog +
  variable fill modal + click-to-insert into the chat input. Works
  in anonymous and signed-in modes; signed-in users just don't get
  cross-device sync yet.
- **Phase 2 (future):** Supabase sync. New migration, `diffPrompts`
  in the sync handler chain, bidirectional mapping in
  `reconcile.ts`. Mirrors how file full-text storage layered onto
  Phase 1's extract caps.
- **Phase 3 (future, builds on the `_done/PLAN-slash-commands.md`
  autocomplete component):** the **`@<slug>`** trigger in the chat
  input — `@` for prompts, distinct from `/` for skills. Reuses the
  symbol-agnostic autocomplete component built for `/`; mounts a
  second instance for `@` over the `prompts` slice. Picking a prompt
  expands its template into the input immediately (then the
  `{{variable}}` fill modal if needed). Until that lands, prompts
  are accessed via the sidebar only.

Builds on the planned slash-command surface
(`docs/_done/PLAN-slash-commands.md`) for Phase 3 — both features write
into the same autocomplete dropdown and share a slash-trigger
registry.

## Why

Power users send the same shapes of prompts repeatedly — "rewrite
this in the voice of {persona}", "summarize {url} for a {audience}",
"draft a release note for {feature}". Today they retype them or
keep a notes file open in another tab. A prompt library makes those
reusable, parameterised, and one-keystroke-away. It's also the
natural seed for **team-shared** prompts later (out of scope for v1
but the data model should not block it).

## Goal & scope cuts

**v1 ships:**

- **User-scoped prompts** (not workspace-scoped). A prompt the user
  saves is available in every workspace. This matches the reusable
  intent and keeps the schema simpler.
- **Template + named variables.** `Hello {{name}}, …` style. The
  variables are inferred from `{{...}}` markers; no separate
  "declare variables" step.
- **`/<name>` slash command** in the chat input. Autocomplete
  shares the same dropdown as the skill slashes (per
  `_done/PLAN-slash-commands.md`). Skill triggers reserved — prompt
  triggers can't collide.
- **Variable fill-in inline modal.** When the user selects a
  template with variables, a small modal anchored near the input
  prompts for each variable in order. Tab moves to next; Enter
  submits when the last is filled and sends the expanded message.
- **Manage Prompts dialog.** Opened from the chat header's existing
  kebab menu (`components/panels/chat-header.tsx`, the kebab popover
  already has 7 entries). The dialog lists prompts, lets the user
  create / edit / delete, with a live preview of how the expanded
  prompt will read.
- **Local-first + Supabase sync.** Same pattern as workspaces /
  conversations / MCP servers: store in Zustand with persistence,
  diff-and-push to Supabase via the existing sync handler chain.
  Works offline.

**Cut from v1 to keep it shippable:**

- **Team-shared prompts.** Schema is designed not to block this
  (no `workspace_id` FK forces team-scoping later), but the UI is
  user-only in v1.
- **Variable types beyond plain text.** No "this variable is a URL"
  / "this variable is multi-line" / "this variable is one of these
  options" affordance. Plain text inputs only.
- **Prompts that auto-attach a skill or file.** E.g. "this template
  always runs with web search on" — interesting, but blurs the
  slash command's "force skill" semantics with the prompt
  library's "expand template" semantics. Defer.
- **Public / shareable prompt URLs.** No `/p/<id>` share routes.
- **Built-in prompt directory or marketplace.** Some apps ship
  curated starter prompts. Defer; v1 is BYO.
- **Versioning / history.** Edits overwrite. No "undo last edit"
  in the manage dialog.
- **Search across templates by content.** Trivial filter on the
  list by name only in v1; full-text search if the library grows
  big.

## Surface architecture

### Data model

**Zustand slice** (`lib/client/hooks/use-store.ts`):

```ts
interface Prompt {
  id: string                // nanoid
  name: string              // user-facing; doubles as slash trigger after slug
  slug: string              // /<slug> in autocomplete; auto-derived from name, editable
  template: string          // plain text with {{var}} markers
  variables: string[]       // derived from template, stored for query convenience
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date          // soft-delete for sync (matches other entities)
}
```

`AppState` gains `prompts: Prompt[]` and the standard actions
(`createPrompt`, `updatePrompt`, `deletePrompt`, `restorePrompt`).
Persisted via `partialize` like other slices.

**Supabase table** (Phase 2 — `supabase/migrations/0011_prompts.sql`,
not built in this PR):

```sql
create table prompts (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  template text not null,
  variables text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index prompts_user_slug_unique
  on prompts (user_id, slug)
  where deleted_at is null;

-- RLS: own-your-rows pattern, matches every other table
alter table prompts enable row level security;
create policy "prompts: select own" on prompts for select using (auth.uid() = user_id);
create policy "prompts: insert own" on prompts for insert with check (auth.uid() = user_id);
create policy "prompts: update own" on prompts for update using (auth.uid() = user_id);
create policy "prompts: delete own" on prompts for delete using (auth.uid() = user_id);
```

No `workspace_id` — prompts are user-scoped. This is the **MCP
server credential pattern** flipped: MCP servers are workspace-
scoped but credentials are user-local; here both the row and the
intent are user-level.

### Sync handler

New `diffPrompts` in `lib/client/sync/handlers.ts`, mirroring
`diffWorkspaces` and friends:

- Pure function: `(prev: Prompt[], next: Prompt[]) => SyncOp[]`
- Upsert on `updatedAt` mismatch, delete on `deletedAt` set
- Subscribed alongside the others in `lib/client/hooks/use-sync.ts`

No new infrastructure — the diff/push/pull pattern already exists.

### Trigger symbol — `@`, separate from skills' `/`

**Decision (supersedes the earlier "shared resolver / skills win"
idea):** prompts are triggered with **`@`**, skills with **`/`**.
Two symbols, two physically-separate namespaces, **no shared
resolver and no collision rule needed** — a user can name a prompt
`search` freely because `@search` and `/search` are different
surfaces. See the "two-symbol model" table in
`_done/PLAN-slash-commands.md` for the full rationale.

Phase 3 reuses the **symbol-agnostic autocomplete component**
(`components/panels/slash-autocomplete.tsx`) the slash-commands work
introduces. It's parameterised over `{ triggerChar, entries,
onPick }`, so Phase 3 mounts a second instance:

- `triggerChar = "@"`
- `entries` = the `prompts` slice mapped to `{ id, label: name,
  hint: slug, ... }`, filtered by the typed token after `@`.
- `onPick` = expand the chosen template into the input at the `@slug`
  position (replacing the token), then open the variable-fill modal
  if the template has `{{variables}}`.

Unlike skill picks (which leave a `/trigger ` directive that resolves
at send), a prompt pick **resolves immediately** — by send time the
`@slug` is gone and it's plain text. That's why multiple `@`
expansions per message work and `@` is allowed mid-message.

### Variable expansion

**`lib/shared/prompts/expand.ts`** (new, pure):

```ts
export interface ParsedTemplate {
  template: string
  variables: string[]   // ordered, deduplicated
  segments: Array<      // for rendering / inline highlights
    | { kind: 'text'; value: string }
    | { kind: 'var';  name: string }
  >
}

export function parseTemplate(template: string): ParsedTemplate
export function expandTemplate(
  template: string,
  values: Record<string, string>
): string
```

`{{var}}` markers only. No nested templates, no expressions.
Whitespace inside the braces is tolerated (`{{ name }}` works).
Unfilled variables in `expandTemplate` are left as the literal
`{{var}}` text — the chat panel can warn before sending, but won't
block (sometimes that's intentional).

### UI components

**`components/sidebars/application.tsx`** — extend with a fourth
group **Prompts**, sitting after Documents. Same shape as the
existing Chats / Documents sections:

- Collapsed-icon mode: one row per prompt (BookOpen icon)
- Expanded mode: `SidebarGroupLabel` with collapsible chevron, "+"
  action to open the new-prompt dialog, search input, list of
  prompts with hover-revealed edit / delete actions
- Each row's click: insert the prompt into the current chat input
  (via the new `pendingChatInput` Zustand action — see Chat panel
  wire-up). Prompts with variables fire the fill modal first.

**`components/panels/prompt-dialog.tsx`** *(new)*. Combined
create-and-edit dialog, opened from the sidebar's "+" action or
from a row's Edit action. Form fields:
- Name (auto-derives slug on first input; slug becomes editable
  after first save)
- Template textarea (auto-resizing, monospace, with variable
  markers highlighted)
- Variable list (derived, read-only) for clarity

Save / Delete / Duplicate buttons. Standard `Dialog` from
`components/ui/dialog.tsx`.

The original plan called this a "Manage Prompts" dialog with a
list-on-the-left/edit-on-the-right two-pane shape. The sidebar
already provides the list view, so the dialog reduces to single-
prompt edit mode — simpler, less screen real estate, easier to keep
focused.

**`components/panels/prompt-variable-fill.tsx`** *(new)*. Small
modal anchored near the chat input. One text field per variable
in order, with auto-focus on first. Submit (Enter on last field
or click Insert) expands the template and sets the chat input to
the expanded text — the user can still edit before sending if they
want. Esc cancels and clears the pending insert.

**`components/panels/slash-autocomplete.tsx`** *(Phase 3 only)* is
shared with the slash-commands plan. Not part of Phase 1 — the
sidebar carries the surface until slash lands.

### Sidebar wire-up

The fourth `<SidebarGroup>` in `application.tsx` carries:

- `BookOpen size={14}` icon in the label
- "+" action button opens `<PromptDialog mode="create" />`
- Each row is a new `<PromptItem>` component (mirrors `<DocumentItem>`)
- Active state when the dialog is open editing that prompt

No chat-header changes. The kebab menu stays as today's seven
per-conversation actions.

### Chat panel wire-up

Clicking a prompt in the sidebar needs to push text into the chat
input, which lives in `ChatPanel`'s local `useState`. The cleanest
seam is a Zustand-mediated event:

- New `pendingChatInput: string | null` field on the store
- `setPendingChatInput(value: string | null)` action
- `ChatPanel`'s `useEffect` subscribes; when non-null, it sets
  `inputValue`, focuses the textarea, and clears `pendingChatInput`
  (one-shot, not a permanent draft state)

Sidebar click flow:
1. User clicks a prompt row → resolve `parseTemplate(prompt.template)`
2. If `variables.length === 0`: `setPendingChatInput(prompt.template)` directly
3. Else: open `<PromptVariableFill>` modal; on submit, call
   `expandTemplate(prompt.template, fills)` and
   `setPendingChatInput(expanded)`

The send path itself is unchanged — once text is in the textarea,
the existing flow takes over.

## Edge cases

- **Slug collision between two of the user's own prompts.** The
  unique index in Postgres rejects the second one server-side; the
  client surfaces the error in the Manage Prompts dialog with a
  "slug already in use" message and refuses to save.
- **Template with no variables.** The variable-fill modal is
  skipped; selecting the slash entry directly expands the
  template into the input.
- **Empty template.** Allowed (some users might want a tag-style
  marker prompt). Won't pre-fill anything.
- **Variable referenced multiple times.** E.g. `Hello {{name}},
  {{name}}, …`. Fill once, expand everywhere. The variable list is
  deduplicated.
- **Variable named `name` (or another reserved-ish word).** No
  reserved words in v1 — variable names are free-form within `{{...}}`.
- **User signs out.** Local prompts persist in localStorage. Sync
  resumes on next sign-in. Mirrors how conversations / workspaces
  behave.
- **Two devices edit the same prompt concurrently.** Last-write-
  wins on `updated_at`. Same conflict policy as workspaces /
  conversations. Documented; not solving CRDT problems for v1.

## Feasibility assessment

**Verdict: clearly feasible. Highest-confidence of the three plans
that came out of the BACKLOG.**

The infrastructure for "new user-scoped persisted entity" is
well-trodden in this codebase: the URL-bookmarks feature (migration
`0006`) is essentially the template, and the diff-sync pattern
(`lib/client/sync/handlers.ts`) absorbs new entities cheaply. The
chat-header kebab has obvious room for a new entry. The variable
expansion is pure-function territory.

The only non-trivial design coupling is with `_done/PLAN-slash-commands.md`
— both features write into the same autocomplete dropdown. Resolved
above (single shared resolver, skill-triggers reserved). If
slash-commands lands first, this plan extends the autocomplete; if
this lands first, it's the autocomplete and slash-commands extends
later. Order doesn't matter, but **the shared resolver is the seam
that has to be designed correctly the first time** — if either
feature ships without it and bakes in assumptions, the second one
gets messy.

## Files touched

### Phase 1 (this PR)

| File | Why |
|---|---|
| `lib/shared/prompts/expand.ts` *(new)* | `parseTemplate`, `expandTemplate` |
| `lib/shared/prompts/expand.test.ts` *(new)* | Pure-fn tests |
| `lib/shared/types.ts` | `Prompt` interface |
| `lib/client/hooks/use-store.ts` | `prompts` slice + actions, `pendingChatInput` + `setPendingChatInput` |
| `components/panels/prompt-dialog.tsx` *(new)* | Create/edit/delete UI |
| `components/panels/prompt-variable-fill.tsx` *(new)* | Variable fill-in modal |
| `components/sidebars/application.tsx` | Fourth `<SidebarGroup>` for Prompts |
| `components/panels/chat.tsx` | Subscribe to `pendingChatInput` |

### Phase 2 (sync — future PR)

| File | Why |
|---|---|
| `supabase/migrations/0011_prompts.sql` *(new)* | Table + RLS |
| `lib/shared/supabase/types.ts` | Regenerated for the new table |
| `lib/client/sync/handlers.ts` | `diffPrompts` |
| `lib/client/sync/reconcile.ts` | Bidirectional mapping |
| `lib/client/hooks/use-sync.ts` | Subscribe `diffPrompts` |

### Phase 3 (slash — future PR, depends on _done/PLAN-slash-commands)

| File | Why |
|---|---|
| `lib/client/slash-resolver.ts` *(new, shared with slash-commands)* | Unified slash dispatch |
| `components/panels/slash-autocomplete.tsx` | Extend to render prompt rows |
| `components/panels/chat.tsx` | Slash-detection in input |

**Phase 1 size:** ~500 lines of new code + ~120 of tests. Same
"new user-scoped entity in Zustand + new sidebar group + edit
dialog + a pure helper lib" shape as `0006_url_bookmarks`'s Phase
1 (which also shipped without sync before sync layered on later).

## Test plan

- **`expand.test.ts`** *(new, ~20 cases):*
  - `parseTemplate`: extracts vars in order, deduplicates,
    handles `{{ name }}` whitespace, `{{}}` ignored, escaped `\{\{`
    (or just: no escaping in v1)
  - `expandTemplate`: full fill, partial fill (leaves `{{var}}`),
    var used twice, empty template, no variables
- **`use-store` tests** *(extend existing slice tests):*
  - Create, update, delete prompt
  - Soft-delete sets `deletedAt`
  - Slug auto-derivation from name (kebab-case)
- **Migration test** in CI: `supabase db reset` succeeds with
  `0007_prompts.sql`. RLS policies enforced (verified by the
  existing migration test pattern, if any).
- **Manual UX**: create a prompt, type its slug, fill variables,
  send — message arrives expanded. Edit prompt, sync to second
  device (if signed in), see it appear.
- Existing 250+ tests stay green.

## Risk

**Low–medium.** Schema additions are reversible (drop the migration
file, drop the slice). The sync handler is purely additive. The
only place this can hurt is if the slash-resolver design isn't
shared cleanly with slash-commands and they bake in incompatible
assumptions. Mitigation: land the resolver module in whichever
plan ships first, as a deliberate seam.

## Open questions

- **Are user-scoped prompts the right call, or should some be
  workspace-scoped?** v1 says user-scoped (every prompt visible
  everywhere). The Manage dialog could later gain a "scope:
  user / workspace" toggle without breaking the schema. Recommend
  user-only for v1 and revisit if users ask.
- **Slug editability.** Auto-derived from name on creation, then
  editable. But what if the user renames a prompt? Re-derive slug
  silently (risk: breaks any slash-command-keystroke muscle memory)
  or keep slug stable (risk: name and slug drift). Recommend
  keep slug stable after first save; users explicitly edit it if
  they want.
- **Variable name validation.** Allow any non-empty string between
  `{{ }}`, or restrict to `[A-Za-z_][A-Za-z0-9_]*`? Recommend
  permissive — these are user-visible labels, not identifiers.
- **What does the variable-fill modal look like on mobile?**
  Bottom sheet rather than anchored popover. Reuses the pattern
  from _done/PLAN-explain-selection's mobile sheet.
