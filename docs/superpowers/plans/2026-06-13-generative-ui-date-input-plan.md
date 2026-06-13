# Generative UI — Date input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add date input to the generative-UI kind set — a standalone `date-picker` kind (single + range) and a `date` field type inside `mini-form`.

**Architecture:** Everything keys off the shared hub `lib/shared/generative-ui/schemas.ts` (kind enum, props schema, `UiAnswer`, parse/format helpers). The client registry maps the new kind to a `DatePickerCard` (reuses the repo's `Calendar`/`react-day-picker`); the mini-form card renders the new field with a native `<input type="date">`. The server tool + agent-py both carry a model-facing kind list that must learn `date-picker`. Dates are ISO `YYYY-MM-DD`, date-only.

**Tech Stack:** TypeScript, Zod, React 19, `react-day-picker` (via `components/ui/calendar.tsx`), `date-fns`, Bun test; Python (agent-py) for the lockstep kind tuple.

Design spec: `docs/superpowers/specs/2026-06-13-generative-ui-date-input-design.md`.

---

### Task 1: Shared schema — standalone `date-picker` kind

**Files:**
- Modify: `lib/shared/generative-ui/schemas.ts`
- Test: `lib/shared/generative-ui/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

First, add `DatePickerPropsSchema` to the **existing** top-of-file import from `"./schemas"` (don't add a second `import` line — `no-duplicate-imports` will flag it):

```ts
import {
  ChoicePropsSchema,
  ConfirmPropsSchema,
  DatePickerPropsSchema,
  InfoTablePropsSchema,
  MiniFormPropsSchema,
  UI_KIND_VALUES,
  UiKindEnum,
  UiPartSchema,
  defaultResolutionFor,
  formatAnswerForChat,
  parsePersistedUiPart,
  respondBodyForUiAnswer,
} from "./schemas"
```

Then append the test blocks to `lib/shared/generative-ui/schemas.test.ts`:

```ts
describe("DatePickerPropsSchema", () => {
  test("accepts a single-mode picker and defaults mode to single", () => {
    const parsed = DatePickerPropsSchema.safeParse({ prompt: "Pick a day" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mode).toBe("single")
  })
  test("accepts a range with min/max bounds", () => {
    const parsed = DatePickerPropsSchema.safeParse({
      prompt: "Pick a span",
      mode: "range",
      min: "2026-01-01",
      max: "2026-12-31",
    })
    expect(parsed.success).toBe(true)
  })
  test("rejects a non-ISO bound", () => {
    expect(
      DatePickerPropsSchema.safeParse({ prompt: "x", min: "06/20/2026" })
        .success,
    ).toBe(false)
  })
  test("rejects min > max", () => {
    expect(
      DatePickerPropsSchema.safeParse({
        prompt: "x",
        min: "2026-12-31",
        max: "2026-01-01",
      }).success,
    ).toBe(false)
  })
})

describe("date-picker — UiPartSchema + answer round-trips", () => {
  test("UiPartSchema accepts a well-formed date-picker", () => {
    const parsed = UiPartSchema.safeParse({
      kind: "date-picker",
      props: { prompt: "When?", mode: "single" },
    })
    expect(parsed.success).toBe(true)
  })
  test("parsePersistedUiPart round-trips a single answer", () => {
    const out = parsePersistedUiPart({
      id: "p1",
      kind: "date-picker",
      props: { prompt: "When?", mode: "single" },
      answer: { kind: "date-picker", date: "2026-06-20" },
    })
    expect(out?.answer).toEqual({ kind: "date-picker", date: "2026-06-20" })
  })
  test("parsePersistedUiPart round-trips a range answer", () => {
    const out = parsePersistedUiPart({
      id: "p2",
      kind: "date-picker",
      props: { prompt: "Span?", mode: "range" },
      answer: { kind: "date-picker", from: "2026-06-20", to: "2026-06-25" },
    })
    expect(out?.answer).toEqual({
      kind: "date-picker",
      from: "2026-06-20",
      to: "2026-06-25",
    })
  })
  test("drops a malformed range answer (from > to)", () => {
    const out = parsePersistedUiPart({
      id: "p3",
      kind: "date-picker",
      props: { prompt: "Span?", mode: "range" },
      answer: { kind: "date-picker", from: "2026-06-25", to: "2026-06-20" },
    })
    expect(out?.answer).toBeUndefined()
  })
  test("formatAnswerForChat renders single + range human-readable", () => {
    const single = formatAnswerForChat(
      { kind: "date-picker", props: { prompt: "When?", mode: "single" } },
      { kind: "date-picker", date: "2026-06-20" },
    )
    expect(single).toBe("June 20, 2026")
    const range = formatAnswerForChat(
      { kind: "date-picker", props: { prompt: "Span?", mode: "range" } },
      { kind: "date-picker", from: "2026-06-20", to: "2026-06-25" },
    )
    expect(range).toBe("June 20, 2026 – June 25, 2026")
  })
  test("defaultResolutionFor(date-picker) is auto-send", () => {
    expect(defaultResolutionFor("date-picker")).toBe("auto-send")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/shared/generative-ui/schemas.test.ts`
Expected: FAIL — `Export named 'DatePickerPropsSchema' not found` (and the new assertions error).

- [ ] **Step 3: Add the ISO helper + kind to `schemas.ts`**

Near the top of `lib/shared/generative-ui/schemas.ts`, after the `import { z } from "zod"` line, add the `date-fns` import and the ISO helpers:

```ts
import { format, parseISO } from "date-fns"

/** Dates in generative UI are ISO `YYYY-MM-DD`, date-only (no time/zone). */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const IsoDate = z.string().regex(ISO_DATE_RE, "expected YYYY-MM-DD")

/** Human-readable form of an ISO date for the follow-up chat turn.
 *  Falls back to the raw string if it isn't a clean ISO date. */
function formatIsoHuman(iso: string): string {
  return ISO_DATE_RE.test(iso) ? format(parseISO(iso), "MMMM d, yyyy") : iso
}
```

Add `"date-picker"` to the kind allow-list:

```ts
export const UI_KIND_VALUES = [
  "info-table",
  "choice",
  "confirm",
  "mini-form",
  "date-picker",
] as const
```

Add the props schema (place it after `MiniFormPropsSchema`, before the union):

```ts
// --- date-picker ------------------------------------------------------------

export const DatePickerPropsSchema = z
  .object({
    prompt: z.string().min(1).max(500),
    /** "single" → one day, auto-resolves on pick; "range" → from/to
     *  with a Submit button. */
    mode: z.enum(["single", "range"]).default("single"),
    /** Earliest / latest selectable day (ISO). Out-of-range days are
     *  disabled in the calendar. */
    min: IsoDate.optional(),
    max: IsoDate.optional(),
  })
  .refine((p) => !p.min || !p.max || p.min <= p.max, {
    message: "min must be <= max",
  })
export type DatePickerProps = z.infer<typeof DatePickerPropsSchema>
```

Add the union member to `UiPartSchema`:

```ts
export const UiPartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("info-table"), props: InfoTablePropsSchema }),
  z.object({ kind: z.literal("choice"), props: ChoicePropsSchema }),
  z.object({ kind: z.literal("confirm"), props: ConfirmPropsSchema }),
  z.object({ kind: z.literal("mini-form"), props: MiniFormPropsSchema }),
  z.object({ kind: z.literal("date-picker"), props: DatePickerPropsSchema }),
])
```

- [ ] **Step 4: Extend `UiAnswer`, `parseAnswerForKind`, `formatAnswerForChat`**

Add the two `date-picker` members to the `UiAnswer` union (single distinguished from range by which fields are present):

```ts
export type UiAnswer =
  | { kind: "info-table" }
  | { kind: "choice"; selectedIds: string[] }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "mini-form"; values: Record<string, string> }
  | { kind: "date-picker"; date: string }
  | { kind: "date-picker"; from: string; to: string }
```

In `parseAnswerForKind`, add a `date-picker` branch (before the closing `return null`):

```ts
  if (kind === "date-picker") {
    const date = v.date
    if (typeof date === "string" && ISO_DATE_RE.test(date)) {
      return { kind: "date-picker", date }
    }
    const from = v.from
    const to = v.to
    if (
      typeof from === "string" &&
      ISO_DATE_RE.test(from) &&
      typeof to === "string" &&
      ISO_DATE_RE.test(to) &&
      from <= to
    ) {
      return { kind: "date-picker", from, to }
    }
    return null
  }
```

In `formatAnswerForChat`, add a `date-picker` branch (before the final `return ""`):

```ts
  if (part.kind === "date-picker" && answer.kind === "date-picker") {
    if ("date" in answer) return formatIsoHuman(answer.date)
    return `${formatIsoHuman(answer.from)} – ${formatIsoHuman(answer.to)}`
  }
```

(No change to `defaultResolutionFor` — its existing `kind === "mini-form" ? "prefill" : "auto-send"` already returns `auto-send` for `date-picker`. The Step-1 test pins this.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test lib/shared/generative-ui/schemas.test.ts`
Expected: PASS (all existing + new cases).

- [ ] **Step 6: Commit**

```bash
git add lib/shared/generative-ui/schemas.ts lib/shared/generative-ui/schemas.test.ts
git commit -m "feat(shared): date-picker generative-UI kind (single + range)"
```

---

### Task 2: Shared schema — `mini-form` `date` field

**Files:**
- Modify: `lib/shared/generative-ui/schemas.ts`
- Test: `lib/shared/generative-ui/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/shared/generative-ui/schemas.test.ts`:

```ts
describe("mini-form — date field", () => {
  test("accepts a date field with bounds", () => {
    const parsed = MiniFormPropsSchema.safeParse({
      fields: [
        { type: "date", id: "due", label: "Due date", min: "2026-01-01" },
      ],
    })
    expect(parsed.success).toBe(true)
  })
  test("rejects a date field with a non-ISO bound", () => {
    const parsed = MiniFormPropsSchema.safeParse({
      fields: [{ type: "date", id: "due", label: "Due", max: "Dec 31" }],
    })
    expect(parsed.success).toBe(false)
  })
  test("formatAnswerForChat renders a date field value verbatim (ISO)", () => {
    const text = formatAnswerForChat(
      {
        kind: "mini-form",
        props: { fields: [{ type: "date", id: "due", label: "Due date" }] },
      },
      { kind: "mini-form", values: { due: "2026-06-20" } },
    )
    expect(text).toBe("Due date: 2026-06-20")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/shared/generative-ui/schemas.test.ts`
Expected: FAIL — the `date` field variant is rejected by `MiniFormFieldSchema`, so the first test's `safeParse(...).success` is `false`.

- [ ] **Step 3: Add the `date` variant to `MiniFormFieldSchema`**

In `lib/shared/generative-ui/schemas.ts`, add a fourth member to the `MiniFormFieldSchema` discriminated union (after the `select` member):

```ts
  z.object({
    type: z.literal("date"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(120),
    min: IsoDate.optional(),
    max: IsoDate.optional(),
  }),
```

(No change to `UiAnswer` / `parseAnswerForKind` / `formatAnswerForChat` for `mini-form` — the submitted value is an ISO string in the existing `values` map, and the generic "Label: value" formatter already renders it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/shared/generative-ui/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/generative-ui/schemas.ts lib/shared/generative-ui/schemas.test.ts
git commit -m "feat(shared): add date field type to mini-form"
```

---

### Task 3: `DatePickerCard` component + registry

**Files:**
- Create: `components/chat/generative-ui/date-picker-card.tsx`
- Modify: `lib/client/chat/generative-ui/registry.ts`

No new test file — the answer-shape logic is covered by Task 1's pure tests; the card is a thin view that calls `onResolve` with those shapes. Verification is `bun run typecheck && bun run lint` (the repo has no component-render tests, and importing `react-day-picker` into `bun test` is not an established pattern). This matches how `ChoiceCard` / `MiniFormCard` are verified.

- [ ] **Step 1: Create the card**

Create `components/chat/generative-ui/date-picker-card.tsx`:

```tsx
"use client"
import "client-only"

/**
 * DatePickerCard — single date (auto-resolves on pick) or a date range
 * (pick from→to, then Submit). Reuses the repo's `Calendar`
 * (react-day-picker). Dates are ISO `YYYY-MM-DD`, date-only. Inert
 * state shows the picked date(s) with the calendar disabled.
 */

import { useState } from "react"
import { format, parseISO } from "date-fns"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import type {
  DatePickerProps,
  UiAnswer,
} from "@/shared/generative-ui/schemas"
import { cn } from "@/shared/utils"

import type { UiPartHostProps } from "@/client/chat/generative-ui/registry"

const toIso = (d: Date): string => format(d, "yyyy-MM-dd")

export function DatePickerCard({
  props,
  inert,
  answer,
  onResolve,
}: UiPartHostProps) {
  const p = props as DatePickerProps
  const dp = answer && answer.kind === "date-picker" ? answer : null

  // min/max bound the calendar — out-of-range days are disabled.
  const disabled = [
    ...(p.min ? [{ before: parseISO(p.min) }] : []),
    ...(p.max ? [{ after: parseISO(p.max) }] : []),
  ]

  const prevSingle = dp && "date" in dp ? parseISO(dp.date) : undefined
  const prevRange: DateRange | undefined =
    dp && "from" in dp
      ? { from: parseISO(dp.from), to: parseISO(dp.to) }
      : undefined

  const [range, setRange] = useState<DateRange | undefined>(() => prevRange)

  const card = (children: React.ReactNode) => (
    <div
      className={cn(
        "my-3 rounded-lg border border-[var(--border)]",
        "bg-[var(--card)] text-[var(--card-foreground)]",
        "p-3 text-sm",
      )}
      aria-label="Date picker"
    >
      <div className="mb-2 text-[var(--foreground)]">{p.prompt}</div>
      {children}
    </div>
  )

  if (p.mode === "range") {
    return card(
      <>
        <Calendar
          mode="range"
          selected={range}
          onSelect={inert ? undefined : setRange}
          disabled={inert ? true : disabled}
        />
        {!inert ? (
          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              disabled={!range?.from || !range?.to}
              onClick={() => {
                if (range?.from && range?.to) {
                  onResolve({
                    kind: "date-picker",
                    from: toIso(range.from),
                    to: toIso(range.to),
                  } satisfies Extract<UiAnswer, { kind: "date-picker" }>)
                }
              }}
            >
              Submit
            </Button>
          </div>
        ) : null}
      </>,
    )
  }

  return card(
    <Calendar
      mode="single"
      selected={prevSingle}
      onSelect={
        inert
          ? undefined
          : (d?: Date) => {
              if (d) onResolve({ kind: "date-picker", date: toIso(d) })
            }
      }
      disabled={inert ? true : disabled}
    />,
  )
}
```

- [ ] **Step 2: Register the kind**

In `lib/client/chat/generative-ui/registry.ts`, add the import + schema import + registry entry:

```ts
// add to the schema import from "@/shared/generative-ui/schemas":
  DatePickerPropsSchema,
// add the component import:
import { DatePickerCard } from "@/components/chat/generative-ui/date-picker-card"
```

Add the entry to `UI_KINDS`:

```ts
export const UI_KINDS: Record<UiKind, UiKindDef> = {
  "info-table": { schema: InfoTablePropsSchema, Component: InfoTable },
  choice: { schema: ChoicePropsSchema, Component: ChoiceCard },
  confirm: { schema: ConfirmPropsSchema, Component: ConfirmCard },
  "mini-form": { schema: MiniFormPropsSchema, Component: MiniFormCard },
  "date-picker": { schema: DatePickerPropsSchema, Component: DatePickerCard },
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (no errors). If `DatePickerPropsSchema` type doesn't satisfy `z.ZodTypeAny` because of the `.refine()`, it still typechecks — `ZodEffects` extends `ZodType`.

- [ ] **Step 4: Commit**

```bash
git add components/chat/generative-ui/date-picker-card.tsx lib/client/chat/generative-ui/registry.ts
git commit -m "feat(chat): DatePickerCard + register date-picker kind"
```

---

### Task 4: `mini-form-card.tsx` — render the `date` field

**Files:**
- Modify: `components/chat/generative-ui/mini-form-card.tsx`

- [ ] **Step 1: Render the `date` field type**

In `components/chat/generative-ui/mini-form-card.tsx`, the field map currently special-cases `select` then falls through to an `<Input>` for `text`/`number`. A native `<input type="date">` yields an ISO `YYYY-MM-DD` value directly, so extend the fallthrough `<Input>` to handle `date` (it already renders `type={f.type === "number" ? "number" : "text"}`). Replace that `type=` expression and add the `min`/`max` passthrough.

Change the `<Input>`'s `type` prop:

```tsx
                type={
                  f.type === "number"
                    ? "number"
                    : f.type === "date"
                      ? "date"
                      : "text"
                }
```

And add date bounds alongside the existing number-bounds spreads (inside the same `<Input ... />`):

```tsx
                {...(f.type === "date" && f.min !== undefined
                  ? { min: f.min }
                  : {})}
                {...(f.type === "date" && f.max !== undefined
                  ? { max: f.max }
                  : {})}
```

(The `select` branch is unaffected; `date` flows through the `<Input>` path, and its native value is the ISO string written into the `values` map by the existing `onChange`.)

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. The `f.type === "date"` narrowing is valid because Task 2 added the `date` variant to `MiniFormField`.

- [ ] **Step 3: Commit**

```bash
git add components/chat/generative-ui/mini-form-card.tsx
git commit -m "feat(chat): render mini-form date field as a native date input"
```

---

### Task 5: Model-facing kind lists — server tool + agent-py lockstep

**Files:**
- Modify: `lib/server/generative-ui/tool.ts`
- Modify: `services/agent-py/src/agent_py/tools/render_ui.py`
- Test: `services/agent-py/tests/test_ask_user_render_ui.py`

- [ ] **Step 1: Extend the server tool's model-facing description**

In `lib/server/generative-ui/tool.ts`, in `RENDER_UI_PROMPT_FRAGMENT`, add a `date-picker` clause and mention the new mini-form field. Replace the `mini-form` clause + trailing sentence with:

```ts
  "`mini-form` (1–4 short fields the user fills in — text, number, " +
  "select, or `date`; the submitted values become the next user " +
  "message, after they confirm); " +
  "`date-picker` (a calendar for a single date or a date range; the " +
  "picked date(s) become the next user message). " +
  "Dates are ISO YYYY-MM-DD. " +
  "For interactive kinds, your next assistant turn will see the user's " +
  "answer as a normal user message — write your reply assuming that " +
  "answer is the user's words."
```

- [ ] **Step 2: Write the failing agent-py test**

Append to `services/agent-py/tests/test_ask_user_render_ui.py`:

```python
def test_render_ui_kind_list_includes_date_picker() -> None:
    """The Python renderUI kind tuple must stay in lockstep with the TS
    UI_KIND_VALUES in lib/shared/generative-ui/schemas.ts."""
    from agent_py.tools.render_ui import UI_KIND_VALUES

    assert "date-picker" in UI_KIND_VALUES
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd services/agent-py && uv run pytest tests/test_ask_user_render_ui.py::test_render_ui_kind_list_includes_date_picker -v`
Expected: FAIL with `assert 'date-picker' in (...)`.

- [ ] **Step 4: Add `date-picker` to the Python lockstep tuple**

In `services/agent-py/src/agent_py/tools/render_ui.py`, extend `UI_KIND_VALUES`:

```python
UI_KIND_VALUES: tuple[str, ...] = (
    "info-table",
    "choice",
    "confirm",
    "mini-form",
    "date-picker",
)
```

(The description string + JSON-schema `kind` enum are built from this tuple, so they pick `date-picker` up automatically. The `mini-form` `date` field needs no Python change — it's opaque pass-through props validated client-side.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/agent-py && uv run pytest tests/test_ask_user_render_ui.py::test_render_ui_kind_list_includes_date_picker -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/server/generative-ui/tool.ts services/agent-py/src/agent_py/tools/render_ui.py services/agent-py/tests/test_ask_user_render_ui.py
git commit -m "feat: teach renderUI (server + agent-py) about the date-picker kind"
```

---

### Task 6: Full gate + sign-off

**Files:** none (verification only).

- [ ] **Step 1: TS gate**

Run: `bun run check`
Expected: typecheck + lint + `bun test` all pass. (The whole-suite `bun test` has pre-existing env failures — `app/api/tasks` needs a live Postgres, `lib/server/.../minimax` needs network, `services/agent-ts` is missing its `postgres` dep. Confirm the generative-ui + shared tests pass and no NEW failures appear: `bun test lib/shared components`.)

- [ ] **Step 2: agent-py gate**

Run: `bun run check:agent-py`
Expected: ruff check + ruff format --check + mypy + pytest all pass.

- [ ] **Step 3: user-manual drift check**

Run: `bun run docs:user-manual:check`
Expected: up to date. (No new env vars/panels were added, so no drift is expected. If it flags drift, run `bun run docs:user-manual:build` and commit the regenerated inventory.)

- [ ] **Step 4: Final — open the PR**

```bash
git push -u origin feat/generative-ui-date-input
gh pr create --base dev --title "feat: generative-UI date input (date-picker kind + mini-form date field)" --body "Implements docs/superpowers/specs/2026-06-13-generative-ui-date-input-design.md."
```

(Per the repo's PR rules, auto-subscribe to the new PR if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **Date ↔ ISO:** `react-day-picker` works in JS `Date` objects; the wire/answer shape is ISO `YYYY-MM-DD`. Convert with `format(d, "yyyy-MM-dd")` (Date→ISO) and `parseISO(iso)` (ISO→Date) from `date-fns` (already a dep). `parseISO` of a date-only string yields local midnight, so no timezone drift for date-only use.
- **Why no component-render tests:** the repo's generative-UI tests are pure schema/helper tests in `schemas.test.ts`; there are no `.test.tsx` files, and importing `react-day-picker` into `bun test` isn't an established pattern. The card's only logic is producing the `UiAnswer` shapes, which Task 1 covers. Cards are verified by typecheck + lint.
- **Lockstep invariant:** `UI_KIND_VALUES` exists in BOTH `lib/shared/generative-ui/schemas.ts` (TS, the source of truth) and `services/agent-py/src/agent_py/tools/render_ui.py` (Python mirror). Task 5's agent-py test guards the Python side; adding any future kind means updating both.
```
