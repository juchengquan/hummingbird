# Column reordering via drag handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users reorder citation-table columns by dragging a per-header grip in editable mode.

**Architecture:** A pure `moveColumn(data, fromIndex, toIndex)` helper permutes the `columns` array (rows are keyed by `columnId`, so cells follow automatically; columnId-keyed sort state survives). The header `<th>` is restructured to hold `[grip][sort-button]` siblings; the grip is the only draggable element and the `<th>` is the HTML5 drop target, with a drop-target highlight driven by two local state values.

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui. Pure helpers in `lib/shared/artifacts/citation-table.ts`. Tests: `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-14-citation-column-reorder-design.md`

---

## File Structure

- **Modify:** `lib/shared/artifacts/citation-table.ts` — add `moveColumn`.
- **Modify:** `lib/shared/artifacts/citation-table.test.ts` — `moveColumn` tests.
- **Modify:** `components/panels/citation-table.tsx` — header restructure (grip + drop handlers), `dragFrom`/`dragOver` state, `moveColumn` import.

Task 1 (helper + tests) lands first and is independent. Task 2 (UI) depends on Task 1's export.

---

### Task 1: `moveColumn` pure helper (TDD)

**Files:**
- Modify: `lib/shared/artifacts/citation-table.ts`
- Test: `lib/shared/artifacts/citation-table.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/shared/artifacts/citation-table.test.ts`, add `moveColumn` to the import (alphabetical — after `addRow`, before `parseCitationTable`):

```ts
import {
  addCitation,
  addColumn,
  addRow,
  moveColumn,
  parseCitationTable,
  removeCitation,
  removeColumn,
  removeRow,
  setCellValue,
  sortRowOrder,
  sourceIndex,
  updateCitation,
} from "./citation-table"
```

Append this describe block at the END of the file:

```ts
describe("moveColumn", () => {
  const t = () => ({
    columns: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    rows: [
      {
        a: { value: "1", citations: [] },
        b: { value: "2", citations: [] },
        c: { value: "3", citations: [] },
      },
    ],
    sources: [],
  })
  test("moves a column to the right", () => {
    const out = moveColumn(t() as never, 0, 2)
    expect(out.columns.map((c) => c.id)).toEqual(["b", "c", "a"])
  })
  test("moves a column to the left", () => {
    const out = moveColumn(t() as never, 2, 0)
    expect(out.columns.map((c) => c.id)).toEqual(["c", "a", "b"])
  })
  test("returns the input unchanged when fromIndex === toIndex", () => {
    const data = t()
    expect(moveColumn(data as never, 1, 1)).toBe(data)
  })
  test("returns the input unchanged for an out-of-range index", () => {
    const data = t()
    expect(moveColumn(data as never, 5, 0)).toBe(data)
    expect(moveColumn(data as never, 0, 5)).toBe(data)
    expect(moveColumn(data as never, -1, 0)).toBe(data)
  })
  test("does not mutate the input and leaves row cell data untouched", () => {
    const data = t()
    const before = JSON.stringify(data)
    const out = moveColumn(data as never, 0, 2)
    expect(out).not.toBe(data)
    expect(out.rows[0]).toEqual(data.rows[0])
    expect(JSON.stringify(data)).toBe(before)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./lib/shared/artifacts/citation-table.test.ts`
Expected: FAIL — `moveColumn` is not exported (import error / "not a function").

- [ ] **Step 3: Implement `moveColumn`**

Append at the END of `lib/shared/artifacts/citation-table.ts` (after the last helper):

```ts
/** Return a NEW CitationTable with the column at `fromIndex` moved to
 *  `toIndex` (spliced out, then spliced back in at `toIndex`), shifting
 *  the others. Out-of-range `fromIndex`/`toIndex` or
 *  `fromIndex === toIndex` returns `data` unchanged. Rows are untouched
 *  — cells are keyed by columnId, so they follow the new column order.
 *  Pure; never mutates the input. */
export function moveColumn(
  data: CitationTable,
  fromIndex: number,
  toIndex: number,
): CitationTable {
  const n = data.columns.length
  if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n) return data
  if (fromIndex === toIndex) return data
  const cols = [...data.columns]
  const [moved] = cols.splice(fromIndex, 1)
  cols.splice(toIndex, 0, moved)
  return { ...data, columns: cols }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./lib/shared/artifacts/citation-table.test.ts`
