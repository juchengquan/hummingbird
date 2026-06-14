# Citation-table typed columns — Slice 1 (Text + Number)

**Status:** Draft → spec for the next polish slice in the citation-table arc (post-#227). Slice 1 of two. Slice 2 will add Link + Date.

**Goal:** Add an optional `type` field to columns (Text or Number), so the sort + extract pipeline can stop using today's heuristic numeric sniff, and so users can declare "this is a Number column" once and have sort + rendering honor it.

---

## Decisions locked during brainstorming

| # | Decision | Choice |
|---|---|---|
| Q1 | Type set | **Text, Number, Link, Date** (Core). Slice 1 ships Text + Number; Slice 2 adds Link + Date. |
| Q2a | Edit coercion | **Tolerate + warn.** Store the raw string; show a small inline "⚠ Not a number" glyph with a tooltip. Never reject, never silently coerce to empty. |
| Q2b | Link scope (slice 2) | **http(s):// only.** |
| Q3 | Back-compat | **`type` is `.optional()`; default to Text on read.** Zero migration. No `STORE_VERSION` bump. No `runMigrations` step. Pre-existing tables render + sort identically. |
| Q4 | Extraction | **Prompt + hints carry types.** Wire shape stays `{ columnId, value, citations }`. The model is steered per-column-type; extraction output schema is shape-stable. `extractionToCitationTable` fills `type: "text"` on write so newly-extracted artifacts are self-describing in localStorage. |
| Q5 | Scope | **Split into two slices.** Slice 1 (this doc): schema + sort + Number UI. Slice 2: Link + Date renderer (no sort change). |
| Arch | Module layout | **Centralised** in a new `lib/shared/artifacts/column-type.ts`. All type-aware pure logic lives there; `citation-table.ts` and `extract-table.ts` delegate. |

---

## Architecture

One new module + targeted changes to three existing files. The new module owns the type union, the cell parser, the validator, and the comparator; everything else either consumes or delegates.

```
lib/shared/artifacts/column-type.ts        (NEW — pure helpers + ColumnTypeSchema)
lib/shared/artifacts/column-type.test.ts   (NEW — one describe per helper)

lib/shared/artifacts/citation-table.ts      (MOD — schema gains optional type; addColumn gains type arg; sortRowOrder delegates)
lib/shared/artifacts/citation-table.test.ts (MOD — new describe blocks; existing assertions untouched)

lib/shared/artifacts/extract-table.ts      (MOD — ExtractionColumnSchema gains optional type; buildExtractTablePrompt accepts typed hints; extractionToCitationTable fills type on write)
lib/shared/artifacts/extract-table.test.ts  (NEW — prompt + extraction tests)

components/panels/citation-table.tsx       (MOD — header type pill; add-column dialog type picker; body cell TypedCell branch)
components/panels/extract-table-popover.tsx (MOD — chips carry { label, type })

app/api/extract-table/route.ts             (MOD — hints field widens to accept typed shape; string[] back-compat path)
```

Slice 2 widens `ColumnTypeSchema` to include `"link"` and `"date"` and adds renderer branches for each. Slice 1's signature for `validateCell` is intentionally future-proof (`(cell, type): string | null`) so slice 2 extends the helper without touching the renderer.

---

## Section 1 — Data model + pure helpers

### `lib/shared/artifacts/column-type.ts`

```ts
import { z } from "zod"

import type { CitationTableCell } from "./citation-table"

/** The set of column types shipped in slice 1. Slice 2 adds "link"
 *  and "date". */
export const COLUMN_TYPES = ["text", "number"] as const
export const ColumnTypeSchema = z.enum(COLUMN_TYPES)
export type ColumnType = (typeof COLUMN_TYPES)[number]

/** Resolve a column's effective type. Defaults to "text" when type
 *  is absent or unknown. Pure, never throws. */
export function resolveColumnType(col: { type?: string }): ColumnType {
  return (COLUMN_TYPES as readonly string[]).includes(col.type ?? "")
    ? (col.type as ColumnType)
    : "text"
}

/** Coerce a cell's string value to a sortable scalar for `type`.
 *  - "number" → Number.parseFloat(value), or NaN if not finite
 *  - "text" → raw string (passthrough)
 *  Empty string yields NaN for number (sorts last) and "" for text
 *  (sorts last via the existing localeCompare empty-cell rule).
 *  Never throws. */
export function parseCellValue(value: string, type: ColumnType): number | string {
  if (type === "number") {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : NaN
  }
  return value
}

/** Return a warning message when the cell value doesn't fit the
 *  declared type, or null when it does. The signature is stable
 *  across slices (slice 2 adds Link + Date branches without
 *  changing the renderer contract). Returns null for empty /
 *  missing cells (no warning to show for an empty cell). Slice 1
 *  uses `Number.parseFloat` for the Number branch, which is
 *  lenient: `parseFloat('1.2.3')` returns `1.2`, so validateCell
 *  returns null for that input rather than a warning. Slice 2 may
 *  tighten to a strict regex if the lenient parse becomes
 *  user-visible as a bug. */
export function validateCell(
  cell: CitationTableCell | undefined,
  type: ColumnType,
): string | null {
  if (!cell || cell.value === "") return null
  if (type === "number") {
    const n = Number.parseFloat(cell.value)
    if (Number.isFinite(n)) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a number: "${display}"`
  }
  return null
}

