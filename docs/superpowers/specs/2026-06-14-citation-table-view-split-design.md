# Citation-table view — split god component into header + row subcomponents

**Status:** Draft — refactor only, no behaviour change. Identified during the 2026-06-14 architecture review as a Strong shallow-module candidate. Pure data layer (`lib/shared/artifacts/citation-table.ts`) is **untouched**; only the view fans the 9 mutators out to the wrong place today.

**Goal:** Split `components/panels/citation-table.tsx` (431 lines, 5 `useState` hooks, 9 inline `onChange` arrows) into `CitationTableHeader` + `CitationTableRow` subcomponents so each owns its own UI state, and so `CitationTableView` shrinks to the table shell + handler wiring.

---

## Decisions locked during brainstorming

| # | Decision | Choice |
|---|---|---|
| Q1 | Split shape | **Header + Row, not Header + Cell.** A row owns the edit input + the remove × + every cell it spans; cells inside it delegate to `CitationCellEditor` (which is already separate). Header owns sort + drag grip + remove-col × + add-col dialog. |
| Q2 | State ownership | **Lifted-state, not Redux.** `sort`, `editing`, `draft`, `dragFrom`, `dragOver`, `addColOpen`, `newColLabel` move to the child that needs them; `onChange`-related wiring lifts to `CitationTableView` as bound handlers passed via props. |
| Q3 | `CitationChips` location | **Stays inside `Row`.** It's per-cell render, and the cell is rendered by `Row`. (Currently at the top of the same file; moves to be a Row-private subcomponent.) |
| Q4 | `CellContent` location | **Stays inside `Row`.** It's the per-cell branch (editable vs read-only); Row owns which cell it's in. |
| Q5 | Dialog ownership | **Header.** `addColOpen`, `newColLabel`, `slugify`, `dedupeColumnId`, `submitAddColumn` all move into `CitationTableHeader`. The dialog is physically rendered by Header (not lifted to `View`). |
| Q6 | Drag handlers | **Header.** `dragFrom`, `dragOver`, the per-`<th>` `onDragOver`/`onDrop`, and the per-grip `onDragStart`/`onDragEnd` all live in Header. The "drop into column N → call `moveColumn`" wiring goes through an `onColumnDrop(from, to)` prop. |
| Q7 | Edit input | **Row.** `editing`, `draft`, `startEdit`, `commit`, the `<input>` JSX, and the per-cell "click to edit" `Button` all move into `CitationTableRow` (or a small `EditableCell` subcomponent inside Row — see Section 3). |
| Q8 | `onChange` API at the seam | **Same as today.** `CitationTableView({ data, onChange? })` is unchanged. Internal subcomponents receive pre-bound handlers (`onChange(moveColumn(data, from, to))`) — no leaking of the mutator choice to children. |
| Q9 | Citation mutator wiring | **`CitationTableRow` receives `onAddCitation` / `onUpdateCitation` / `onRemoveCitation` props** (currently inlined at lines 344-348). The 3 handlers are created once in `View` (where `data` is in scope) and passed down. |
| Q10 | Test strategy | **Existing snapshot-free, behaviour-only tests in `citation-table.test.ts` cover the pure layer.** No component tests today. This refactor doesn't add component tests — the visual smoke test is the next slice's `bun run check:ci` + a future manual browser pass. |

---

## Architecture

```
components/panels/citation-table.tsx       (MOD — shrunk to ~140 lines:
                                              CitationTableView shell + handler wiring
                                              + small re-exports of the helpers from
                                              citation-table.ts that View still uses
                                              directly: sortRowOrder + a new helper
                                              buildColumnHandlers(data, onChange))

components/panels/citation-table-header.tsx (NEW — header subcomponent:
                                                sort + drag + remove-col × + add-col
                                                dialog + per-header aria-sort)

components/panels/citation-table-row.tsx    (NEW — row subcomponent:
                                                edit input + remove-row × + CellContent
                                                (private) + CitationChips (private))
```