Expected: PASS — all new `moveColumn` tests green; existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/citation-table.ts lib/shared/artifacts/citation-table.test.ts
git commit -m "$(cat <<'EOF'
feat(citation-table): pure moveColumn helper

Permutes the columns array (cells follow via columnId keys); out-of-range
and from===to return data unchanged, mirroring the existing helper
contract. TDD-covered. Backs column reordering (Slice E).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Header drag-to-reorder UI

**Files:**
- Modify: `components/panels/citation-table.tsx`

- [ ] **Step 1: Add `moveColumn` to the artifacts import**

In `components/panels/citation-table.tsx`, add `moveColumn` to the import from `@/shared/artifacts/citation-table` (alphabetical — after `addRow`, before `removeCitation`). The value imports become:

```tsx
  addCitation,
  addColumn,
  addRow,
  moveColumn,
  removeCitation,
  removeColumn,
  removeRow,
  setCellValue,
  sortRowOrder,
  sourceIndex,
  updateCitation,
```

(Leave the three `type` imports at the top of the block unchanged.)

- [ ] **Step 2: Add the drag state**

In `CitationTableView`, immediately AFTER the line `const [draft, setDraft] = useState("")`, add:

```tsx
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
```

- [ ] **Step 3: Restructure the per-column header**

In `<thead>`, replace the entire first `data.columns.map(...)` block — the one that returns each per-column `<th>`. The CURRENT block is:

```tsx
            {data.columns.map((col) => {
              const active = sort?.columnId === col.id
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={
                    active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className="border border-[var(--border)] bg-[var(--muted)] p-0 text-left font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.id)}
                    className="flex w-full items-center gap-1 px-2 py-1 hover:bg-[var(--accent)]"
                  >
                    {col.label}
                    {active ? <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span> : null}
                    {editable ? (
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Remove column ${col.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (onChange) onChange(removeColumn(data, col.id))
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            e.stopPropagation()
                            if (onChange) onChange(removeColumn(data, col.id))
                          }
                        }}
                        className="ml-auto cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      >
                        ×
                      </span>
                    ) : null}
                  </button>
                </th>
              )
            })}
```

Replace it ENTIRELY with (changes: `(col, colIndex)`; drop handlers + highlight on the `<th>`; a flex `<div>` wrapping a new grip `<span>` + the unchanged sort `<button>`):

```tsx
            {data.columns.map((col, colIndex) => {
              const active = sort?.columnId === col.id
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={
                    active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                  onDragOver={
                    editable
                      ? (e) => {
                          e.preventDefault()
                          setDragOver(colIndex)
                        }
                      : undefined
                  }
                  onDrop={
                    editable
                      ? (e) => {
                          e.preventDefault()
                          if (dragFrom !== null && onChange) {
                            onChange(moveColumn(data, dragFrom, colIndex))
                          }
                          setDragFrom(null)
                          setDragOver(null)
                        }
                      : undefined
                  }
                  className={`border border-[var(--border)] ${
                    editable && dragOver === colIndex
                      ? "bg-[var(--accent)]"
                      : "bg-[var(--muted)]"
                  } p-0 text-left font-medium`}
                >
                  <div className="flex items-stretch">
                    {editable ? (
                      <span
                        draggable
                        onDragStart={() => setDragFrom(colIndex)}
                        onDragEnd={() => {
                          setDragFrom(null)
                          setDragOver(null)
                        }}
                        aria-label={`Reorder column ${col.label}`}
                        title="Drag to reorder"
                        className="flex cursor-grab items-center px-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      >
                        ⠿
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => toggleSort(col.id)}
                      className="flex w-full items-center gap-1 px-2 py-1 hover:bg-[var(--accent)]"
                    >
                      {col.label}
                      {active ? (
                        <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span>
                      ) : null}
                      {editable ? (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`Remove column ${col.label}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (onChange) onChange(removeColumn(data, col.id))
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              if (onChange) onChange(removeColumn(data, col.id))
                            }
                          }}
                          className="ml-auto cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        >
                          ×
                        </span>
                      ) : null}
                    </button>
                  </div>
                </th>
              )
            })}