/** Type-aware comparator for sortRowOrder. NaN / empty sort last in
 *  BOTH directions (matches today's "empty cells sort last" rule).
 *  Stable for equal keys. "text" delegates to localeCompare. */
export function compareForSort(
  a: CitationTableCell | undefined,
  b: CitationTableCell | undefined,
  type: ColumnType,
  dir: "asc" | "desc",
): number {
  const sign = dir === "asc" ? 1 : -1
  const va = a?.value ?? ""
  const vb = b?.value ?? ""
  if (va === "" && vb === "") return 0
  if (va === "") return 1
  if (vb === "") return -1
  if (type === "number") {
    const na = Number.parseFloat(va)
    const nb = Number.parseFloat(vb)
    const aBad = !Number.isFinite(na)
    const bBad = !Number.isFinite(nb)
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return na === nb ? 0 : (na < nb ? -1 : 1) * sign
  }
  return va.localeCompare(vb) * sign
}
```

### `lib/shared/artifacts/citation-table.ts`

```ts
export const CitationTableColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  /** Slice 1: "text" | "number". Absent = "text". Slice 2 extends
   *  the union with "link" | "date". Existing un-typed blobs
   *  validate unchanged. */
  type: ColumnTypeSchema.optional(),
})
```

`addColumn(data, label, columnId, type: ColumnType = "text")` — gains an optional fourth arg defaulting to `"text"`. The internal `id` collision + 12-column cap behavior is unchanged; the `type` is just written through.

`sortRowOrder(data, columnId, dir, type: ColumnType = "text")` — gains an optional fourth arg. Implementation:

```ts
export function sortRowOrder(
  data: CitationTable,
  columnId: string,
  dir: "asc" | "desc",
  type: ColumnType = "text",
): number[] {
  return data.rows
    .map((_, i) => i)
    .sort((a, b) =>
      compareForSort(data.rows[a]?.[columnId], data.rows[b]?.[columnId], type, dir),
    )
}
```

The today's heuristic numeric sniff (`Number.isFinite(na) && Number.isFinite(nb)` inside the comparator) is **removed** in favor of explicit `compareForSort` delegation. For `type === "text"` the behavior is byte-identical to today (localeCompare on non-empty, empty sorts last in both directions).

### Backwards compatibility

- **No migration.** `type` is `.optional()`; existing blobs validate. `parseCitationTable` is unchanged.
- **No store version bump.** Persisted key set unchanged. `store/persist.test.ts` continues to pin the same keys.
- **No `runMigrations` step.** Existing un-typed columns keep working — they default to Text and sort exactly as today.
- **Wire shape unchanged.** `ExtractionCellSchema` keeps `{ columnId, value, citations }`.

---

## Section 2 — Renderer + edit affordances

### `components/panels/citation-table.tsx`

Three additions, all confined to editable mode. Read-only rendering (no `onChange`) is byte-identical to today.

**1. Header — type pill (per-column)**

A small `Type` button next to the column label, opens a `Popover` with `text` / `number` radio choices (slice 2 will extend the list). On select:

```ts
onChange({
  ...data,
  columns: data.columns.map((c) =>
    c.id === col.id ? { ...c, type: nextType } : c,
  ),
})
```

Right-align the column header text when `type === "number"` (matches numeric column convention). Sort arrow stays in place.

**Toggling a column's type** does NOT rewrite cell values. The raw `cell.value` string is preserved verbatim; the renderer just changes how it's displayed and sorted. Toggling Number → Text re-enables localeCompare sort and removes the inline warning glyph (cells whose values aren't finite numbers stop being "wrong"). Toggling Text → Number enables numeric sort and surfaces warnings for non-numeric cells. Cells are never coerced, truncated, or cleared by a type change.

**2. Add-column dialog — type picker**

The `Add column` modal grows from one input to two:

```
Label: [____________]
Type:  ( ) Text   ( ) Number      [Cancel]  [Add]
```

Default `Type: Text`. Submission calls `addColumn(data, label, columnId, selectedType)`. The existing `slugify` + `dedupeColumnId` logic stays untouched.

**3. Body cell — TypedCell wrapper**

The cell body branches on `resolveColumnType(col)`:

```tsx
function TypedCell({ col, cell, rowIndex, editable, onStartEdit, ... }) {
  const type = resolveColumnType(col)
  const warning = editable ? validateCell(cell, type) : null
  const isNumber = type === "number"

  return (
    <span className={isNumber ? "text-right" : undefined}>
      {isEditing ? (
        <input
          type={isNumber ? "number" : "text"}
          inputMode={isNumber ? "decimal" : undefined}
          autoFocus
          value={draft}
          onChange={...}
          onBlur={commit}
          onKeyDown={...}
          aria-label="Edit cell value"
          className="..."
        />
      ) : (
        <CellContent ... />  {/* today's component */}
      )}
      {warning ? (
        <span
          title={warning}
          aria-label={warning}
          className="ml-0.5 text-[var(--destructive)]"
        >
          ⚠
        </span>
      ) : null}
    </span>
  )
}
```

The `commit()` function keeps its `setCellValue(data, rowIndex, colId, draft)` call; the raw user input (including "two hundred" or "1.2.3") is stored verbatim. The warning glyph surfaces *only when* the user is in editable mode (read-only viewers don't see warnings).

### Untouched
- `CitationChips` popover (citation rendering).
- `CitationCellEditor` (citation editing).
- `×Row`, `×Column`, `+ Add row`, column drag-reorder, sort indicator — all unchanged.
- The read-only path (no `onChange`).

---

## Section 3 — Extraction prompt + hints

### `lib/shared/artifacts/extract-table.ts`

**1. `ExtractionColumnSchema` gains the optional `type`:**

```ts
export const ExtractionColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  /** Slice 1: "text" | "number". Absent = "text". The model does NOT
   *  emit this — it's set by `extractionToCitationTable` on write. */
  type: ColumnTypeSchema.optional(),
})
```

**2. `buildExtractTablePrompt` accepts typed hints:**

```ts
export type ExtractColumnHint = { label: string; type?: ColumnType }

