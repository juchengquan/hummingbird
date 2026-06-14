# In-place citation editing — design (citation-table polish Slice D)

**Date:** 2026-06-14
**Status:** Approved (design gate passed)
**Arc:** Citation-table polish (follows Slice A column hints #221, Slice B
inline add/remove #222, Slice C row-remove #225)

## Goal

Make a cell's citation chips editable when the table is in editable mode.
Today clicking a `[n]` chip opens a **read-only** popover (source title +
quote). This slice lets the user, from that same surface:

- edit a citation's **quote**,
- re-point a citation to a different **existing** source,
- **remove** a citation,
- **add** a new citation to a cell.

## Decisions (from brainstorming)

- **Source binding: existing sources only.** Citations may only reference
  sources already in `data.sources` (chosen from a dropdown). Adding or
  managing sources is **out of scope** (a separate future slice).
- **Edit surface: edit-in-popover + an add affordance.** Reuse the chip
  popover (turn it into a small form) and add a `+ cite` trigger per
  cell. Not a per-cell modal, not inline rows.
- **No explicit Save button.** Commit-on-change (source select) and
  commit-on-blur (quote textarea), matching the existing cell-value
  editing pattern.
- **Native `<select>`** for the source picker (robust inside a Radix
  Popover; avoids the shadcn Select's focus-trap interactions).

## Data model & pure helpers (`lib/shared/artifacts/citation-table.ts`)

A citation is `{ sourceId, quote }` (`CitationSchema`); a cell holds
`citations: Citation[]` capped at 8 (`CellSchema`). Export the element
type and add three pure helpers, matching the file's existing
never-mutate contract (cf. `setCellValue`, `addRow`, `removeColumn`):

```ts
export type Citation = z.infer<typeof CitationSchema>

// Append `citation` to rows[rowIndex][columnId].citations. Creates the
// cell ({ value: "", citations: [citation] }) when absent. Capped at 8
// (returns `data` unchanged at cap). Out-of-range rowIndex (negative or
// >= rows.length) returns `data` unchanged. Pure.
export function addCitation(
  data: CitationTable, rowIndex: number, columnId: string, citation: Citation,
): CitationTable

// Replace sourceId and/or quote of the citation at citIndex via a
// partial patch. Missing cell, missing/empty citations, or out-of-range
// citIndex returns `data` unchanged. Out-of-range rowIndex returns
// `data` unchanged. Pure.
export function updateCitation(
  data: CitationTable, rowIndex: number, columnId: string,
  citIndex: number, patch: Partial<Citation>,
): CitationTable

// Remove the citation at citIndex. Missing cell or out-of-range citIndex
// returns `data` unchanged. Out-of-range rowIndex returns `data`
// unchanged. Pure.
export function removeCitation(
  data: CitationTable, rowIndex: number, columnId: string, citIndex: number,
): CitationTable
```

Helpers stay permissive (no length/empty validation) — consistent with
`setCellValue`. The schema validates on `parseCitationTable`; the UI
constrains inputs (valid `sourceId` from the dropdown, `maxLength` on the
quote field).

## UI

### New component: `components/panels/citation-cell-editor.tsx`

Follows `extract-table-popover.tsx` conventions (own file, `"use client"`
+ `import "client-only"`, local draft state, CSS-var styling). Narrow
interface — no coupling to the table internals:

```ts
function CitationCellEditor({
  sources,        // CitationTable["sources"] — for the dropdown + [n] index
  citations,      // the cell's current citations
  onAdd,          // (citation: Citation) => void
  onUpdate,       // (citIndex: number, patch: Partial<Citation>) => void
  onRemove,       // (citIndex: number) => void
}): JSX.Element
```

Renders:

- **One edit-popover per existing citation.** Trigger: the `[n]`
  superscript chip (`[?]` when the citation's `sourceId` isn't in
  `sources` — still clickable so it can be fixed/removed; today such
  citations vanish). Popover body:
  - native `<select>` of sources (`[i] title`), `value` = current
    `sourceId`, `onChange` → `onUpdate(i, { sourceId })`;
  - `<textarea>` for the quote, local draft, `maxLength={2000}`,
    `onBlur` → `onUpdate(i, { quote: draft })`;
  - **Remove** button → `onRemove(i)` + close.
- **Add trigger.** A subtle `+ cite` button after the chips, shown only
  when `sources.length > 0 && citations.length < 8`. Opens a popover
  with an empty form (source defaults to first source, empty quote) and
  an **Add** button → `onAdd({ sourceId, quote })` + close + reset.
- **Chip `key` is index-based** (`cit-${i}`), NOT `sourceId`-based, so
  re-pointing a source mid-edit doesn't remount and close the popover.

### Wiring in `components/panels/citation-table.tsx`

In `CellContent`, the editable branch renders `CitationCellEditor`
instead of the read-only `CitationChips`; the read-only branch is
unchanged. Because adding a citation must work on a cell that doesn't
exist yet, the editor renders even when `cell` is absent (passing
`cell?.citations ?? []`). `CitationTableView` supplies handlers that
close over `rowIndex` / `col.id`:

```tsx
onAdd={(c) => onChange(addCitation(data, rowIndex, col.id, c))}
onUpdate={(i, patch) => onChange(updateCitation(data, rowIndex, col.id, i, patch))}
onRemove={(i) => onChange(removeCitation(data, rowIndex, col.id, i))}
```

### Free elsewhere

The embedded editor-doc copy gains all of this automatically via the
shared `CitationTableView` + existing `onChange → updateArtifactContent`
wiring (same as Slices B/C).

## Testing

New pure logic ⇒ **TDD**. Add helper tests to
`lib/shared/artifacts/citation-table.test.ts`:

- `addCitation`: appends; **creates the cell when absent**; **8-cap**
  returns unchanged; out-of-range `rowIndex` returns `data`.
- `updateCitation`: patches `sourceId` only / `quote` only / both;
  missing cell, missing citations, out-of-range `citIndex`/`rowIndex`
  return `data`.
- `removeCitation`: removes the right index; out-of-range
  `citIndex`/`rowIndex` and missing cell return `data`.

No React component-test harness exists (consistent with Slices A–C), so
the UI is verified via `bun run check` + manual:

1. Artifacts tab: edit a quote, re-point a source (popover stays open),
   remove a citation, add one to an empty cell; `+ cite` hidden at the
   8-cap and when there are no sources.
2. Embedded editor-doc copy mirrors the edits.
3. Read-only render (no `onChange`) shows no editing controls.

## Files

- `lib/shared/artifacts/citation-table.ts` — `Citation` type + 3 helpers.
- `lib/shared/artifacts/citation-table.test.ts` — helper tests.
- `components/panels/citation-cell-editor.tsx` — **new** component.
- `components/panels/citation-table.tsx` — render the editor in the
  editable branch; pass handlers.

## Out of scope (deferred)

Adding/managing sources; editing a source's title/URL; reordering
citations; undo/redo; persisted sort. Each is a separate future slice.

## Risk

Low–moderate. The pure helpers are small and TDD-covered. The UI is a
self-contained new component reusing the established popover pattern; the
one subtlety (popover remount on source change) is addressed by
index-based chip keys.
