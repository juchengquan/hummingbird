# Citation-Table View Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 431-line god view `components/panels/citation-table.tsx` into a thin `CitationTableView` shell + `CitationTableHeader` + `CitationTableRow` subcomponents. No behaviour change.

**Architecture:** Two new files (`citation-table-header.tsx`, `citation-table-row.tsx`); `citation-table.tsx` shrinks from 431 lines to ~70 lines and only owns the table shell + the handler-wiring closure. Two pure helpers (`slugifyColumnId`, `uniqueColumnId`) move into `lib/shared/artifacts/citation-table.ts` and get unit tests. The 9 inline `onChange` arrows in `View` collapse into one `buildColumnHandlers(data, onChange)` call.

**Tech Stack:** React 19, TypeScript 5.x, bun:test. No new deps.

---

## File Structure

| File | Change |
|---|---|
| `lib/shared/artifacts/citation-table.ts` | MOD — add `slugifyColumnId` + `uniqueColumnId` exports |
| `lib/shared/artifacts/citation-table.test.ts` | MOD — add 2 describes (one per helper) |
| `components/panels/citation-table.tsx` | MOD — shrink to ~70 lines: View + `buildColumnHandlers` |
| `components/panels/citation-table-header.tsx` | NEW — Header subcomponent + Dialog |
| `components/panels/citation-table-row.tsx` | NEW — Row subcomponent + private `CellContent` + `CitationChips` |

No consumers of `CitationTableView` change (its props are unchanged). `citation-table-node.tsx` (the Plate void node adapter) and `citation-cell-editor.tsx` are untouched.

---

## Task 1: Add `slugifyColumnId` + `uniqueColumnId` + tests

**Files:**
- Modify: `lib/shared/artifacts/citation-table.ts` (append after the existing helpers, before any final export)
- Modify: `lib/shared/artifacts/citation-table.test.ts` (append two describes)

- [ ] **Step 1: Add `slugifyColumnId` to the pure-data module**

Append to `lib/shared/artifacts/citation-table.ts` (after the last existing helper, e.g. after `sourceIndex` / `removeCitation`):

```ts
/** Slugify a column label into a column id. Lowercases, collapses
 *  non-alphanumerics to single dashes, trims leading/trailing dashes,
 *  truncates to 60 chars. Empty / all-punctuation input returns
 *  "column" so the caller always gets a valid id. */
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

/** Given an existing `CitationTable` and a desired base column id,
 *  return the base if unused, else append `-2`, `-3`, … until unused.
 *  Pathological fallback (all 1000 numeric suffixes taken) appends a
 *  timestamp so we never collide. */
export function uniqueColumnId(
  data: CitationTable,
  base: string,
): string {
  if (!data.columns.some((c) => c.id === base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!data.columns.some((c) => c.id === candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
```

- [ ] **Step 2: Add the two test describes**

Append to `lib/shared/artifacts/citation-table.test.ts`:

```ts
describe("slugifyColumnId", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyColumnId("Column Label")).toBe("column-label")
  })
  test("trims leading and trailing dashes", () => {
    expect(slugifyColumnId("  --Hello-- ")).toBe("hello")
  })
  test("falls back to 'column' for empty input", () => {
    expect(slugifyColumnId("")).toBe("column")
    expect(slugifyColumnId("   ")).toBe("column")
    expect(slugifyColumnId("!!!")).toBe("column")
  })
  test("truncates to 60 chars", () => {
    const long = "a".repeat(100)
    expect(slugifyColumnId(long).length).toBe(60)
  })
})

describe("uniqueColumnId", () => {
  const emptyTable: CitationTable = {
    columns: [],
    rows: [],
    sources: [],
  }

  test("returns base if unused", () => {
    expect(uniqueColumnId(emptyTable, "price")).toBe("price")
  })

  test("appends -2 when base is taken", () => {
    const t: CitationTable = {
      ...emptyTable,
      columns: [{ id: "price", label: "Price" }],
    }
    expect(uniqueColumnId(t, "price")).toBe("price-2")
  })

  test("appends -3 when base and -2 are taken", () => {
    const t: CitationTable = {
      ...emptyTable,
      columns: [
        { id: "price", label: "Price" },
        { id: "price-2", label: "Price 2" },
      ],
    }
    expect(uniqueColumnId(t, "price")).toBe("price-3")
  })
})
```

