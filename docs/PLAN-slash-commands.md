# Plan: Slash commands for skill chaining

Status: **planning** — no code yet.

Power-user shortcut for forcing a skill on for a single turn from the
chat input. Type `/search …`, `/fetch …`, `/image …` and the matching
skill is enabled for that send regardless of the workspace /
conversation cascade. Autocomplete dropdown surfaces what's available
as the user types `/`.

Builds on the `ServerSkill` registry that landed in PR #21
(`lib/server/skills/registry.ts`) and the per-turn skill-override
state already in the chat panel (`mutedSkillsForNext` in
`components/panels/chat.tsx:99`).

## Why

Today the only way to enable a skill is to toggle it in the Skills
panel or right-rail chip. Both are persistent — a user who wants web
search "just for this one question" has to toggle on, send, then
toggle off, which is friction. Per-message slash commands collapse
that to one keystroke and let the rest of the chat continue at its
normal skill baseline.

The slash is the closest thing the chat input has to a command
palette, and it scales naturally as skills are added: each new skill
declares its own trigger in `lib/shared/skills/registry.ts`. No chat
route changes — the slash just toggles the skill, which already routes
through `SERVER_SKILLS` via the existing `body.skills` payload.

## Goal & scope cuts

**v1 ships:**

- Three skills exposed: `/search` (webSearch), `/fetch` (webFetch),
  `/image` (imageGen). Short aliases (`/s`, `/f`, `/img`) accepted on
  input but the canonical long form is shown in autocomplete.
- Slash must be the **first non-whitespace token** of the message. No
  mid-message slashes (those don't conceptually apply to "this whole
  turn").
- One slash per message. If the user types `/search /fetch …` the
  second token is treated as plain text — only the first one toggles
  a skill.
- Autocomplete dropdown above the textarea, keyboard nav (arrow keys,
  Enter, Esc) + click-to-pick.
- On send, the `/trigger ` prefix is stripped from the visible
  message; the forced skill is union'd with the cascade-enabled set
  for that turn only.
- The forced state resets after send (mirrors `mutedSkillsForNext`).

**Cut from v1:**

- **Slashes with structured arguments.** No `/image --aspect 16:9
  --count 2 a cat`. The slash toggles the skill; the prompt itself
  carries any natural-language directives. If users start asking for
  arg-style flags, revisit per-skill.
- **Custom user-defined slashes.** That's the **Prompt library**
  backlog item (`docs/BACKLOG.md`). Don't blur the two — slashes
  here are skill toggles; prompt library is template expansion.
- **Slashes that don't map to a skill** (e.g. `/help`, `/clear`,
  `/code`). Useful, but each needs its own surface design and isn't
  about skill chaining. Defer.
- **Chip-style replacement.** When the user picks a slash from the
  autocomplete, the `/trigger ` text stays as plain text in the
  input. A styled "chip" pill (like attachment pills) is slicker but
  needs contenteditable plumbing and clear backspace semantics —
  scope creep for v1.
- **Mid-message slashes / multi-slash chaining.** Both rejected
  above; revisit only if a real use case shows up.
- **Slash discovery on empty input.** The dropdown only appears once
  the user actually types `/`. No "type / for commands" placeholder
  hint in v1.

## Surface architecture

### One new shared type field

`lib/shared/skills/types.ts` gains a single optional field on
`SkillDescriptor`:

```ts
export interface SkillDescriptor {
  // …existing fields
  /** Slash-command shortcuts that force this skill on for the turn,
   *  overriding the workspace/conversation cascade. First trigger is
   *  canonical (shown in the autocomplete); later entries are accepted
   *  as aliases on input. Triggers must not collide across skills. */
  slashTriggers?: string[]
}
```

`lib/shared/skills/registry.ts` populates:

```ts
{ id: "webSearch", …, slashTriggers: ["search", "s"] }
{ id: "webFetch",  …, slashTriggers: ["fetch", "f"] }
{ id: "imageGen",  …, slashTriggers: ["image", "img"] }
```

Adding a fourth skill is then a one-field edit on its descriptor; no
chat-panel changes.

### One pure parser

**`lib/shared/skills/slash-parser.ts`** (new). Pure function, no
React, fully unit-testable:

```ts
export interface ParsedSlash {
  skillId: SkillId
  trigger: string     // matched token, e.g. "search"
  remainder: string   // message body with the slash + trailing space stripped
}

/** Extract a leading `/trigger ` from `text`. Returns null when the
 *  text doesn't start with a registered slash. Case-insensitive on the
 *  trigger; whitespace before the slash disqualifies (must be first
 *  token). A trailing space is required to disambiguate "/search" the
 *  command from "/searchy" the typo. */
export function parseSlashCommand(text: string): ParsedSlash | null
```