export function buildExtractTablePrompt(
  reportText: string,
  sources: NumberedSource[],
  hints?: ExtractColumnHint[] | string[],   // string[] is the back-compat thin signature
): string
```

If the caller passes `string[]`, we normalize to `{ label: s, type: undefined }` and treat them all as Text. The function's emitted prompt renders the type suffix and per-type value-format instruction:

```
Required columns (use these labels and value formats exactly):
  - `Drug` (Text) — the entity's name as prose
  - `Sample size` (Number) — emit the bare numeric value only, no units ("200" not "two hundred")
  - `Launch date` (Date) — YYYY-MM-DD              ← slice 2
```

When `hints` is undefined or empty, the prompt is **byte-identical to today** (no type block, the "model decides 3–6 columns" path). When `hints` is non-empty, the prompt renders the exact-column path with type suffixes; today's `hints && hints.length > 0` branch is extended.

**3. `extractionToCitationTable` carries `type` through:**

```ts
return {
  columns: extraction.columns.map((c) => ({ ...c, type: c.type ?? "text" })),
  rows,
  sources: safeSources,
}
```

Newly-extracted artifacts (model didn't supply `type`) get filled on write so newly-extracted blobs are self-describing in localStorage. **Note**: this fill happens on *write*, not on *read*. `parseCitationTable` is unchanged — old blobs without `type` keep validating and resolve to Text on render via `resolveColumnType`. Pre-existing artifacts (rows of cells that don't reference `type`) keep working: their columns have no `type`, so `resolveColumnType` returns Text, and the renderer falls through to today's branch.

### `components/panels/extract-table-popover.tsx`

Chip state upgrades from `string[]` to `ExtractColumnHint[]`:

- Default seed (from `sourceTitles`): `[{ label: slug, type: "text" }]`.
- Adding a chip via Enter inserts with `type: "text"`. The chip renders a small `Text` pill next to the label; clicking the pill opens a dropdown to switch to `Number` (slice 2 adds `Link`, `Date`).
- Removing a chip filters by index (same logic as today).
- "Run extraction" passes the typed hints. "Let the model decide" still passes `undefined`.

### `app/api/extract-table/route.ts`

The route handler reads `hints` from the request body and normalizes:

```ts
const rawHints = body.hints as unknown
const hints: ExtractColumnHint[] | undefined =
  rawHints === undefined
    ? undefined
    : Array.isArray(rawHints)
      ? rawHints.map((h) =>
          typeof h === "string" ? { label: h } : { label: h.label, type: h.type },
        )
      : undefined