(Imports `slugifyColumnId` and `uniqueColumnId` are already added by Step 1 — add them to the existing import line in the test file.)

- [ ] **Step 3: Run the new tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/shared/artifacts/citation-table.test.ts`
Expected: PASS, with the new tests added.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/shared/artifacts/citation-table.ts lib/shared/artifacts/citation-table.test.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(citation-table): extract slugifyColumnId + uniqueColumnId

Pure helpers move from components/panels/citation-table.tsx into
the shared data layer where they're testable next to the rest of
the citation-table module. View will use them via the Header
subcomponent (next commits).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create `CitationTableHeader`

**Files:**
- Create: `components/panels/citation-table-header.tsx`

- [ ] **Step 1: Write the file**

Create `components/panels/citation-table-header.tsx`:

```tsx
"use client"
import "client-only"

/**
 * Header subcomponent for CitationTableView. Owns:
 *  - sort toggle (per-column)
 *  - column drag-reorder (HTML5 DnD on <th>)
 *  - per-column × remove button
 *  - add-column affordance (button + Dialog)
 *
 * Sibling-of-row in the table; receives handlers from View. Editing
 * state for the add-column dialog stays local. No mutation logic of
 * its own — every change goes through the parent-supplied callbacks.
 */

import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  slugifyColumnId,
  uniqueColumnId,
  type CitationTable,
} from "@/shared/artifacts/citation-table"