```

Notes for the implementer:
- The grip `<span>` is a **sibling** of the sort `<button>` (both inside the flex `<div>`), so grabbing it never toggles sort or hits the `×`.
- The `<th>` uses a single conditional `bg-` class (`accent` when hovered during a drag, else `muted`) — do NOT add a second `bg-` utility, which would race with the base one.
- Do NOT change the trailing `+Column` `<th>` (the `editable ? (<th aria-label="Add column">…) : null` block right after this map) — it is not a drop target.

- [ ] **Step 4: Typecheck + lint + the split test run**

Run: `bun run check`
Expected: typecheck 0 errors, lint 0 errors, split test run all pass / 0 fail (the `error: postgres unreachable` trace from `route.handler.test.ts:240` is an intentional throw inside a passing test — counts stay `0 fail`). If real errors appear, fix and re-run until green.

- [ ] **Step 5: Manual verification** (controller does the browser check; implementer skips this step)

In the Artifacts tab on an editable citation table:
- Drag a header grip onto another header → columns reorder; the hovered header highlights during the drag; each column's cells move with it.
- Activate a column sort, then reorder → the sort stays on the same column.
- Confirm the embedded editor-doc copy mirrors the new order, and a read-only render shows no grips (and can't reorder).

- [ ] **Step 6: Commit**

```bash
git add components/panels/citation-table.tsx
git commit -m "$(cat <<'EOF'
feat(citation-table): drag-to-reorder columns (polish Slice E)

Per-header ⠿ grip (editable mode) as the sole draggable element; the th
is the HTML5 drop target, calling moveColumn on drop with a drop-target
highlight. Grip sits beside the sort button so it never conflicts with
sort/×. columnId-keyed sort + cells survive a reorder. Embedded editor
copy gains it free via the shared CitationTableView.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Drag-handle grip per header, editable-only, sole draggable → Task 2 Step 3. ✓
- Header cell is the drop target; `onDrop` → `moveColumn(data, dragFrom, colIndex)` → Task 2 Step 3. ✓
- Drop-target highlight via `dragOver` state → Task 2 Steps 2 + 3. ✓
- `moveColumn` permutes columns; rows untouched; from===to + out-of-range → unchanged → Task 1 Step 3 + tests Step 1. ✓
- Active sort survives (columnId-keyed) / cells follow (body iterates columns) → no code needed; verified Task 2 Step 5. ✓
- Sort button + `×`-remove unchanged → preserved verbatim in Task 2 Step 3 replacement. ✓
- Trailing `+Column` th untouched / not a drop target → Task 2 Step 3 note. ✓
- Embedded copy free; read-only shows no grips → editable-gated grip; verified Step 5. ✓
- TDD helper tests (move L/R, no-op, out-of-range, no-mutation, rows untouched) → Task 1 Step 1. ✓

No spec requirement is left without a task.

**2. Placeholder scan:** No TBD/TODO/vague steps; every code step shows complete code. ✓

**3. Type consistency:** `moveColumn(data, fromIndex, toIndex)` (Task 1) matches the call site `moveColumn(data, dragFrom, colIndex)` (Task 2 Step 3) — `dragFrom: number` (narrowed by the `dragFrom !== null` guard), `colIndex: number`. `dragFrom`/`dragOver` are `number | null`, set via `setDragFrom`/`setDragOver` and reset consistently on drop/dragEnd. `colIndex` is introduced by the `(col, colIndex)` map signature and used in the drop/highlight logic. ✓