```

Old-shape clients (`hints: ["Drug", "Sample size"]`) keep working; new-shape clients (`hints: [{ label: "Drug", type: "text" }, { label: "Sample size", type: "number" }]`) get type-aware prompting.

### Backwards compatibility for the extraction path
- API client posting `hints: string[]` works (normalized to typed chips with `type: undefined`).
- Model extraction emitting columns *without* `type` still validates through `ExtractionSchema`. `extractionToCitationTable` fills `type: "text"` on write.
- The `body.hints` field on the wire accepts `string[]` OR `{ label: string; type?: ColumnType }[]` OR `undefined`. Anything else is rejected with a 400 (no silent coercion — the route validates the shape explicitly).

---

## Section 4 — Tests + scope boundaries

### `lib/shared/artifacts/column-type.test.ts` (NEW)

Five `describe` blocks, one per helper:

```
describe("resolveColumnType")
  test "returns 'text' when col.type is absent"
  test "returns 'text' when col.type is '' or unknown"
  test "returns the declared type when valid ('text' / 'number')"
  test "never throws"

describe("parseCellValue")
  test "'number' + '200' → 200 (number)"
  test "'number' + 'abc' → NaN"
  test "'number' + '' → NaN"
  test "'text' + anything → raw string (passthrough)"
  test "never throws"

describe("validateCell")
  test "returns null for empty cell"
  test "returns null for missing cell"
  test "returns null for valid number ('200')"
  test "returns a warning for invalid number ('two hundred')"
  test "returns a warning for invalid number ('1.2.3')"
  test "truncates the displayed value at 30 chars in the warning"
  test "returns null for 'text' + arbitrary value"

describe("compareForSort")
  test "numeric ascending (200 < 1000 numerically, not lexically)"
  test "numeric descending flips"
  test "NaN / empty sort last (both directions)"
  test "stable for equal keys"
  test "'text' delegates to localeCompare (matches today)"
  test "asc vs desc: empty cells sort last in both"
  test "does not throw on undefined inputs"

describe("ColumnTypeSchema")
  test "accepts 'text' and 'number'"
  test "rejects 'date' / 'link' / '' / 123"
```

### `lib/shared/artifacts/citation-table.test.ts` (MOD)

Three additions; **no existing assertion is removed**:

```
describe("addColumn with type")
  test "defaults type to 'text' when omitted (back-compat)"
  test "sets type='number' when supplied"
  test "returns input unchanged on duplicate columnId (type irrelevant)"
  test "returns input unchanged at the column cap (12)"

describe("sortRowOrder with type")
  test "defaults to text behavior when type omitted (regression guard)"
  test "numeric ascending when type='number'"
  test "numeric descending when type='number'"
  test "NaN / empty sort last for type='number' (both directions)"
  test "stable for equal keys with type='number'"
  test "does not mutate data (regression guard for the new path)"

