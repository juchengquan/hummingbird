# Generative UI — Date input — Design

Status: **approved design — ready for implementation plan.**
Origin: `docs/PLAN-generative-ui-parts.md` §Reopen / future work → "More
kinds (date picker, …)". This is one phased commit extending the shipped
generative-UI kind set (`info-table` / `choice` / `confirm` / `mini-form`)
with date input.

## Why

`mini-form` already offers `text` / `number` / `select` fields, but there
is **no date affordance** anywhere in the generative-UI set. Today the
model has to ask for a date in prose and parse a free-text reply
(`"next Tuesday"`), which is error-prone and format-ambiguous. A real
calendar that returns a **normalized ISO date** removes that burden and
reuses the `Calendar` (`react-day-picker`) component + `date-fns` already
in the repo.

Two surfaces ship together (decided during brainstorming):

1. A **standalone `date-picker` kind** — a focused "pick a date / range"
   card the model emits directly.
2. A **`date` field type inside `mini-form`** — so a form can mix a date
   with other fields.

## Non-goals (YAGNI)

- **No time-of-day / timezone.** Dates are date-only `YYYY-MM-DD`.
- **No relative/recurring dates** ("every Monday", "in 3 days") — the
  model resolves those to a concrete date before calling the tool.
- **No agent-ts work.** agent-ts still lacks the HITL pipeline; its
  `renderUI` port stays deferred with the broader agent-ts Phase 3
  milestone (per `PLAN-generative-ui-parts.md`). This feature is
  chat-mode + agent-py task-mode only.
- **No streaming props / skeletons.** The part emits whole.

## Format convention

All dates are **ISO `YYYY-MM-DD`, date-only** (no time, no zone). A single
shared regex gates both directions:

```ts
// lib/shared/generative-ui/schemas.ts
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const IsoDate = z.string().regex(ISO_DATE_RE, "expected YYYY-MM-DD")
```

Malformed dates **drop** (return `null` from the boundary parser / fail
`safeParse`) — never throw. This preserves the existing renderer
invariant ("malformed = skip the part, don't crash the bubble").

## Data model — `lib/shared/generative-ui/schemas.ts` (the hub)

This file is the single source of truth; every other change follows from
it.

### 1. Standalone `date-picker` kind

```ts
UI_KIND_VALUES = [..., "date-picker"]     // append

export const DatePickerPropsSchema = z
  .object({
    prompt: z.string().min(1).max(500),
    mode: z.enum(["single", "range"]).default("single"),
    min: IsoDate.optional(),              // earliest selectable day
    max: IsoDate.optional(),              // latest selectable day
  })
  .refine((p) => !p.min || !p.max || p.min <= p.max, {
    message: "min must be <= max",
  })
export type DatePickerProps = z.infer<typeof DatePickerPropsSchema>

// union member
z.object({ kind: z.literal("date-picker"), props: DatePickerPropsSchema })
```

Answer shape (added to the `UiAnswer` union — discriminated, single vs
range distinguished by which fields are present):

```ts
| { kind: "date-picker"; date: string }                 // mode "single"
| { kind: "date-picker"; from: string; to: string }     // mode "range"
```

- `parseAnswerForKind` gains a `date-picker` branch: a single answer needs
  a valid `date`; a range answer needs valid `from` + `to` (with
  `from <= to`). Anything else → `null`.
- `formatAnswerForChat` gains a `date-picker` branch — human-readable via
  `date-fns` `format`:
  - single → `"June 20, 2026"`
  - range → `"June 20, 2026 – June 25, 2026"`
- `defaultResolutionFor("date-picker")` → **`"auto-send"`** (like
  `choice` / `confirm`).

### 2. `mini-form` `date` field (additive — no new kind, no answer change)

```ts
// add a 4th variant to MiniFormFieldSchema's discriminatedUnion
z.object({
  type: z.literal("date"),
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  min: IsoDate.optional(),
  max: IsoDate.optional(),
})
```

The submitted value is the **ISO string** stored in the existing
`mini-form` answer (`values: Record<string,string>`). Therefore
`UiAnswer`, `parseAnswerForKind`, and `formatAnswerForChat` for
`mini-form` need **no change** — the generic "Label: value" path already
renders `Start date: 2026-06-20`. (We accept the ISO value verbatim in
the form summary; the form prefills the composer for review before
sending anyway.)

## Rendering & behavior

### New `components/chat/generative-ui/date-picker-card.tsx`

Reuses the existing `Calendar` (`react-day-picker`) primitive. Receives
the shared `UiPartHostProps` (`props`, `inert`, `answer`, `onResolve`).

