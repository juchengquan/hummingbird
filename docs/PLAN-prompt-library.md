# Plan: Prompt library

Status: **planning** — no code yet.

User-scoped saved prompt templates with placeholder variables,
surfaced via `/<name>` autocomplete in the chat input and managed
from a dialog opened from the chat header kebab. Templates expand to
real prompts (with the user filling in variables) before being sent
as the next user turn.

Builds on the planned slash-command surface
(`docs/PLAN-slash-commands.md`) — both features write into the same
autocomplete dropdown and share a slash-trigger registry.

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
  `PLAN-slash-commands.md`). Skill triggers reserved — prompt
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

**Supabase table** (`supabase/migrations/0007_prompts.sql`):

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

### Slash resolver — shared with skill slashes

The slash-commands plan (`PLAN-slash-commands.md`) flags
prompt-library coexistence as an open question. Resolved here:

**Single resolver lives in `lib/client/slash-resolver.ts`** (new
file, written as part of the slash-commands or prompt-library
implementation, whichever lands first).

Inputs:
- Static skill triggers from `lib/shared/skills/registry.ts`
- User prompt slugs from the Zustand `prompts` slice

Output:
- Ordered list of `{ kind: 'skill' | 'prompt'; trigger: string; ...meta }`
  for the autocomplete to render.

**Collision rule: skill triggers win.** If a user names a prompt
`search`, the slug `/search` still maps to the web-search skill;
the prompt is silently shadowed in the autocomplete (and an
inline hint in the Manage Prompts dialog tells the user). Reason:
skill triggers are global, documented, and the user can rename
their prompt; reserving them avoids surprising "my prompt
disappeared" cases.

The shared resolver is also where the prompt-library autocomplete
list comes from. The dropdown (a single component) lists skills
first, then prompts, with a divider between.

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

**`components/panels/manage-prompts-dialog.tsx`** *(new)*. List on
the left, edit form on the right. Form fields:
- Name (auto-derives slug on first input; slug becomes editable
  after first save)
- Template textarea (auto-resizing, monospace, with variable
  markers highlighted)
- Live preview pane: shows the template with `{{var}}` rendered as
  pill placeholders. Helps the user see what'll be expanded.
- Variable list (derived, read-only) for clarity.

Save / Delete / Duplicate buttons. Standard `Dialog` from
`components/ui/dialog.tsx`.

**`components/panels/prompt-variable-fill.tsx`** *(new)*. Small
modal anchored near the chat input. One text field per variable
in order, with auto-focus on first. Submit (Enter on last field
or click Send) expands the template and sets the chat input to the
expanded text — the user can still edit before sending if they
want. Esc cancels, restoring the input to just `/<slug>` so the
user can pick something else.

**`components/panels/slash-autocomplete.tsx`** is shared with the
slash-commands plan. Extends to render prompt rows in addition to
skill rows (visual: same row shape, different icon — maybe
`BookOpen` for prompts vs the skill's icon).

### Chat header wire-up

`components/panels/chat-header.tsx`'s kebab popover gains one entry:
**Manage prompts** at the top (above Summarise / Pin / etc.). Opens
the `ManagePromptsDialog`. One-line change.

### Chat panel wire-up

`components/panels/chat.tsx` already has the `enabledSkills`
assembly the slash plan touches. Prompt expansion is independent:

1. On send, check if `inputValue` starts with `/<known-prompt-slug>`
2. If so, the slug + space is stripped (the variable-fill modal
   already replaced the input text by this point in the happy
   path)
3. Otherwise, send as-is

The variable-fill modal pre-expands the message into the visible
input before the user clicks Send, so the actual send-path is just
"send whatever's in the textarea." No special expansion step at
send time.

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

The only non-trivial design coupling is with `PLAN-slash-commands.md`
— both features write into the same autocomplete dropdown. Resolved
above (single shared resolver, skill-triggers reserved). If
slash-commands lands first, this plan extends the autocomplete; if
this lands first, it's the autocomplete and slash-commands extends
later. Order doesn't matter, but **the shared resolver is the seam
that has to be designed correctly the first time** — if either
feature ships without it and bakes in assumptions, the second one
gets messy.

## Files touched

| File | Why |
|---|---|
| `supabase/migrations/0007_prompts.sql` *(new)* | Table + RLS |
| `lib/shared/prompts/types.ts` *(new)* | `Prompt`, `ParsedTemplate` types |
| `lib/shared/prompts/expand.ts` *(new)* | `parseTemplate`, `expandTemplate` |
| `lib/shared/prompts/expand.test.ts` *(new)* | Pure-fn tests |
| `lib/client/hooks/use-store.ts` | `prompts` slice + actions |
| `lib/client/sync/handlers.ts` | `diffPrompts` |
| `lib/client/hooks/use-sync.ts` | Subscribe `diffPrompts` |
| `lib/client/slash-resolver.ts` *(new, shared with slash-commands)* | Unified slash dispatch |
| `components/panels/manage-prompts-dialog.tsx` *(new)* | CRUD UI |
| `components/panels/prompt-variable-fill.tsx` *(new)* | Variable fill-in modal |
| `components/panels/slash-autocomplete.tsx` | Extend to render prompt rows |
| `components/panels/chat-header.tsx` | Add "Manage prompts" kebab entry |
| `components/panels/chat.tsx` | Variable-fill modal trigger on slash select |

**~600 lines** of new code + ~120 of tests. Bigger than slash-
commands but smaller than diff-mode because the patterns are all
established — most of it is plumbing through the existing slice +
sync chain.

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
  from PLAN-explain-selection's mobile sheet.