test("parseCitationTable tolerates columns without type", () => {
  const obj = { columns: [{ id: "c", label: "C" }], rows: [], sources: [] }
  expect(parseCitationTable(JSON.stringify(obj))).not.toBeNull()
})
```

### `lib/shared/artifacts/extract-table.test.ts` (NEW)

```
describe("buildExtractTablePrompt")
  test "no hints → today's prompt unchanged (regression guard)"
  test "string[] hints still work (back-compat thin signature)"
  test "typed hints render the type suffix in the prompt"
  test "Number hints instruct 'emit bare numeric value, no units'"
  test "Text hints have no per-type instruction"
  test "mixed Text + Number hints render correctly"

describe("extractionToCitationTable")
  test "fills type:'text' on write when extraction omits type"
  test "carries type:'number' through when extraction supplies it"
  test "tolerates a column missing the type field"
  test "cells and citations are unaffected by the type fill"
```

### Untouched (explicit non-changes)

- `citation-table-md.ts` — markdown round-trip is shape-stable; column shape serializes via JSON unchanged.
- `components/editor/plugins/citation-table-kit.tsx` — no plugin change; the embedded editor-doc copy reads via `CitationTableView`.
- `components/ui/citation-table-node.tsx` — same reason.
- `store/persist.test.ts` — no new top-level keys; the contract test continues to pin the same persisted shape.
- `runMigrations` / `STORE_VERSION` — no migration needed; no version bump.
- The persisted-shape contract — frozen.

### Out of scope (explicit deferrals)

- **Link + Date types** — slice 2. The `ColumnTypeSchema` union intentionally ends at `["text", "number"]` here so slice 2 widens it via a `runMigrations`-free additive edit.
- **Persisted sort order** — separate item from the handoff menu.
- **Undo/redo** — separate item.
- **Row drag-reorder** — separate item.
- **Keyboard-accessible column reorder** — separate item (a11y gap from #227).

### Risks called out

- **Existing un-typed "Sample size"-style columns** will *not* suddenly sort numerically — they default to Text and behave identically to today. Users opt in by setting the column type via the header pill.
- **`sortRowOrder` signature widens** (gains an optional `type` arg). All existing callers (tests, the `CitationTableView` consumer) pass `undefined`; behavior is identical when `type` is absent because the helper defaults to Text. The existing `sortRowOrder` tests continue to pass.
- **The today's numeric sniff inside `sortRowOrder`** is removed; replaced by explicit `compareForSort` delegation when `type === "number"`. Text-typed columns use `localeCompare` exactly as before.
- **The extraction prompt gains a per-type instruction line** when typed hints are supplied. The model may still occasionally emit a value that doesn't match the type (e.g. "two hundred" for a Number column); `validateCell` surfaces the inline warning so the user can fix it.

### Verification

```
bun run check          # typecheck + lint — gates every prior slice
bun run test           # split runner — covers lib/, components/, app/api/ai
```

Manual browser pass:
1. Open the editor, click **Extract to table**.
2. Pick hints with mixed types (e.g. `Drug` (Text) + `Sample size` (Number)), run extraction.
3. Sort the resulting table by the Number column — confirm numeric order (`30, 200, 1000`, not `1000, 200, 30`).
4. Click the `Type` pill on an un-typed column → switch to Number → sort again, confirm numeric.
5. Type `two hundred` into a Number cell → confirm `⚠ Not a number: "two hundred"` appears.

---

## Estimated surface

- **New files (3):** `lib/shared/artifacts/column-type.ts`, `lib/shared/artifacts/column-type.test.ts`, `lib/shared/artifacts/extract-table.test.ts`.
- **Modified files (5):** `lib/shared/artifacts/citation-table.ts`, `lib/shared/artifacts/citation-table.test.ts`, `lib/shared/artifacts/extract-table.ts`, `components/panels/citation-table.tsx`, `components/panels/extract-table-popover.tsx`.
- **API contract change (1):** `app/api/extract-table/route.ts` — `hints` widens to accept the typed shape; old string-array shape continues to work.

Slice 2 widens `ColumnTypeSchema` to include `"link"` and `"date"` and adds renderer branches for each. No new persistence concerns; no schema migration.