- **`mode: "single"`** — pick a day → immediately `onResolve({ kind:
  "date-picker", date })`. With `defaultResolutionFor` = auto-send, the
  follow-up turn sends right away (one interaction, like `choice`
  single-select).
- **`mode: "range"`** — pick `from` then `to`; a **Submit** button
  resolves `onResolve({ kind: "date-picker", from, to })`. Mirrors the
  `multiSelect` `choice` pattern (can't auto-send mid-range).
- `min` / `max` disable out-of-range days.
- `inert` / `answer` render: show the chosen date(s), controls disabled —
  matches how the other cards render their resolved state after reload.

### `components/chat/generative-ui/mini-form-card.tsx`

Render the `type: "date"` field with a date input (a popover `Calendar`,
consistent with the card's other fields). The picked ISO value flows into
the existing submit map under the field `id`. `min` / `max` bound the
calendar.

### Registry

`lib/client/chat/generative-ui/registry.ts`: add
`"date-picker": { schema: DatePickerPropsSchema, Component: DatePickerCard }`.

### Task mode — works without new task-mode code

`components/agent/task-strip.tsx` already renders task-mode `ui-part`
pauses through the **same shared registry**, so the date-picker card
appears there for free. The response path
(`respondBodyForUiAnswer`) already folds `formatAnswerForChat(part,
answer)` into the back-compat `value` field, so the agent runner receives
a readable date string (e.g. `"June 20, 2026"`) alongside the structured
`uiAnswer`. No change to the respond plumbing.

## Server + agent-py touch points

- **`lib/server/generative-ui/tool.ts`** — the `inputSchema.kind` enum is
  built from `UI_KIND_VALUES`, so it picks up `date-picker`
  automatically. **Update the model-facing description string** to list
  the `date-picker` kind and mention the `mini-form` `date` field, so the
  model knows when to reach for them.
- **`services/agent-py/src/agent_py/tools/render_ui.py`** — this file
  keeps its **own** `UI_KIND_VALUES` tuple in lockstep with the TS enum
  (used for the model-facing description + the JSON-schema `kind` enum; it
  does **not** validate props — the client Zod does). Add `"date-picker"`
  to that tuple. The `mini-form` `date` field needs **no** Python change
  (`mini-form` is already listed; the new field type is opaque
  pass-through props).

## Touch-point summary

| File | Change |
|---|---|
| `lib/shared/generative-ui/schemas.ts` | `ISO_DATE_RE`/`IsoDate`; `date-picker` kind + `DatePickerPropsSchema`; `mini-form` `date` field; `UiAnswer` `date-picker` variants; `parseAnswerForKind` + `formatAnswerForChat` + `defaultResolutionFor` + `UiPartSchema` |
| `lib/client/chat/generative-ui/registry.ts` | register `date-picker → DatePickerCard` |
| `components/chat/generative-ui/date-picker-card.tsx` | **new** card (single auto-send / range submit / inert) |
| `components/chat/generative-ui/mini-form-card.tsx` | render `type:"date"` field |
| `lib/server/generative-ui/tool.ts` | extend model-facing description |
| `services/agent-py/src/agent_py/tools/render_ui.py` | add `"date-picker"` to the lockstep `UI_KIND_VALUES` tuple + description |
| `lib/shared/generative-ui/schemas.test.ts` | new assertions (below) |
| `services/agent-py/.../tests/test_ask_user_render_ui.py` | assert `date-picker` is in the Python kind list |

## Testing

Coverage mirrors how the existing kinds are tested — **pure schema +
helper tests** in `lib/shared/generative-ui/schemas.test.ts` (the repo has
no `.test.tsx`; component-render tests aren't the established pattern, and
the card's behavior is fully expressed through the pure `onResolve` answer
shapes). New cases:

- `DatePickerPropsSchema` accepts single/range, applies the `single`
  default, rejects bad ISO + `min > max`.
- `mini-form` accepts a `date` field; rejects a malformed one.
- `parsePersistedUiPart` round-trips a `date-picker` single + range
  answer; drops malformed (`from > to`, non-ISO).
- `formatAnswerForChat` renders single (`"June 20, 2026"`) + range; a
  `mini-form` with a `date` field renders `"Label: 2026-06-20"`.
- `defaultResolutionFor("date-picker") === "auto-send"`.
- agent-py: one assertion that `"date-picker"` is in `render_ui`'s
  `UI_KIND_VALUES` (the lockstep guard).

Full gate before done: `bun run check` (TS typecheck + lint + bun test) +
`bun run check:agent-py`.

## Scope

One feature, one PR. ~250–350 LOC across the table above. The bulk is the
schema hub + the new `DatePickerCard`; everything else is a few lines
each.
