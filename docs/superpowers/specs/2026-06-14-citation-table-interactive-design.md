# Interactive citation table (sort + edit) — Slice 3 — Design

Status: **approved design — ready for implementation plan.**
Origin: sub-project 3 of the Elicit-style extraction tables (`docs/PLAN-cross-product-inspirations.md` §9). Slice 1 (render) shipped #212; Slice 2 (generate) shipped #213. This slice makes the rendered table **interactive**: column sorting + in-cell value editing. The novel Plate-embed piece is split out as a separate later slice (slice 4).

## Why

The shipped `CitationTableView` is read-only. Elicit's value is a **sortable, editable** dossier: sort the grid by any attribute, and fix/refine extracted values in place. This slice adds both to the existing Artifacts-tab renderer, persisting edits via the existing artifact sync.

## Scope

- **In:** click-to-sort columns (view-state); click-to-edit cell **values** (persisted); a new `updateArtifactContent` store mutator; the renderer made interactive (store-agnostic via an `onChange` prop).
- **Out (later):** Plate-embed (slice 4); add/remove rows or columns; editing citations; persisted sort order; undo/redo.

## Pure logic — extend `lib/shared/artifacts/citation-table.ts`

Two pure functions hold the real logic (tested):

```ts
/** Display order (array of original row indices) when sorting by `columnId`.
 *  Numeric-aware: if both cell values parse as finite numbers, compare
 *  numerically; otherwise `localeCompare`. Missing cells / empty values sort
 *  last. `dir` flips the comparison. Stable for equal keys (preserves
 *  original order). Does NOT mutate `data`. */
export function sortRowOrder(
  data: CitationTable,
  columnId: string,
  dir: "asc" | "desc",
): number[]

/** Return a NEW CitationTable with `rows[rowIndex][columnId].value` replaced
 *  by `value` (citations preserved; a previously-absent cell is created with
 *  empty citations). Out-of-range `rowIndex` → returns `data` unchanged.
 *  Pure, never mutates the input. */
export function setCellValue(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  value: string,
): CitationTable
```

`sortRowOrder` returns indices (not reordered rows) so sorting stays view-only and an edit can map a displayed row back to its original `data.rows` index.

## Store mutator — `lib/client/hooks/store/slices/artifacts.ts`

A new `updateArtifactContent(artifactId: string, content: string): void`, mirroring the existing `updateArtifactTitle` exactly (set the field on the matching artifact; artifacts have no `updatedAt`, so none is bumped — same as `updateArtifactTitle`):

```ts
  updateArtifactContent: (artifactId, content) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, content } : a,
      ),
    })),
```

Add it to the `ArtifactsSlice` interface too. Artifact `content` is already synced (`diffArtifacts` compares `a.content === b.content` and the upsert row carries `content`), so an edit round-trips to cloud with no sync change. No persisted-key change (`content` is already persisted) → no `persist.test.ts` / migration impact. Not separately unit-tested — it's a trivial mirror of the untested `updateArtifactTitle`; the testable logic lives in the pure helpers.

## Renderer — `components/panels/citation-table.tsx` (made interactive, store-agnostic)

`CitationTableView` gains an optional prop:

```ts
export function CitationTableView({
  data,
  onChange,
}: {
  data: CitationTable
  onChange?: (next: CitationTable) => void
})
```

- **Sorting (always on):** local state `{ columnId: string; dir: "asc" | "desc" } | null`. Each `<th>` is a button: clicking sorts by that column (asc); clicking the active column toggles `dir`. A small ▲/▼ marks the active column. The body renders rows in `sortRowOrder(data, columnId, dir)` order (or original order when unsorted). Sorting never calls `onChange`.
- **Editing (only when `onChange` is provided):** local state `editing: { rowIndex: number; columnId: string } | null` (rowIndex is the **original** index, resolved from the display order). Clicking a cell's value enters edit mode → an inline `<input>` (value seeded from the cell) → **Enter or blur commits** `onChange(setCellValue(data, rowIndex, columnId, inputValue))`, **Escape cancels**. Only one cell edits at a time. Citation chips stay read-only beside the value. When `onChange` is absent, cells are plain text (today's read-only behavior — reusable by the future Plate-embed).

## Wiring — `components/panels/artifacts-tab.tsx`

The `'table'` dispatch branch passes `onChange`:
```tsx
<CitationTableView
  data={table}
  onChange={(next) => updateArtifactContent(artifact.id, JSON.stringify(next))}
/>
```
(`updateArtifactContent` from the store, like the existing `createArtifact`/`updateArtifactTitle` selectors used in this file's surrounding components.)

## Error handling

- Edit commit on an out-of-range row (shouldn't happen) → `setCellValue` returns `data` unchanged → harmless.
- Sort over a column some rows don't have a cell for → those rows sort last (empty key), no crash.
- A no-op edit (value unchanged) still calls `onChange` with an equal-content table; `JSON.stringify` is identical → the store map produces an equal artifact → sync's content compare sees no change. Harmless (optionally short-circuit if `value === current`, minor).

## Testing

- **Pure** (`lib/shared/artifacts/citation-table.test.ts`, extend): `sortRowOrder` — numeric-aware ordering (`"200" < "1000"` numerically, not lexically), asc/desc flip, stability on ties, missing/empty cells last, no mutation of `data`. `setCellValue` — replaces the target value, preserves that cell's citations, creates an absent cell with empty citations, leaves other cells/rows untouched, out-of-range rowIndex returns input unchanged, returns a new object (no mutation).
- **Renderer + mutator + wiring:** `bun run typecheck && bun run lint` (the renderer interactivity is thin glue over the tested pure helpers; the mutator mirrors the untested `updateArtifactTitle`).

## Touch-point summary

| File | Change |
|---|---|
| `lib/shared/artifacts/citation-table.ts` | `sortRowOrder` + `setCellValue` (pure) |
| `lib/shared/artifacts/citation-table.test.ts` | tests for both |
| `lib/client/hooks/store/slices/artifacts.ts` | `updateArtifactContent` mutator + interface |
| `components/panels/citation-table.tsx` | sort state + headers, edit state + inline input, `onChange` prop |
| `components/panels/artifacts-tab.tsx` | pass `onChange` to `CitationTableView` |

## Scope

**M.** Two pure helpers + tests (the real logic), a one-line store mutator, the renderer made interactive, one wiring line. No new deps, no migration, no persisted-shape change. Reuses Slice 1's schema; Slice 2 untouched.
