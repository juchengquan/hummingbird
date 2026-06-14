# In-place citation editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit a citation-table cell's citations (quote, source, add, remove) from the chip popover when the table is in editable mode.

**Architecture:** Three new pure helpers (`addCitation` / `updateCitation` / `removeCitation`) in `lib/shared/artifacts/citation-table.ts` carry all mutation logic (TDD-covered). A new self-contained `CitationCellEditor` component renders editable chips (each an edit-popover) plus a `+ cite` add affordance, taking a narrow handler interface. `CitationTableView` renders it in the editable branch of `CellContent` and wires the handlers to the helpers through `onChange`. The embedded editor-doc copy gains it for free via the shared component.

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui (Popover, Button), Zod. Tests: `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-14-citation-cell-editing-design.md`

---

## File Structure

- **Modify:** `lib/shared/artifacts/citation-table.ts` — export `Citation` type; add `addCitation`, `updateCitation`, `removeCitation`.
- **Modify:** `lib/shared/artifacts/citation-table.test.ts` — tests for the three helpers.
- **Create:** `components/panels/citation-cell-editor.tsx` — the editable-citation UI (edit-popover per chip + add-popover).
- **Modify:** `components/panels/citation-table.tsx` — render `CitationCellEditor` in `CellContent`'s editable branch; pass handlers; add imports.

Task 1 (helpers + tests) is independent and lands first. Task 2 (UI) depends on Task 1's exports.

---

### Task 1: Pure citation helpers (TDD)

**Files:**
- Modify: `lib/shared/artifacts/citation-table.ts`
- Test: `lib/shared/artifacts/citation-table.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/shared/artifacts/citation-table.test.ts`, extend the import at the top to add the three new helpers (alphabetical):

```ts
import {
  addCitation,
  addColumn,
  addRow,
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

Then append these three describe blocks at the end of the file (they reuse the existing `tbl(...)` fixture helper; the helpers don't read `sources`, so `tbl`'s empty `sources` is fine):

```ts
describe("addCitation", () => {
  test("appends a citation to an existing cell (no mutation)", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const before = JSON.stringify(data)
    const out = addCitation(data as never, 0, "name", { sourceId: "s2", quote: "q2" })
    expect(out).not.toBe(data)
    expect(out.rows[0].name.citations).toEqual([
      { sourceId: "s1", quote: "q1" },
      { sourceId: "s2", quote: "q2" },
    ])
    expect(JSON.stringify(data)).toBe(before)
  })
  test("creates an absent cell with value '' and the citation", () => {
    const data = tbl([{ name: { value: "a" } }])
    const out = addCitation(data as never, 0, "n", { sourceId: "s1", quote: "q" })
    expect(out.rows[0].n).toEqual({ value: "", citations: [{ sourceId: "s1", quote: "q" }] })
  })
  test("returns the input unchanged at the 8-citation cap", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ sourceId: `s${i}`, quote: `q${i}` }))
    const data = tbl([{ name: { value: "a", citations: eight } }])
    expect(addCitation(data as never, 0, "name", { sourceId: "s9", quote: "q9" })).toBe(data)
  })
  test("returns the input unchanged for an out-of-range rowIndex", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(addCitation(data as never, 9, "name", { sourceId: "s1", quote: "q" })).toBe(data)
    expect(addCitation(data as never, -1, "name", { sourceId: "s1", quote: "q" })).toBe(data)
  })
})

describe("updateCitation", () => {
  test("patches the sourceId only", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const out = updateCitation(data as never, 0, "name", 0, { sourceId: "s2" })
    expect(out.rows[0].name.citations[0]).toEqual({ sourceId: "s2", quote: "q1" })
  })
  test("patches the quote only", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const out = updateCitation(data as never, 0, "name", 0, { quote: "q2" })
    expect(out.rows[0].name.citations[0]).toEqual({ sourceId: "s1", quote: "q2" })
  })
  test("patches both fields and returns a new object (no mutation)", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const before = JSON.stringify(data)
    const out = updateCitation(data as never, 0, "name", 0, { sourceId: "s2", quote: "q2" })
    expect(out).not.toBe(data)
    expect(out.rows[0].name.citations[0]).toEqual({ sourceId: "s2", quote: "q2" })
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged for a missing cell", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(updateCitation(data as never, 0, "n", 0, { quote: "x" })).toBe(data)
  })
  test("returns the input unchanged for an out-of-range citIndex or rowIndex", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    expect(updateCitation(data as never, 0, "name", 5, { quote: "x" })).toBe(data)
    expect(updateCitation(data as never, 9, "name", 0, { quote: "x" })).toBe(data)
  })
})

