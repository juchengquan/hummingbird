# Citation-table row-remove affordance — design (polish Slice C)

**Date:** 2026-06-14
**Status:** Approved (design gate passed)
**Arc:** Citation-table polish (follow-on to Slice A column hints #221, Slice B inline add/remove #222)

## Goal

Close the add/remove symmetry gap in the interactive citation table.
`CitationTableView` already offers `+Row`, `+Column`, and `×Column`, but
there is **no `×Row`**. The pure `removeRow(data, rowIndex)` helper
already exists and is tested (`lib/shared/artifacts/citation-table.ts`,
covered in `citation-table.test.ts:189-202`). This slice is **UI wiring
only** — no new pure logic.

## Non-goals (explicitly deferred)

- Undo/redo (separate deferred polish item).
- Confirmation dialog before delete — `×Column` deletes immediately;
  `×Row` matches it.
- A min-row guard. `rows: []` is schema-valid (`rows` has no `min`).
- Fixing `removeColumn`'s lack of a min-1-column guard — pre-existing,
  separate concern, out of scope.

## Design

### Placement — trailing actions cell

Add a trailing **actions `<td>`** to each `<tbody>` row, rendered **only
in editable mode** (`editable === true`, i.e. an `onChange` was passed),
aligned directly under the existing trailing `+Column` header `<th>`.

This mirrors the column model spatially: column actions live in the
header strip; row actions live in a trailing strip. The layout already
accommodates this trailing column with no width change:

- `thead` already renders a trailing `+Column` `<th>` (editable-gated).
- `tfoot`'s `+Row` cell already spans `colSpan = columns.length + 1`.
- `tbody` rows currently render `columns.length` cells (one short of the
  header); this slice adds the missing trailing cell in editable mode.

Read-only mode renders no trailing `<th>`/`<td>`/`tfoot` — unchanged.

### The control

A real `<button type="button">` (the cell is not nested inside another
button, unlike the column `×` which had to be a `role="button"` span):

```
aria-label={`Remove row ${displayPosition}`}
onClick={() => { setEditing(null); onChange(removeRow(data, rowIndex)) }}
```

- **Always-visible**, muted styling consistent with `×Column`:
  `text-[var(--muted-foreground)] hover:text-[var(--foreground)]`,
  centered in a bordered cell matching the table
  (`border border-[var(--border)]`).
- Glyph: `×`.

### Correctness details

- **Sort-safe.** Rows render in sorted display `order`, but the
  `tbody` map already yields the **original** `rowIndex` (the value
  inside `order`), which is exactly what `removeRow` expects. Removing
  under an active sort deletes the right row.
- **Clear in-progress edit.** The handler calls `setEditing(null)`
  before `onChange`, so a stale `{rowIndex}` can't point at the wrong
  row after the array reindexes.
- **Immediate delete.** No confirm — matches `×Column`.

### Embedded Plate copy — free

`CitationTableView` is the single shared renderer. The embedded editor
node already wires `onChange → updateArtifactContent`, so the in-document
copy gains `×Row` automatically (identical to how Slice B's affordances
appeared in both places).

## Files touched

- `components/panels/citation-table.tsx` — add the trailing actions cell
  + `×Row` button; import `removeRow`. **One file.**
- `removeRow` is already exported from
  `lib/shared/artifacts/citation-table.ts` — no change there.

## Testing

No new pure logic, so no new helper test is warranted — `removeRow` is
already covered (removes the row; out-of-range returns `data`
unchanged). There is **no React component-test harness** in the repo for
this component (Slices A/B's UI affordances were likewise verified via
helper tests + the `bun run check` gate + manual checks, not component
tests). Adding a harness for a single button would be disproportionate.

Verification for this slice:

1. `bun run check` — typecheck + lint + the split test run, all green.
2. Manual: in the Artifacts tab, `×Row` removes the correct row,
   including while a column sort is active; confirm the embedded
   editor-doc copy gained the same affordance and stays in sync.

## Risk

Minimal — single-file additive UI change reusing a tested pure helper,
mirroring an established affordance (`×Column`).