Called by the chat panel on send, and by the autocomplete to decide
whether to render the menu and what to highlight.

### One UI component

**`components/panels/slash-autocomplete.tsx`** (new). Renders when:

1. `inputValue.startsWith("/")`, AND
2. The caret is still inside the first whitespace-delimited token
   (so it disappears once the user types a space).

Visual: small floating menu above the textarea, anchored to the
textarea's top-left. Each row shows the skill's `icon`, canonical
trigger, name, and description. Keyboard: ↑/↓ moves selection, Enter
inserts `/<trigger> ` and dismisses, Esc dismisses without changing
input, Tab autocompletes the trigger.

Filter: prefix-match on the typed token after the `/`. Empty query
shows all registered triggers.

### Chat panel wire-up

`components/panels/chat.tsx` grows a sibling to `mutedSkillsForNext`:

```ts
const [forcedSkillsForNext, setForcedSkillsForNext] = useState<Set<SkillId>>(new Set())
```

Three small changes:

1. **`enabledSkills` assembly** (today around line 298): take the
   union of cascade-enabled and forced, with `mutedSkillsForNext`
   still applied. The muted-set wins over the forced-set in the rare
   case both contain the same id — predictable: if you muted it for
   this turn and also slash-commanded it, the explicit mute (`×` on
   the chip) wins. (Slash + chip-mute is unlikely in practice, but
   pick a rule and document it.)
2. **Send path:** run `parseSlashCommand(inputValue)`. If matched,
   add the skill id to `forcedSkillsForNext`, send `parsed.remainder`
   as the user-visible message content. If unmatched, send as-is.
3. **Render the autocomplete** when the input starts with `/`; pipe
   selections back to `setInputValue` (just normal text replacement).
4. **Reset:** the existing post-send cleanup at line 922 already
   clears `mutedSkillsForNext`; add the symmetric clear for
   `forcedSkillsForNext`.

No server-side changes. The route already takes `body.skills` and
runs whatever's there through the `SERVER_SKILLS` loop.

## Edge cases

- **Mute + slash collision.** User mutes a skill via the chip × then
  slash-commands the same skill. Rule: mute wins (explicit "off"
  beats explicit "on" — same precedence as the X chip beating the
  cascade today).
- **Slash with no message body.** `/search` alone (no text after the
  trigger). Send is allowed; the model gets an empty user turn with
  the skill enabled. This is no worse than today's "send empty
  message" behaviour (which is already gated upstream by the
  send-button disabled state).
- **Slash that doesn't match any registered trigger.** Treated as
  plain text. No special error.
- **Trigger collision with workspace prompts / variables.** Unlikely
  with current slashes (`/search`, `/fetch`, `/image`), but if the
  Prompt library lands later both surfaces will need a shared
  registry to prevent shadowing. Not a v1 concern.
- **Localization.** Triggers stay English-only in v1. They're
  command-like tokens, not user-facing copy.
- **Mobile.** The autocomplete must position above the soft keyboard.
  Use `position: fixed` anchored to the textarea bounding rect, the
  same trick `chat-input` already uses for the attachment bar.

## Test plan

- **`lib/shared/skills/slash-parser.test.ts`** *(new, ~25 cases):*
  - matches every registered trigger + alias
  - case-insensitivity (`/SEARCH` works)
  - trailing-space requirement (`/searchy` doesn't match)
  - body extraction (single word, multi-word, trailing whitespace)
  - returns null on leading whitespace, mid-message slash, unknown
    trigger, slash without trailing content beyond space
- **`lib/shared/skills/registry.test.ts`** *(extend):* assert no
  slash-trigger collisions across the registry — would let a future
  refactor reuse a token by accident.
- **Manual UX in dev** before shipping: each of `/search`, `/fetch`,
  `/image` produces a turn where the matching tool actually runs
  (visible in the per-turn tool-call strip).
- Existing 250+ tests stay green.

## Effort

~250 lines total, ~80 of them tests. One day of focused work end to
end, including manual UX verification.

## Risk

- **Low.** All changes are additive: a new shared type field
  (optional), a new pure parser, a new UI component, three small
  edits in `chat.tsx`. No server-side changes, no schema migrations,
  no breaking API shifts. The forced-skills set lives entirely on
  the client; the server already accepts an arbitrary list of skill
  ids on each request.

## Open question

- **Trigger collisions with Prompt library (future).** When the
  Prompt library lands (`docs/BACKLOG.md`), users will define their
  own `/foo` templates. The two surfaces will need to share a slash
  registry — first-match-wins, with skill triggers reserved. Worth
  noting up front so we don't bake an assumption here that makes the
  prompt-library merge painful. The proposed `SkillDescriptor`
  field is forward-compatible: a unified resolver can read from both
  the static skill registry and the user's prompt store and pick the
  best match.