describe("removeCitation", () => {
  test("removes the citation at the index and returns a new object (no mutation)", () => {
    const data = tbl([
      {
        name: {
          value: "a",
          citations: [
            { sourceId: "s1", quote: "q1" },
            { sourceId: "s2", quote: "q2" },
          ],
        },
      },
    ])
    const before = JSON.stringify(data)
    const out = removeCitation(data as never, 0, "name", 0)
    expect(out).not.toBe(data)
    expect(out.rows[0].name.citations).toEqual([{ sourceId: "s2", quote: "q2" }])
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged for a missing cell", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(removeCitation(data as never, 0, "n", 0)).toBe(data)
  })
  test("returns the input unchanged for an out-of-range citIndex or rowIndex", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    expect(removeCitation(data as never, 0, "name", 5)).toBe(data)
    expect(removeCitation(data as never, 9, "name", 0)).toBe(data)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./lib/shared/artifacts/citation-table.test.ts`
Expected: FAIL — `addCitation`, `updateCitation`, `removeCitation` are not exported (import error / "not a function").

- [ ] **Step 3: Implement the helpers + the `Citation` type**

In `lib/shared/artifacts/citation-table.ts`, after the existing type exports (the `export type CitationTableCell = ...` line), add the element type:

```ts
export type Citation = z.infer<typeof CitationSchema>
```

Then append the three helpers at the END of the file (after `removeColumn`):

```ts
/** Return a NEW CitationTable with `citation` appended to
 *  `rows[rowIndex][columnId].citations`. Creates the cell
 *  (`{ value: "", citations: [citation] }`) when absent. Capped at 8
 *  citations per cell (returns `data` unchanged at cap). Out-of-range
 *  `rowIndex` returns `data` unchanged. Pure; never mutates the input. */
export function addCitation(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  citation: Citation,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const existing = data.rows[rowIndex]?.[columnId]
  const citations = existing?.citations ?? []
  if (citations.length >= 8) return data
  const rows = data.rows.map((row, i) =>
    i === rowIndex
      ? { ...row, [columnId]: { value: existing?.value ?? "", citations: [...citations, citation] } }
      : row,
  )
  return { ...data, rows }
}

/** Return a NEW CitationTable with the citation at `citIndex` of
 *  `rows[rowIndex][columnId]` patched (`sourceId` and/or `quote`).
 *  Missing cell, empty citations, or out-of-range `citIndex` returns
 *  `data` unchanged. Out-of-range `rowIndex` returns `data` unchanged.
 *  Pure; never mutates the input. */
export function updateCitation(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  citIndex: number,
  patch: Partial<Citation>,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const cell = data.rows[rowIndex]?.[columnId]
  if (!cell || citIndex < 0 || citIndex >= cell.citations.length) return data
  const citations = cell.citations.map((c, i) => (i === citIndex ? { ...c, ...patch } : c))
  const rows = data.rows.map((row, i) =>
    i === rowIndex ? { ...row, [columnId]: { ...cell, citations } } : row,
  )
  return { ...data, rows }
}

/** Return a NEW CitationTable with the citation at `citIndex` of
 *  `rows[rowIndex][columnId]` removed. Missing cell or out-of-range
 *  `citIndex` returns `data` unchanged. Out-of-range `rowIndex` returns
 *  `data` unchanged. Pure; never mutates the input. */
export function removeCitation(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  citIndex: number,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const cell = data.rows[rowIndex]?.[columnId]
  if (!cell || citIndex < 0 || citIndex >= cell.citations.length) return data
  const citations = cell.citations.filter((_, i) => i !== citIndex)
  const rows = data.rows.map((row, i) =>
    i === rowIndex ? { ...row, [columnId]: { ...cell, citations } } : row,
  )
  return { ...data, rows }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./lib/shared/artifacts/citation-table.test.ts`
Expected: PASS — all new `addCitation` / `updateCitation` / `removeCitation` tests green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/citation-table.ts lib/shared/artifacts/citation-table.test.ts
git commit -m "$(cat <<'EOF'
feat(citation-table): pure addCitation/updateCitation/removeCitation helpers

Export the Citation element type and three pure, never-mutate helpers
backing in-place citation editing (Slice D). 8-cap and out-of-range
guards mirror the existing helper contract; TDD-covered.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `CitationCellEditor` component + wiring

**Files:**
- Create: `components/panels/citation-cell-editor.tsx`
- Modify: `components/panels/citation-table.tsx`

- [ ] **Step 1: Create the editor component**

Create `components/panels/citation-cell-editor.tsx` with this exact content:

```tsx
"use client"
import "client-only"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { Citation, CitationTable } from "@/shared/artifacts/citation-table"

type Sources = CitationTable["sources"]

/** Editable citation list for a single cell (editable mode only). Each
 *  existing citation is a `[n]` chip whose popover is a small form
 *  (source <select> + quote <textarea> + Remove). A `+ cite` trigger
 *  adds a new citation. Source choices are limited to the table's
 *  existing `sources`. Read-only rendering stays in CitationChips. */
export function CitationCellEditor({
  sources,
  citations,
  onAdd,
  onUpdate,
  onRemove,
}: {
  sources: Sources
  citations: Citation[]
  onAdd: (citation: Citation) => void
  onUpdate: (citIndex: number, patch: Partial<Citation>) => void
  onRemove: (citIndex: number) => void
}) {
  return (
    <>
      {citations.map((c, i) => {
        const idx = sources.findIndex((s) => s.id === c.sourceId)
        return (
          <EditCitationPopover
            key={`cit-${i}`}
            sources={sources}
            citation={c}
            label={idx === -1 ? "?" : String(idx + 1)}
            onUpdate={(patch) => onUpdate(i, patch)}
            onRemove={() => onRemove(i)}
          />
        )
      })}
      {sources.length > 0 && citations.length < 8 ? (
        <AddCitationPopover sources={sources} onAdd={onAdd} />
      ) : null}
    </>
  )
}

function SourceSelect({
  sources,
  value,
  ariaLabel,
  onChange,
}: {
  sources: Sources
  value: string
  ariaLabel: string
  onChange: (sourceId: string) => void
}) {
  const known = sources.some((s) => s.id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-xs"
    >
      {!known ? (
        <option value={value} disabled>
          (unknown source)
        </option>
      ) : null}
      {sources.map((s, i) => (
        <option key={s.id} value={s.id}>
          [{i + 1}] {s.title}
        </option>
      ))}
    </select>
  )
}

function EditCitationPopover({
  sources,
  citation,
  label,
  onUpdate,
  onRemove,
}: {
  sources: Sources
  citation: Citation
  label: string
  onUpdate: (patch: Partial<Citation>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [quoteDraft, setQuoteDraft] = useState(citation.quote)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setQuoteDraft(citation.quote)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit citation ${label}`}
          className="ml-0.5 align-super text-[10px] text-[var(--primary)] hover:underline"
        >
          [{label}]
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-xs">
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Source</span>
          <SourceSelect
            sources={sources}
            value={citation.sourceId}
            ariaLabel="Citation source"
            onChange={(sourceId) => onUpdate({ sourceId })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Quote</span>
          <textarea
            value={quoteDraft}
            onChange={(e) => setQuoteDraft(e.target.value)}
            onBlur={() => {
              if (quoteDraft !== citation.quote) onUpdate({ quote: quoteDraft })
            }}
            maxLength={2000}
            rows={3}
            aria-label="Citation quote"
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-xs"
          />
        </label>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onRemove()
              setOpen(false)
            }}
            className="h-6 text-xs text-[var(--destructive)]"
          >
            Remove
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AddCitationPopover({
  sources,
  onAdd,
}: {
  sources: Sources
  onAdd: (citation: Citation) => void
}) {
  const [open, setOpen] = useState(false)
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "")
  const [quote, setQuote] = useState("")

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setSourceId(sources[0]?.id ?? "")
          setQuote("")
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add citation"
          className="ml-1 align-super text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:underline"
        >
          + cite
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-xs">
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Source</span>
          <SourceSelect
            sources={sources}
            value={sourceId}
            ariaLabel="New citation source"
            onChange={setSourceId}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[var(--muted-foreground)]">Quote</span>
          <textarea
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            maxLength={2000}
            rows={3}
            aria-label="New citation quote"
            className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-xs"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="h-6 text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!sourceId}
            onClick={() => {
              if (!sourceId) return
              onAdd({ sourceId, quote })
              setOpen(false)
            }}
            className="h-6 text-xs"
          >
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **Step 2: Wire it into `CellContent` in `components/panels/citation-table.tsx`**

First, extend the artifacts import to add the three helpers + the `Citation` type (alphabetical), and import the new component. The import block becomes:

```tsx
import { CitationCellEditor } from "@/components/panels/citation-cell-editor"
import {
  type Citation,
  type CitationTable,
  type CitationTableCell,
  addCitation,
  addColumn,
  addRow,
  removeCitation,
  removeColumn,
  removeRow,
  setCellValue,
  sortRowOrder,
  sourceIndex,
  updateCitation,
} from "@/shared/artifacts/citation-table"
```

(Place the `CitationCellEditor` import alongside the other `@/components/...` imports, keeping the existing import grouping/order the file already uses.)

- [ ] **Step 3: Add the citation handlers to `CellContent`'s props and render the editor**

Replace the entire `CellContent` function with this version (adds three required handler props and swaps the editable branch to render `CitationCellEditor`):

```tsx
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
  onAddCitation: (citation: Citation) => void
  onUpdateCitation: (citIndex: number, patch: Partial<Citation>) => void
  onRemoveCitation: (citIndex: number) => void
}) {
  const value = cell?.value ?? ""
  const valueEl = editable ? (
    <button type="button" onClick={onStartEdit} className="text-left hover:underline">
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
          onAdd={onAddCitation}
          onUpdate={onUpdateCitation}
          onRemove={onRemoveCitation}
        />
      ) : cell ? (
        <CitationChips data={data} cell={cell} />
      ) : null}
    </span>
  )
}
```

- [ ] **Step 4: Pass the handlers at the `CellContent` call site**

In the `<tbody>`, the cell currently renders `CellContent` like this:

```tsx
                      <CellContent
                        data={data}
                        cell={cell}
                        editable={editable}
                        onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
                      />
```

Replace it with (adds the three handler props closing over `rowIndex` / `col.id`; `onChange?.(...)` no-ops in read-only mode):

```tsx
                      <CellContent
                        data={data}
                        cell={cell}
                        editable={editable}
                        onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
                        onAddCitation={(c) => onChange?.(addCitation(data, rowIndex, col.id, c))}
                        onUpdateCitation={(i, patch) =>
                          onChange?.(updateCitation(data, rowIndex, col.id, i, patch))
                        }
                        onRemoveCitation={(i) => onChange?.(removeCitation(data, rowIndex, col.id, i))}
                      />
```

- [ ] **Step 5: Typecheck + lint + the split test run**

Run: `bun run check`
Expected: typecheck 0 errors, lint 0 errors, split test run all pass / 0 fail (the `error: postgres unreachable` trace from `route.handler.test.ts:240` is an intentional throw inside a passing test — counts stay `0 fail`).

- [ ] **Step 6: Manual verification** (controller does the browser check; implementer skips this step)

In the Artifacts tab on an editable citation table:
- Click a `[n]` chip → edit the quote (blur commits), change the source (popover stays open, chip number updates), Remove deletes it.
- `+ cite` on a cell adds a citation; it's hidden at the 8-cap and when the table has no sources.
- Add a citation to a cell that had none.
- Confirm the embedded editor-doc copy mirrors all edits, and a read-only render shows no editing controls.

- [ ] **Step 7: Commit**

```bash
git add components/panels/citation-cell-editor.tsx components/panels/citation-table.tsx
git commit -m "$(cat <<'EOF'
feat(citation-table): in-place citation editing (polish Slice D)

New CitationCellEditor: each chip opens an edit-popover (source select +
quote textarea + Remove), plus a + cite add affordance. Wired into
CellContent's editable branch via the new pure helpers. Index-based chip
keys keep the popover open across a source change. Embedded editor copy
gains it free via the shared CitationTableView.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Edit quote / re-point source / remove / add → Task 2 `EditCitationPopover` + `AddCitationPopover`; backed by Task 1 helpers. ✓
- Existing-sources-only → `SourceSelect` lists only `sources`; no add-source UI. ✓
- Edit-in-popover + `+ cite` add affordance → Task 2 Step 1. ✓
- No explicit Save (commit-on-change source / commit-on-blur quote) → `SourceSelect.onChange` → `onUpdate({sourceId})`; textarea `onBlur` → `onUpdate({quote})`. ✓
- Native `<select>` → `SourceSelect`. ✓
- `Citation` type + 3 pure helpers with cap + out-of-range guards → Task 1 Step 3. ✓
- Index-based chip keys (`cit-${i}`) → Task 2 Step 1. ✓
- Unresolved sourceId renders editable `[?]` + `(unknown source)` option → `CitationCellEditor` label + `SourceSelect` `!known` branch. ✓
- Editor renders even when cell absent (add to empty cell) → `CellContent` passes `cell?.citations ?? []`, editable branch unconditional. ✓
- `+ cite` gated by `sources.length > 0 && citations.length < 8` → `CitationCellEditor`. ✓
- Read-only path unchanged (CitationChips) → `CellContent` non-editable branch. ✓
- Embedded copy free → shared component; verified Step 6. ✓
- Helper tests (happy/create/cap/out-of-range) → Task 1 Step 1. ✓

No spec requirement is left without a task.

**2. Placeholder scan:** No TBD/TODO/vague steps — every code step shows complete code. ✓

**3. Type consistency:** `Citation` (Task 1) is imported and used in Task 2 (`citation-cell-editor.tsx` + `CellContent` props). Helper signatures `addCitation(data, rowIndex, columnId, citation)`, `updateCitation(data, rowIndex, columnId, citIndex, patch)`, `removeCitation(data, rowIndex, columnId, citIndex)` match their call sites in Task 2 Step 4. `Sources = CitationTable["sources"]` used consistently. The `onAdd/onUpdate/onRemove` prop names on `CitationCellEditor` match both its definition and the `CellContent` wiring. ✓
