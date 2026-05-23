# Plan: Slash action commands

Status: **planning** — no code yet. Builds on the `/` slash surface
shipped in [#55](https://github.com/juchengquan/hummingbird/pull/55).

A second kind of `/` command alongside the skill-forcing slashes:
**action commands** that *do something now* instead of forcing a
skill and sending a message. `/clear`, `/rename <title>`, `/new`,
`/model`, `/help`.

## Why

PR #55 made `/` resolve skill triggers (`/search`, `/fetch`, …) —
those force a skill on and ride a message to send. But the natural
next thing a user types `/` expecting is a *command*: "/clear this
chat", "/rename it", "/new chat". Those aren't skills and don't send
a message — they run an action.

Right now typing `/clear` just sends the literal text "/clear" to the
model. That's the gap.

## Relationship to the ⌘K command palette

The app already has a **⌘K command palette**
(`components/command-palette.tsx`) that handles **navigation**: new
chat, switch view / workspace, jump to a conversation. Inline `/`
action commands must **not duplicate** that. They cover the
*compose-context / current-conversation* actions that are clumsy to
reach through a modal launcher:

| Surface | Job |
|---|---|
| ⌘K palette | Global navigation — go somewhere, open something |
| `/` skill slashes | Force a skill for this turn (+ send) |
| `/` action commands (this plan) | Act on the current conversation / compose box, no modal, no send |

So `/new` is the one overlap with ⌘K's "New chat" — kept because it's
muscle-memory from the input box and costs nothing. Everything else
here is conversation-local.

## The `/` namespace now hosts two kinds

`/` resolves to either a **skill** (force + send) or a **command**
(run now). They share the symbol but are behaviourally distinct and
must not collide on a trigger. `@` stays prompts-only (text
expansion) — unchanged by this plan. See the two-symbol model in
`_done/PLAN-slash-commands.md`.

```
/  ──► skill   (search, fetch, image, files)  → force skill, strip prefix, SEND
   └► command (clear, rename, new, model, help) → run action, NO send
@  ──► prompt  (user templates)               → expand text inline
```

## Command set (v1)

Grounded in store mutators / dialogs that already exist:

| Command | Aliases | Arg | Action | Confirm? |
|---|---|---|---|---|
| `/new` | — | — | `createConversation()` + `setActiveConversation()` | no |
| `/clear` | — | — | `clearMessages()` on the active conversation | **yes** (destructive) |
| `/rename` | — | `<title>` | `renameConversation(activeId, title)` | no |
| `/model` | — | `<name?>` | arg matches a model id/label → `setChatModel`; no arg → open the picker | no |
| `/help` | `/?` | — | open a slash cheat-sheet dialog listing every `/` and `@` trigger | no |

**Deliberately excluded from v1:**

- `/delete` — too destructive for a one-keystroke inline command; stays
  in the conversation kebab menu.
- Navigation (`/go`, `/workspace`, `/jump`) — that's ⌘K's job.
- `/summarize`, `/export`, `/compress` — these open heavier dialogs /
  flows that already have (or should have) conversation-header
  buttons. Revisit as a fast-follow once the core five feel right; if
  added, they just *trigger the existing dialog/flow*, no new logic.
- `/pin`, `/fork` — niche; defer until asked.

## Architecture

### Command registry (pure metadata)

**`lib/shared/commands/registry.ts`** (new) — metadata only, no
actions (keeps it in `shared`, testable, no store import):

```ts
export type CommandArgKind = 'none' | 'optional' | 'required'

export interface CommandDescriptor {
  /** Canonical trigger, e.g. "rename". First trigger shown in
   *  autocomplete; aliases accepted on input. */
  trigger: string
  aliases?: string[]
  title: string          // "Rename conversation"
  description: string    // autocomplete hint
  argKind: CommandArgKind
  argHint?: string       // "<title>"
  /** Stable id the chat panel maps to a run() implementation. */
  id: CommandId
  /** When true, route through the confirm AlertDialog before running. */
  destructive?: boolean
}

export type CommandId = 'new' | 'clear' | 'rename' | 'model' | 'help'

export const COMMANDS: CommandDescriptor[] = [ … ]
```

### Unified `/` resolver

Extend the existing parser rather than fork it. **`lib/shared/skills/slash-parser.ts`** grows a sibling that resolves *both*
namespaces, or a thin `lib/shared/slash-resolver.ts` that wraps both:

```ts
export type SlashResolution =
  | { kind: 'skill';   skillId: SkillId; trigger: string; remainder: string }
  | { kind: 'command'; commandId: CommandId; trigger: string; arg: string }
  | null

export function resolveSlash(text: string): SlashResolution
```

- Skill triggers and command triggers share the `/` namespace, so a
  **collision test** asserts no trigger appears in both registries.
- Resolution order is irrelevant *because* collisions are forbidden —
  a trigger is unambiguously a skill or a command.
- `arg` is the remainder after `/trigger `; `argKind: 'required'`
  with an empty arg is treated as "still typing" (no fire).

### Autocomplete — grouped

`components/panels/slash-autocomplete.tsx` (already symbol-agnostic)
gains an optional `groupLabel` per entry so the menu renders two
sections under `/`: **Commands** and **Skills**. `@` (prompts) stays
a single-group instance. No structural change — just a divider +
label when entries carry a group.

### Run map (client)

The actions live in the chat panel (they touch the store, dialogs,
navigation), not in `shared`. A small **`lib/client/hooks/use-slash-commands.ts`**
hook keeps `chat.tsx` from bloating:

```ts
const runCommand = useSlashCommands()  // returns (res: {commandId, arg}) => void
```

It owns: the confirm `AlertDialog` state (for `/clear`), the help
dialog open state, and the dispatch switch.

### Behavioural fork in the send path

The one careful spot. `handleSendMessage` today: parse skill slash →
force + send. New flow:

```
const res = resolveSlash(trimmed)
if (res?.kind === 'command') {
  runCommand(res)          // run the action
  setInputValue("")        // clear the box
  return                   // ← do NOT add a message / call the API
}
if (res?.kind === 'skill') { …existing force + send… }
…plain send…
```

Commands also fire on **Enter while the autocomplete is open** (pick →
run for instant commands; pick → fill `/rename ` for arg commands so
the user types the title, then Enter runs it).

## Edge cases

- **`/rename` with no arg** → autocomplete completes to `/rename `;
  Enter with an empty arg is a no-op (the title is required).
- **`/clear` confirm** → Enter opens the AlertDialog, doesn't clear
  immediately. Esc/Cancel aborts.
- **`/model foo` with an unknown model** → toast "No model matches
  'foo'", picker stays closed (or opens — pick one; lean: open picker).
- **Command + streaming** → `/clear` while a stream is in flight:
  block with a toast ("Stop the response first"), same as other
  destructive ops.
- **Unknown `/token`** → falls through to plain text (unchanged).

## Test plan

- **`lib/shared/commands/registry.test.ts`** — every command has a
  unique trigger; no trigger collides with a skill trigger
  (cross-registry assertion).
- **`lib/shared/slash-resolver.test.ts`** — resolves skill vs command
  vs null; arg extraction; required-arg-empty → null; alias matching;
  case-insensitivity.
- **Manual UX:** `/` shows Commands + Skills groups; `/clear` →
  confirm → messages gone, no chat turn; `/rename foo` renames;
  `/new` creates + switches; `/model` opens picker; `/help` lists
  triggers; `/clear` mid-stream is blocked.
- Existing slash-parser + skills tests stay green.

## Effort / risk

~300–400 lines incl. tests + the help dialog. Low-to-medium risk:
registry + resolver are pure and tested; the behavioural fork in
`handleSendMessage` (must not send for command turns) is the one spot
to get right. No server changes, no schema, no deps.

## Files

New:
- `lib/shared/commands/registry.ts` (+ test)
- `lib/shared/slash-resolver.ts` (+ test) — or extend `slash-parser.ts`
- `lib/client/hooks/use-slash-commands.ts`
- `components/panels/slash-help-dialog.tsx`

Modified:
- `components/panels/slash-autocomplete.tsx` — optional group labels
- `components/panels/chat.tsx` — command branch in the send path +
  autocomplete entries now merge commands + skills

Untouched: the server (no payload change — commands never reach it).

## Open question (for confirmation)

Whether `/summarize`, `/export`, `/compress` belong inline or stay as
conversation-header buttons. Recommendation: **header buttons** for
the heavy dialogs; keep the inline set to the fast five
(`/new /clear /rename /model /help`). Revisit if users ask to trigger
the dialogs from the keyboard.
