# Column reordering via drag handle — design (citation-table polish Slice E)

**Date:** 2026-06-14
**Status:** Approved (design gate passed)
**Arc:** Citation-table polish (follows Slice C row-remove #225, Slice D
in-place citation editing #226)

## Goal

Let the user reorder citation-table columns by dragging a per-header grip
when the table is in editable mode.

## Decisions (from brainstorming)

- **Interaction: drag handle (grip).** A dedicated `⠿` grip in each
  header is the only `draggable` element; the header cell is the drop
  target (HTML5 DnD). This isolates dragging from the sort-toggle click
  and the `×`-remove control, so nothing mis-triggers.
- **Include a drop-target highlight** (hovered header gets a light
  background) rather than a no-feedback drop.
- **Defer keyboard-accessible reorder.** Native HTML5 DnD is not
  keyboard-operable; this is a known limitation for this slice (a future
  slice could add arrow-key / move-left-right buttons).

## Pure helper (`lib/shared/artifacts/citation-table.ts`)

```ts
/** Return a NEW CitationTable with the column at `fromIndex` moved to
 *  `toIndex` (splice the column out, then splice it back in at
 *  `toIndex`), shifting the others. Out-of-range `fromIndex`/`toIndex`
 *  or `fromIndex === toIndex` returns `data` unchanged. Rows are
 *  untouched — cells are keyed by `columnId`, so they follow the new
 *  column order automatically. Pure; never mutates the input. */
export function moveColumn(
  data: CitationTable,
  fromIndex: number,
  toIndex: number,
): CitationTable
```

Implementation:

```ts
const cols = [...data.columns]
const [moved] = cols.splice(fromIndex, 1)
cols.splice(toIndex, 0, moved)
return { ...data, columns: cols }
```

**Drop semantics.** Dropping a dragged column *onto* the column at index
*j* lands it at index *j* and shifts the rest. Dropping onto the last
column sends it to the end, so no separate "drop at the end" zone is
needed. `moveColumn` changes ONLY the `columns` array order; `rows`
(maps keyed by `columnId`) are returned untouched.

## Header UI (`components/panels/citation-table.tsx`)

Restructure each header `<th>`'s child from a bare sort `<button>` into a
flex `<div>` holding `[grip][sort-button]` as **siblings**:

- **Grip** (`⠿`, rendered only when `editable`): the only `draggable`
  element. `onDragStart` records the dragged column index in `dragFrom`
  state; `cursor-grab`; `aria-label={`Reorder column ${col.label}`}`.
  Because it is a sibling of the sort button (not nested), grabbing it
  never toggles sort or hits the `×`-remove.
- **Drop target** is the wrapping `<div>` (covers the whole header cell):
  - `onDragOver` → `e.preventDefault()` + `setDragOver(colIndex)`,
  - `onDrop` → `e.preventDefault()`; if `dragFrom != null`,
    `onChange(moveColumn(data, dragFrom, colIndex))`; then reset.
  - These handlers are attached only in `editable` mode.
- **Drop indicator:** while `dragOver === colIndex`, the header gets a
  light `bg-[var(--accent)]` so the landing slot is visible.
- **State:** two local pieces — `dragFrom: number | null`,
  `dragOver: number | null` — both reset on `onDragEnd` and on drop.
- The sort `<button>` keeps `w-full` and every current behavior
  (toggle-sort, arrow, `×`-remove). The trailing `+Column` th is
  unchanged and is not a drop target.

### Interactions that just work

- **Active sort survives a reorder** — sort state is keyed by
  `columnId`, not position.
- **Cells follow** — the body iterates `data.columns`, so reordering the
  array reorders the rendered cells.

## Free elsewhere

The embedded editor-doc copy gains reordering via the shared
`CitationTableView` + existing `onChange → updateArtifactContent` wiring
(same as Slices C/D).

## Testing

New pure logic ⇒ **TDD**. Add `moveColumn` tests to
`lib/shared/artifacts/citation-table.test.ts`:

- moves a column right (e.g. index 0 → 2) and left (e.g. 2 → 0),
- `fromIndex === toIndex` returns `data` unchanged,
- out-of-range `fromIndex`/`toIndex` returns `data` unchanged,
- does not mutate the input,
- leaves `rows` / cell data untouched (cells keyed by columnId).

No React component-test harness exists (consistent with Slices A–D), so
the drag UI is verified via `bun run check` + manual:

1. Artifacts tab: drag a header grip to reorder; the drop-target
   highlight shows; columns and their cells move together.
2. Activate a column sort, then reorder — the sort stays on the same
   column.
3. Embedded editor-doc copy mirrors the new order.
4. Read-only render (no `onChange`) shows no grips and cannot reorder.

## Files

- `lib/shared/artifacts/citation-table.ts` — `moveColumn`.
- `lib/shared/artifacts/citation-table.test.ts` — `moveColumn` tests.
- `components/panels/citation-table.tsx` — header restructure + drag
  state/handlers + import.

## Out of scope (deferred)

Keyboard-accessible reorder (native DnD a11y gap), row drag-reorder,
animated transitions, persisted sort order.

## Risk

Low–moderate. `moveColumn` is a tiny TDD-covered permutation. The drag
UI is contained to the header row; the grip-as-sole-draggable-sibling
keeps it from conflicting with the existing sort/`×` controls.