No data-layer changes. No new pure helpers (the existing `slugify` + `dedupeColumnId` stay in the file but are passed down, or move to `citation-table.ts` as pure helpers — **decision: move to `citation-table.ts`** as `slugifyColumnId(data, label)` so they're unit-testable next to the rest of the data layer. The existing `citation-table.test.ts` gets two new describes.)

---

## Section 1 — `CitationTableView` after

```ts
export function CitationTableView({
  data,
  onChange,
}: {
  data: CitationTable
  onChange?: (next: CitationTable) => void
}) {
  const editable = !!onChange
  const [sort, setSort] = useState<{ columnId: string; dir: "asc" | "desc" } | null>(null)

  const order = sort
    ? sortRowOrder(data, sort.columnId, sort.dir)
    : data.rows.map((_, i) => i)

  // Pre-bound handlers — created once per render, passed down.
  // View does not call any mutator directly; it just binds data → onChange.
  const handlers = editable ? buildColumnHandlers(data, onChange!) : null

  const onColumnDrop = (from: number, to: number) => {
    if (handlers) handlers.onMoveColumn(from, to)
  }

  const onRemoveRow = (rowIndex: number) => {
    if (handlers) {
      setEditing(null) // clear any in-progress edit
      onChange!(removeRow(data, rowIndex))
    }
  }

  const onRemoveColumn = (columnId: string) => {
    if (handlers) handlers.onRemoveColumn(columnId)
  }

  const onAddColumn = (label: string, columnId: string) => {
    if (handlers) handlers.onAddColumn(label, columnId)
  }

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <CitationTableHeader
            data={data}
            sort={sort}
            onSortChange={setSort}
            editable={editable}
            onRemoveColumn={onRemoveColumn}
            onAddColumn={onAddColumn}
            onColumnDrop={onColumnDrop}
          />
        </thead>
        <tbody>
          {order.map((rowIndex, displayIdx) => (
            <CitationTableRow
              key={`row-${rowIndex}`}
              data={data}
              rowIndex={rowIndex}
              displayIdx={displayIdx}
              editable={editable}
              onChange={onChange}
              onAddCitation={handlers?.onAddCitation}
              onUpdateCitation={handlers?.onUpdateCitation}
              onRemoveCitation={handlers?.onRemoveCitation}
              onRemoveRow={onRemoveRow}
            />
          ))}
        </tbody>
        {editable ? (
          <tfoot>
            <tr>
              <td colSpan={data.columns.length + 1} className="border border-[var(--border)] px-2 py-1 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handlers?.onAddRow()}
                  disabled={data.rows.length >= 200}
                  className="h-6 text-xs"
                >
                  + Add row
                </Button>
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}
```

Lines: ~70 (down from 431). The 5 useStates collapse to 1 (`sort`). The 9 inline arrows collapse to a single `buildColumnHandlers` call (Section 2).

---

## Section 2 — `buildColumnHandlers(data, onChange)`

A small pure-of-side-effects helper that returns an object of pre-bound handlers. Lives next to `View` in `citation-table.tsx` (no need for a separate file — it's pure JS-object-construction):

```ts
function buildColumnHandlers(
  data: CitationTable,
  onChange: (next: CitationTable) => void
) {
  return {
    onMoveColumn: (from: number, to: number) => onChange(moveColumn(data, from, to)),
    onRemoveColumn: (columnId: string) => onChange(removeColumn(data, columnId)),
    onAddColumn: (label: string, columnId: string) => onChange(addColumn(data, label, columnId)),
    onAddRow: () => onChange(addRow(data)),
    onAddCitation: (rowIndex: number, columnId: string, c: Citation) =>
      onChange(addCitation(data, rowIndex, columnId, c)),
    onUpdateCitation: (rowIndex: number, columnId: string, i: number, patch: Partial<Citation>) =>
      onChange(updateCitation(data, rowIndex, columnId, i, patch)),
    onRemoveCitation: (rowIndex: number, columnId: string, i: number) =>
      onChange(removeCitation(data, rowIndex, columnId, i)),
  }
}
```

This is the **single** place where the 9 mutators get bound to `onChange`. The rest of the view just plumbs the resulting handlers around.

(`onRemoveRow` is **not** in this object because it also clears `editing` state owned by `Row` — it stays inline in `View` for the same reason `onColumnDrop` is inline: it crosses state boundaries. Documented inline.)

---

## Section 3 — `CitationTableHeader`

Owns: `dragFrom`, `dragOver`, `addColOpen`, `newColLabel`, the sort + drag + remove-col × + add-col dialog.

```tsx
export function CitationTableHeader({
  data, sort, onSortChange,
  editable, onRemoveColumn, onAddColumn, onColumnDrop,
}: { ... }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [addColOpen, setAddColOpen] = useState(false)
  const [newColLabel, setNewColLabel] = useState("")

  const submitAddColumn = () => {
    const label = newColLabel.trim().slice(0, 120)
    if (!label) return
    const columnId = slugifyColumnId(data, label)
    onAddColumn(label, columnId)
    setNewColLabel("")
    setAddColOpen(false)
  }

  // ... sort + drag + ×col markup as today, just inline here ...
  return (
    <>
      <tr>
        {data.columns.map((col, colIndex) => (
          <th ... onDragOver={...} onDrop={...} drag handlers ... >
            ... grip + sort button + ×col ...
          </th>
        ))}
        {editable ? <th>...</th> : null}
      </tr>
      <Dialog open={addColOpen} onOpenChange={...}>
        ... add column dialog ...
      </Dialog>
    </>
  )
}
```

Rendered by `View` inside `<thead>`. The dialog is a sibling of the `<tr>` (or moved to a `<>` fragment so it can be the next sibling of `<thead>`); both are fine — `Dialog` portals to body so DOM position is irrelevant.

---

## Section 4 — `CitationTableRow`

Owns: `editing`, `draft`, the edit `<input>`, the per-cell "click to edit" trigger, `CellContent` + `CitationChips` (private), the per-row × button.

```tsx
export function CitationTableRow({
  data, rowIndex, displayIdx, editable, onChange,
  onAddCitation, onUpdateCitation, onRemoveCitation, onRemoveRow,
}: { ... }) {
  const [editing, setEditing] = useState<{ columnId: string } | null>(null)
  const [draft, setDraft] = useState("")

  const startEdit = (columnId: string, current: string) => {
    if (!editable) return
    setDraft(current)
    setEditing({ columnId })
  }

  const commit = (columnId: string) => {
    if (editing?.columnId === columnId && onChange) {
      onChange(setCellValue(data, rowIndex, columnId, draft))
    }
    setEditing(null)
  }

  // Edit clear on row remove is handled by React's unmount semantics.
  // `Row` is keyed by `rowIndex`; when `data.rows` shrinks, React
  // unmounts the removed row and its `editing` state disappears
  // automatically. No explicit `setEditing(null)` needed.

  return (
    <tr>
      {data.columns.map((col) => {
        const cell = data.rows[rowIndex]?.[col.id]
        const isEditing = editing?.columnId === col.id
        return (
          <td key={col.id} className="border border-[var(--border)] px-2 py-1 align-top">
            {isEditing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(col.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commit(col.id) }
                  else if (e.key === "Escape") { e.preventDefault(); setEditing(null) }
                }}
                aria-label="Edit cell value"
                className="w-full bg-[var(--background)] px-1 text-xs outline-none ring-1 ring-[var(--ring)]"
              />
            ) : (
              <CellContent
                data={data}
                cell={cell}
                editable={editable}
                onStartEdit={() => startEdit(col.id, cell?.value ?? "")}
                onAddCitation={(c) => onAddCitation?.(rowIndex, col.id, c)}
                onUpdateCitation={(i, patch) => onUpdateCitation?.(rowIndex, col.id, i, patch)}
                onRemoveCitation={(i) => onRemoveCitation?.(rowIndex, col.id, i)}
              />
            )}
          </td>
        )
      })}
      {editable ? (
        <td className="border border-[var(--border)] p-0 text-center align-top">
          <button
            type="button"
            aria-label={`Remove row ${displayIdx + 1}`}
            title="Remove row"
            onClick={() => onRemoveRow?.(rowIndex)}
            className="px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          >×</button>
        </td>
      ) : null}
    </tr>
  )
}
```

The "clear any in-progress edit before removal" invariant (current line 361-362) **goes away for free**: when a row is removed, React unmounts the `Row` and its `editing` state disappears. The `onRemoveRow` handler in `View` no longer needs `setEditing(null)`.

(If two rows could share `editing` state, that would be different. They don't — each `Row` owns its own. The refactor makes this more obvious, not less.)

---

## Section 5 — `CellContent` + `CitationChips`

Both stay private to `citation-table-row.tsx`. `CellContent` is unchanged; `CitationChips` is unchanged.

---

## Section 6 — Pure helpers moving to `citation-table.ts`

```ts
/** Slugify a column label for use as a column id; fall back to "column"
 *  for empty / all-punctuation input. Mirrors `defaultSlug` in
 *  store-helpers.ts but stays here so the column-dedupe dance is
 *  unit-testable next to the rest of the data layer. */
export function slugifyColumnId(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "column"
  )
}

/** Given an existing `CitationTable` and a desired base column id, return
 *  the base if unused, else append `-2`, `-3`, … until unused.
 *  Pathological fallback appends a timestamp. */
export function uniqueColumnId(data: CitationTable, base: string): string {
  if (!data.columns.some((c) => c.id === base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!data.columns.some((c) => c.id === candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
```

These replace the inline `slugify` (lines 171-177) and `dedupeColumnId` (lines 179-186) of the current file. `Header` calls them as `slugifyColumnId(label)` + `uniqueColumnId(data, slugifyColumnId(label))` in its `submitAddColumn`.

`citation-table.test.ts` gains two describe blocks:
- `describe("slugifyColumnId")` — empty, all-punctuation, mixed-case, leading/trailing dash, >60 char truncation.
- `describe("uniqueColumnId")` — first call returns base; second call with same base returns `${base}-2`; etc.

---

## Section 7 — Tests

### Unit (pure helpers, in `citation-table.test.ts`)
Two new describes (Section 6).

### Component (manual)
Out of scope. The architecture review explicitly noted: "Manual browser verification of the citation-table UI was NOT run by the agent for C/D/E … Each PR's Test Plan lists the manual pass as an unchecked reviewer/user step." This refactor preserves every behaviour; reviewers can do the manual pass during PR review as they did for #225/#226/#227.

### What does NOT change
- `citation-cell-editor.tsx` — untouched.
- `citation-table-node.tsx` (the Plate void node adapter) — untouched; it consumes `CitationTableView` unchanged.
- `citation-table-slash.ts`, `citation-table-md.ts`, `citation-table-kit.tsx`, `markdown-kit.tsx`, `editor/transforms.ts` — untouched.
- All other consumers (none call the view's internals).
- The persisted shape (no `STORE_VERSION` bump, no migration).

---

## Section 8 — Out of scope (explicit)

- **Persisted sort order** (handover's first remaining item) — separate spec.
- **Undo/redo** — separate spec.
- **Column types** — separate spec (`2026-06-14-citation-typed-columns-slice-1-design.md` already drafted; Slice 1 of 2).
- **Row drag-reorder** — separate spec, post-#227 menu item.
- **Keyboard-accessible column reorder** — separate spec; the close-the-a11y-gap item.
- **Citation editing in `CitationCellEditor`** — untouched.
- **`CitationTableView` becoming a generic `DataTableView`** — YAGNI; one consumer.

---

## Section 9 — Risks + mitigations

| Risk | Mitigation |
|---|---|
| Re-render churn from prop drilling | Pre-bound handlers via `buildColumnHandlers` mean new function identities on every render. Wrap in `useMemo` if perf becomes a problem. (Current code re-creates arrows inline — same cost.) |
| Loss of "clear any in-progress edit before removal" (current line 361-362) | The behaviour is preserved by React's unmount semantics — removing a row unmounts the `Row` and its `editing` state. The current `setEditing(null)` in `onRemoveRow` is a no-op given the unmount. |
| `Dialog` rendered outside `<thead>` | `Dialog` portals to `<body>` — DOM position is irrelevant. Rendering as a sibling of `<thead>` inside a `<>` fragment is fine. |
| `CellContent` / `CitationChips` visibility from `Row` (they're private) | `Row` exports them as named non-default exports so a future test or story can import them; they're not re-exported from `citation-table.tsx`. |
| `slugifyColumnId` behaviour diff from the inline `slugify` | New tests pin the exact behaviour; if a regression appears, the test diff shows it. The two existing call sites (`addColumn` doesn't exist; the inline call only happens once in the view) make the diff minimal. |

---

## Section 10 — Rollout

Single PR. All file changes land together so a regression bisects to one change.

1. Add `slugifyColumnId` + `uniqueColumnId` to `lib/shared/artifacts/citation-table.ts`; add the two new describes to `citation-table.test.ts`. Run `bun run check`.
2. Create `components/panels/citation-table-header.tsx` with the markup currently in lines 201-307 + 395-428.
3. Create `components/panels/citation-table-row.tsx` with the markup currently in lines 308-393 + the `CellContent` + `CitationChips` components (47-129).
4. Rewrite `citation-table.tsx` to ~70 lines as in Section 1.
5. Run `bun run check`. Visual smoke (the user has been doing this for C/D/E; do it again).

Branch: `refactor/citation-table-view-split`. Target: `dev`.

---

## Section 11 — Wins

- **Locality**: Header knows sort + drag + add-col. Row knows edit + remove-row + cells. A change to one doesn't open the other.
- **Leverage**: 9 mutator arrows → 1 `buildColumnHandlers` call. Adding a new mutator in the future is "add to `buildColumnHandlers`" + "thread the handler to the child that needs it" — two localised edits instead of one 431-line file.
- **Test surface**: the two new pure helpers (`slugifyColumnId`, `uniqueColumnId`) are unit-tested; the row + header UI is testable in isolation if/when component tests are added.
- **Readability**: `View` becomes "the table shell" — the next person reading the file sees the shape, not the details.
- **No behaviour change**: every existing affordance preserved; the "clear in-progress edit on remove" is now structural, not imperative.
- **Sets up future slices**: row drag-reorder (handover menu item) fits inside `Row` without touching Header; column-type UI (typed columns spec) touches Header's add-col dialog + Row's `<input>` — both already isolated.