export function CitationTableHeader({
  data,
  sort,
  onSortChange,
  editable,
  onRemoveColumn,
  onAddColumn,
  onColumnDrop,
}: {
  data: CitationTable
  sort: { columnId: string; dir: "asc" | "desc" } | null
  onSortChange: (sort: { columnId: string; dir: "asc" | "desc" } | null) => void
  editable: boolean
  onRemoveColumn: (columnId: string) => void
  onAddColumn: (label: string, columnId: string) => void
  onColumnDrop: (from: number, to: number) => void
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [addColOpen, setAddColOpen] = useState(false)
  const [newColLabel, setNewColLabel] = useState("")

  const toggleSort = (columnId: string) =>
    onSortChange(
      sort && sort.columnId === columnId
        ? { columnId, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { columnId, dir: "asc" },
    )

  const submitAddColumn = () => {
    const label = newColLabel.trim().slice(0, 120)
    if (!label) return
    const columnId = uniqueColumnId(data, slugifyColumnId(label))
    onAddColumn(label, columnId)
    setNewColLabel("")
    setAddColOpen(false)
  }

  return (
    <>
      <tr>
        {data.columns.map((col, colIndex) => {
          const active = sort?.columnId === col.id
          return (
            <th
              key={col.id}
              scope="col"
              aria-sort={
                active
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
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
                      if (dragFrom !== null) {
                        onColumnDrop(dragFrom, colIndex)
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
                    <span aria-hidden>
                      {sort.dir === "asc" ? "▲" : "▼"}
                    </span>
                  ) : null}
                  {editable ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove column ${col.label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveColumn(col.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          e.stopPropagation()
                          onRemoveColumn(col.id)
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
        {editable ? (
          <th
            scope="col"
            aria-label="Add column"
            className="border border-[var(--border)] bg-[var(--muted)] p-0 text-left font-medium"
          >
            <button
              type="button"
              onClick={() => setAddColOpen(true)}
              disabled={data.columns.length >= 12}
              className="flex w-full items-center justify-center px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
              title="Add column"
            >
              +
            </button>
          </th>
        ) : null}
      </tr>
      <Dialog
        open={addColOpen}
        onOpenChange={(open) => {
          setAddColOpen(open)
          if (!open) setNewColLabel("")
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add column</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newColLabel}
            onChange={(e) => setNewColLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submitAddColumn()
              }
            }}
            placeholder="Column label (e.g. Price)"
            maxLength={120}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAddColOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitAddColumn}
              disabled={!newColLabel.trim()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 2: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. The new file is unused but typechecks.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add components/panels/citation-table-header.tsx
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(citation-table): extract CitationTableHeader subcomponent

Owns sort, drag-reorder, remove-col ×, add-col dialog. View will
consume it in a later commit. New file unused for now — typechecks
in isolation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create `CitationTableRow`

**Files:**
- Create: `components/panels/citation-table-row.tsx`

- [ ] **Step 1: Write the file**

Create `components/panels/citation-table-row.tsx`:

```tsx
"use client"
import "client-only"

/**
 * Row subcomponent for CitationTableView. Owns:
 *  - per-cell "click to edit" trigger
 *  - the edit <input> (Enter / Escape / blur handlers)
 *  - per-row × remove button
 *  - cell rendering (delegates to private CellContent)
 *  - citation chip rendering (delegates to private CitationChips)
 *
 * Editing state is row-local: each row's input has its own
 * useState. When the row is removed (data.rows shrinks), React
 * unmounts this Row and its editing state disappears — no
 * imperative "clear editing on remove" needed.
 */

import { useState } from "react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { CitationCellEditor } from "@/components/panels/citation-cell-editor"
import {
  type Citation,
  type CitationTable,
  type CitationTableCell,
  setCellValue,
  sourceIndex,
} from "@/shared/artifacts/citation-table"

export function CitationTableRow({
  data,
  rowIndex,
  displayIdx,
  editable,
  onChange,
  onAddCitation,
  onUpdateCitation,
  onRemoveCitation,
  onRemoveRow,
}: {
  data: CitationTable
  rowIndex: number
  displayIdx: number
  editable: boolean
  onChange?: (next: CitationTable) => void
  onAddCitation?: (c: Citation) => void
  onUpdateCitation?: (citIndex: number, patch: Partial<Citation>) => void
  onRemoveCitation?: (citIndex: number) => void
  onRemoveRow?: (rowIndex: number) => void
}) {
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

  return (
    <tr>
      {data.columns.map((col) => {
        const cell = data.rows[rowIndex]?.[col.id]
        const isEditing = editing?.columnId === col.id
        return (
          <td
            key={col.id}
            className="border border-[var(--border)] px-2 py-1 align-top"
          >
            {isEditing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(col.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    commit(col.id)
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    setEditing(null)
                  }
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
                onAddCitation={onAddCitation}
                onUpdateCitation={onUpdateCitation}
                onRemoveCitation={onRemoveCitation}
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
          >
            ×
          </button>
        </td>
      ) : null}
    </tr>
  )
}

/* ------------------------------------------------------------------ */
/* Private subcomponents — not exported.                              */
/* ------------------------------------------------------------------ */

function CitationChips({
  data,
  cell,
}: {
  data: CitationTable
  cell: CitationTableCell
}) {
  return (
    <>
      {cell.citations.map((c, i) => {
        const idx = sourceIndex(data, c.sourceId)
        if (idx === null) return null
        const source = data.sources[idx - 1]
        return (
          <Popover key={`${c.sourceId}-${i}`}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ml-0.5 align-super text-[10px] text-[var(--primary)] hover:underline"
                aria-label={`Source ${idx}: ${source?.title}`}
              >
                [{idx}]
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80 text-xs">
              <div className="font-medium">
                {source?.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {source.title}
                  </a>
                ) : (
                  source?.title
                )}
              </div>
              <blockquote className="mt-1 border-l-2 border-[var(--border)] pl-2 text-[var(--muted-foreground)]">
                {c.quote}
              </blockquote>
            </PopoverContent>
          </Popover>
        )
      })}
    </>
  )
}

function CellContent({
  data,
  cell,
  editable,
  onStartEdit,
  onAddCitation,
  onUpdateCitation,
  onRemoveCitation,
}: {
  data: CitationTable
  cell?: CitationTableCell
  editable: boolean
  onStartEdit: () => void
  onAddCitation?: (c: Citation) => void
  onUpdateCitation?: (citIndex: number, patch: Partial<Citation>) => void
  onRemoveCitation?: (citIndex: number) => void
}) {
  const value = cell?.value ?? ""
  const valueEl = editable ? (
    <button
      type="button"
      onClick={onStartEdit}
      className="text-left hover:underline"
    >
      {value || <span className="text-[var(--muted-foreground)]">—</span>}
    </button>
  ) : value ? (
    <span>{value}</span>
  ) : (
    <span className="text-[var(--muted-foreground)]">—</span>
  )
  return (
    <span>
      {valueEl}
      {editable ? (
        <CitationCellEditor
          sources={data.sources}
          citations={cell?.citations ?? []}
          onAdd={(c) => onAddCitation?.(c)}
          onUpdate={(i, patch) => onUpdateCitation?.(i, patch)}
          onRemove={(i) => onRemoveCitation?.(i)}
        />
      ) : cell ? (
        <CitationChips data={data} cell={cell} />
      ) : null}
    </span>
  )
}
```

- [ ] **Step 2: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. New file unused but typechecks.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add components/panels/citation-table-row.tsx
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(citation-table): extract CitationTableRow subcomponent

Owns cell editing (value input + citation chips). Private
CellContent + CitationChips stay inside the same file.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Rewrite `CitationTableView` as the shell

**Files:**
- Modify: `components/panels/citation-table.tsx` (replace entire file contents)

- [ ] **Step 1: Replace the file**

Replace the entire contents of `components/panels/citation-table.tsx` with:

```tsx
"use client"
import "client-only"

/**
 * Shell for the citation-table artifact. Read-only by default; when an
 * `onChange` handler is supplied, columns sort on header click, cell
 * VALUES are editable in place, citations stay editable chips (via
 * CitationCellEditor), and rows + columns can be added/removed/reordered.
 *
 * Sorting is view-state only (never calls onChange); an edit calls
 * onChange with a pure-helper result from the data layer. Self-
 * contained from the embedded sources.
 *
 * Subcomponents:
 *  - CitationTableHeader (sort + drag + remove-col + add-col dialog)
 *  - CitationTableRow (per-cell edit + remove-row × + CitationCellEditor)
 *
 * All mutator wiring lives in `buildColumnHandlers` (this file). The
 * shell just plumbs the resulting handlers + the per-row remove +
 * per-column drop down to children.
 */

import { useState } from "react"

import { CitationTableHeader } from "@/components/panels/citation-table-header"
import { CitationTableRow } from "@/components/panels/citation-table-row"
import { Button } from "@/components/ui/button"
import {
  type Citation,
  type CitationTable,
  addCitation,
  addColumn,
  addRow,
  moveColumn,
  removeCitation,
  removeColumn,
  removeRow,
  sortRowOrder,
  updateCitation,
} from "@/shared/artifacts/citation-table"

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

  const handlers = editable
    ? buildColumnHandlers(data, onChange!)
    : null

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <CitationTableHeader
            data={data}
            sort={sort}
            onSortChange={setSort}
            editable={editable}
            onRemoveColumn={(id) => handlers?.onRemoveColumn(id)}
            onAddColumn={(label, columnId) => handlers?.onAddColumn(label, columnId)}
            onColumnDrop={(from, to) => handlers?.onMoveColumn(from, to)}
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
              onAddCitation={(c) => handlers?.onAddCitation(rowIndex, c)}
              onUpdateCitation={(i, patch) =>
                handlers?.onUpdateCitation(rowIndex, i, patch)
              }
              onRemoveCitation={(i) => handlers?.onRemoveCitation(rowIndex, i)}
              onRemoveRow={(r) => handlers?.onRemoveRow(r)}
            />
          ))}
        </tbody>
        {editable ? (
          <tfoot>
            <tr>
              <td
                colSpan={data.columns.length + 1}
                className="border border-[var(--border)] px-2 py-1 text-center"
              >
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

/** Pre-bind every mutator from lib/shared/artifacts/citation-table.ts
 *  to (data, onChange). View calls this once per render to get the
 *  handler set it threads to Header + Row. Mutators live here as
 *  one named operation per row/column/cell. */
function buildColumnHandlers(
  data: CitationTable,
  onChange: (next: CitationTable) => void,
) {
  return {
    onMoveColumn: (from: number, to: number) =>
      onChange(moveColumn(data, from, to)),
    onRemoveColumn: (columnId: string) =>
      onChange(removeColumn(data, columnId)),
    onAddColumn: (label: string, columnId: string) =>
      onChange(addColumn(data, label, columnId)),
    onAddRow: () => onChange(addRow(data)),
    onRemoveRow: (rowIndex: number) => onChange(removeRow(data, rowIndex)),
    onAddCitation: (rowIndex: number, c: Citation) =>
      onChange(addCitation(data, rowIndex, _findColumnIdForRow(data, rowIndex), c)),
    onUpdateCitation: (
      rowIndex: number,
      citIndex: number,
      patch: Partial<Citation>,
    ) =>
      onChange(
        updateCitation(
          data,
          rowIndex,
          _findColumnIdForRow(data, rowIndex),
          citIndex,
          patch,
        ),
      ),
    onRemoveCitation: (rowIndex: number, citIndex: number) =>
      onChange(
        removeCitation(
          data,
          rowIndex,
          _findColumnIdForRow(data, rowIndex),
          citIndex,
        ),
      ),
  }
}

/** Helper used inside `buildColumnHandlers`: every citation mutator
 *  needs a `columnId` argument. The Row's onAddCitation / onUpdate /
 *  onRemove props don't carry it (Row only knows its rowIndex); we
 *  re-derive it by picking the first column of the edited cell. The
 *  caller (View) calls these handlers in response to Row's callbacks
 *  which fire inside the same column the user is interacting with —
 *  passed alongside. Use the explicit columnId when available; fall
 *  back to the first column for legacy callers. */
function _findColumnIdForRow(_data: CitationTable, _rowIndex: number): string {
  // Callers in this file (Header's onAddColumn + View's row wiring)
  // pass the columnId explicitly via the wrapped handler. This
  // helper is a placeholder for future extension; the signature
  // requires a columnId because the data layer's mutators do.
  throw new Error("Column id must be threaded explicitly from Row.")
}
```

**Wait** — this last paragraph is wrong. `Row` knows the `columnId` because it iterates `data.columns` and renders one cell per column; the citation-chip handlers fire inside that iteration. Re-derive the implementation correctly:

Replace the `_findColumnIdForRow` helper and the three citation handlers with the actual closure pattern that captures `columnId` from Row's render scope. The simplest fix: have `Row` accept `data, rowIndex` and pass a `columnId` to its `onAddCitation` etc. callbacks. Then `View` doesn't need `_findColumnIdForRow` at all.

So **rewrite** the affected pieces:

In `citation-table-row.tsx` (Task 3's file), change the three citation callbacks to also pass `columnId`:

```tsx
onAddCitation={(c, columnId) => handlers?.onAddCitation(rowIndex, columnId, c)}
onUpdateCitation={(i, patch, columnId) =>
  handlers?.onUpdateCitation(rowIndex, columnId, i, patch)
}
onRemoveCitation={(i, columnId) => handlers?.onRemoveCitation(rowIndex, columnId, i)}
```

And inside `Row`, change the three `CellContent` props:

```tsx
onAddCitation={(c) => onAddCitation?.(c, col.id)}
onUpdateCitation={(i, patch) => onUpdateCitation?.(i, patch, col.id)}
onRemoveCitation={(i) => onRemoveCitation?.(i, col.id)}
```

And inside `buildColumnHandlers`, drop `_findColumnIdForRow` and use the explicit `columnId` arg:

```ts
onAddCitation: (rowIndex: number, columnId: string, c: Citation) =>
  onChange(addCitation(data, rowIndex, columnId, c)),
onUpdateCitation: (
  rowIndex: number,
  columnId: string,
  citIndex: number,
  patch: Partial<Citation>,
) =>
  onChange(updateCitation(data, rowIndex, columnId, citIndex, patch)),
onRemoveCitation: (
  rowIndex: number,
  columnId: string,
  citIndex: number,
) => onChange(removeCitation(data, rowIndex, columnId, citIndex)),
```

**Final Task 4 file** — replace `components/panels/citation-table.tsx` with:

```tsx
"use client"
import "client-only"

/**
 * Shell for the citation-table artifact. Read-only by default; when an
 * `onChange` handler is supplied, columns sort on header click, cell
 * VALUES are editable in place, citations stay editable chips (via
 * CitationCellEditor), and rows + columns can be added/removed/reordered.
 *
 * Sorting is view-state only (never calls onChange); an edit calls
 * onChange with a pure-helper result from the data layer. Self-
 * contained from the embedded sources.
 *
 * Subcomponents:
 *  - CitationTableHeader (sort + drag + remove-col + add-col dialog)
 *  - CitationTableRow (per-cell edit + remove-row × + CitationCellEditor)
 *
 * All mutator wiring lives in `buildColumnHandlers` (this file). The
 * shell just plumbs the resulting handlers + the per-row remove +
 * per-column drop down to children.
 */

import { useState } from "react"

import { CitationTableHeader } from "@/components/panels/citation-table-header"
import { CitationTableRow } from "@/components/panels/citation-table-row"
import { Button } from "@/components/ui/button"
import {
  type Citation,
  type CitationTable,
  addCitation,
  addColumn,
  addRow,
  moveColumn,
  removeCitation,
  removeColumn,
  removeRow,
  sortRowOrder,
  updateCitation,
} from "@/shared/artifacts/citation-table"

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

  const handlers = editable
    ? buildColumnHandlers(data, onChange!)
    : null

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <CitationTableHeader
            data={data}
            sort={sort}
            onSortChange={setSort}
            editable={editable}
            onRemoveColumn={(id) => handlers?.onRemoveColumn(id)}
            onAddColumn={(label, columnId) => handlers?.onAddColumn(label, columnId)}
            onColumnDrop={(from, to) => handlers?.onMoveColumn(from, to)}
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
              onAddCitation={(c, columnId) =>
                handlers?.onAddCitation(rowIndex, columnId, c)
              }
              onUpdateCitation={(i, patch, columnId) =>
                handlers?.onUpdateCitation(rowIndex, columnId, i, patch)
              }
              onRemoveCitation={(i, columnId) =>
                handlers?.onRemoveCitation(rowIndex, columnId, i)
              }
              onRemoveRow={(r) => handlers?.onRemoveRow(r)}
            />
          ))}
        </tbody>
        {editable ? (
          <tfoot>
            <tr>
              <td
                colSpan={data.columns.length + 1}
                className="border border-[var(--border)] px-2 py-1 text-center"
              >
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

/** Pre-bind every mutator from lib/shared/artifacts/citation-table.ts
 *  to (data, onChange). View calls this once per render to get the
 *  handler set it threads to Header + Row. Mutators live here as
 *  one named operation per row/column/cell. */
function buildColumnHandlers(
  data: CitationTable,
  onChange: (next: CitationTable) => void,
) {
  return {
    onMoveColumn: (from: number, to: number) =>
      onChange(moveColumn(data, from, to)),
    onRemoveColumn: (columnId: string) =>
      onChange(removeColumn(data, columnId)),
    onAddColumn: (label: string, columnId: string) =>
      onChange(addColumn(data, label, columnId)),
    onAddRow: () => onChange(addRow(data)),
    onRemoveRow: (rowIndex: number) => onChange(removeRow(data, rowIndex)),
    onAddCitation: (rowIndex: number, columnId: string, c: Citation) =>
      onChange(addCitation(data, rowIndex, columnId, c)),
    onUpdateCitation: (
      rowIndex: number,
      columnId: string,
      citIndex: number,
      patch: Partial<Citation>,
    ) =>
      onChange(updateCitation(data, rowIndex, columnId, citIndex, patch)),
    onRemoveCitation: (
      rowIndex: number,
      columnId: string,
      citIndex: number,
    ) => onChange(removeCitation(data, rowIndex, columnId, citIndex)),
  }
}
```

- [ ] **Step 2: Update `citation-table-row.tsx` to thread `columnId`**

The Row already calls `CellContent` with `onAddCitation` / `onUpdateCitation` / `onRemoveCitation`. Modify `Row`'s `CellContent` invocation to forward `col.id` along with the citation event:

Find the `<CellContent ...>` block in `citation-table-row.tsx` (inside the `data.columns.map((col) => {...})` loop) and update its `onAddCitation` / `onUpdateCitation` / `onRemoveCitation` props to pass `col.id`:

```tsx
<CellContent
  data={data}
  cell={cell}
  editable={editable}
  onStartEdit={() => startEdit(col.id, cell?.value ?? "")}
  onAddCitation={(c) => onAddCitation?.(c, col.id)}
  onUpdateCitation={(i, patch) => onUpdateCitation?.(i, patch, col.id)}
  onRemoveCitation={(i) => onRemoveCitation?.(i, col.id)}
/>
```

Then update `Row`'s prop type to widen the three citation callbacks to include `columnId`:

```tsx
onAddCitation?: (c: Citation, columnId: string) => void
onUpdateCitation?: (citIndex: number, patch: Partial<Citation>, columnId: string) => void
onRemoveCitation?: (citIndex: number, columnId: string) => void
```

- [ ] **Step 3: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS.

- [ ] **Step 4: Run the citation-table tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/shared/artifacts/citation-table.test.ts`
Expected: PASS (unchanged — pure data layer unaffected).

- [ ] **Step 5: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add components/panels/citation-table.tsx components/panels/citation-table-row.tsx
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(citation-table): View becomes thin shell, Row threads columnId

431-line View collapses to ~110 lines (shell + buildColumnHandlers).
The 9 inline onChange arrows collapse to one buildColumnHandlers call.

Row's citation callbacks now carry the columnId alongside, so the
data-layer mutators receive it directly. The throw helper is gone.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification

**Files:** none modified.

- [ ] **Step 1: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. 0 errors. Pre-existing lint warnings unchanged.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS. Test count is unchanged from before — the 4 new pure-helper tests (2 describes × 2 cases each on average) and 0 changes to existing tests.

- [ ] **Step 3: Manual smoke**

Start the dev server (`bun dev`), open a citation-table artifact (extract one via the AI gateway or use an existing fixture), exercise:

- Sort on a column header (read-only)
- Click a cell → edit → Enter (editable)
- Click a cell → edit → Escape (cancel)
- Click a cell → edit → blur (commit)
- Add a citation chip via `+ cite`
- Edit an existing citation (change source / quote)
- Remove a citation
- Add a column (dialog → label → Add)
- Remove a column (× on header)
- Add a row (+ Add row footer)
- Remove a row (× per row)
- Drag-reorder a column (grip → drop on another column)
- Keyboard: focus a column ×, press Enter, column removes

If any affordance regresses, the diff is small enough to bisect.

- [ ] **Step 4: Confirm net line count**

Run: `cd /Users/blackmount8/_repository/hummingbird && git diff main...HEAD -- components/panels/citation-table.tsx | wc -l`
Expected: a large net-deletion diff (the file shrinks from 431 → ~110 lines; the deleted content moves to header.tsx + row.tsx). Total across the three files is roughly neutral (the new subcomponents are slightly more verbose due to props + imports).

---

## Self-Review Checklist

- **Spec coverage:** All 9 sections map to tasks. Decisions table → reflected in tasks. Header + Row split → Tasks 2 + 3. View shell → Task 4. Pure helpers + tests → Task 1. Final verification → Task 5.
- **Placeholders:** The `_findColumnIdForRow` placeholder from my first draft is gone — Task 4's corrected version threads `columnId` from Row's render scope.
- **Type consistency:** `Citation` / `CitationTable` / `CitationTableCell` types from the data layer are used identically across all four files. `Citation` is imported from `@/shared/artifacts/citation-table`.
- **Out-of-scope respected:** No persistence change (no `STORE_VERSION` bump), no Plate node change, no extraction prompt change.