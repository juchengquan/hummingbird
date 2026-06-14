# Interactive Citation Table (Slice 3: sort + edit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped `CitationTableView` interactive — numeric-aware click-to-sort columns (view-state) and click-to-edit cell values (persisted via a new `updateArtifactContent` store mutator).

**Architecture:** Two pure helpers in the shared module (`sortRowOrder`, `setCellValue`) hold the logic + tests. The renderer becomes interactive but stays store-agnostic via an optional `onChange` prop; the Artifacts tab wires `onChange` to a new content mutator (artifact `content` already syncs).

**Tech Stack:** TypeScript, React 19, Zustand, `bun:test`.

Design spec: `docs/superpowers/specs/2026-06-14-citation-table-interactive-design.md`. Reuses Slice 1 (`lib/shared/artifacts/citation-table.ts`, `components/panels/citation-table.tsx`).

---

### Task 1: Pure helpers — `sortRowOrder` + `setCellValue`

**Files:**
- Modify: `lib/shared/artifacts/citation-table.ts`
- Modify: `lib/shared/artifacts/citation-table.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/shared/artifacts/citation-table.test.ts` (add `setCellValue, sortRowOrder` to the existing `import … from "./citation-table"`):

```ts
const tbl = (rows: Record<string, { value: string; citations?: { sourceId: string; quote: string }[] }>[]) => ({
  columns: [{ id: "name", label: "Name" }, { id: "n", label: "N" }],
  rows: rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v.value, citations: v.citations ?? [] }])),
  ),
  sources: [],
})

describe("sortRowOrder", () => {
  test("numeric-aware ascending (200 < 1000 numerically, not lexically)", () => {
    const data = tbl([{ n: { value: "200" } }, { n: { value: "1000" } }, { n: { value: "30" } }])
    expect(sortRowOrder(data as never, "n", "asc")).toEqual([2, 0, 1]) // 30, 200, 1000
  })
  test("descending flips", () => {
    const data = tbl([{ n: { value: "200" } }, { n: { value: "1000" } }, { n: { value: "30" } }])
    expect(sortRowOrder(data as never, "n", "desc")).toEqual([1, 0, 2]) // 1000, 200, 30
  })
  test("string compare when not numeric", () => {
    const data = tbl([{ name: { value: "Banana" } }, { name: { value: "apple" } }])
    expect(sortRowOrder(data as never, "name", "asc")).toEqual([1, 0]) // apple, Banana
  })
  test("empty / missing cells sort last (both directions)", () => {
    const data = tbl([{ n: { value: "" } }, { n: { value: "5" } }, {}])
    expect(sortRowOrder(data as never, "n", "asc")[0]).toBe(1) // "5" first
    expect(sortRowOrder(data as never, "n", "desc")[0]).toBe(1) // "5" still first; empties last
  })
  test("stable for equal keys", () => {
    const data = tbl([{ n: { value: "5" } }, { n: { value: "5" } }, { n: { value: "5" } }])
    expect(sortRowOrder(data as never, "n", "asc")).toEqual([0, 1, 2])
  })
  test("does not mutate data", () => {
    const data = tbl([{ n: { value: "2" } }, { n: { value: "1" } }])
    const before = JSON.stringify(data)
    sortRowOrder(data as never, "n", "asc")
    expect(JSON.stringify(data)).toBe(before)
  })
})

describe("setCellValue", () => {
  test("replaces the target value and preserves its citations", () => {
    const data = tbl([{ name: { value: "old", citations: [{ sourceId: "s1", quote: "q" }] } }])
    const out = setCellValue(data as never, 0, "name", "new")
    expect(out.rows[0].name.value).toBe("new")
    expect(out.rows[0].name.citations).toEqual([{ sourceId: "s1", quote: "q" }])
  })
  test("creates an absent cell with empty citations", () => {
    const data = tbl([{ name: { value: "x" } }])
    const out = setCellValue(data as never, 0, "n", "42")
    expect(out.rows[0].n).toEqual({ value: "42", citations: [] })
  })
  test("leaves other rows/cells untouched and returns a new object (no mutation)", () => {
    const data = tbl([{ name: { value: "a" } }, { name: { value: "b" } }])
    const before = JSON.stringify(data)
    const out = setCellValue(data as never, 0, "name", "A")
    expect(out).not.toBe(data)
    expect(out.rows[1].name.value).toBe("b")
    expect(JSON.stringify(data)).toBe(before)
  })
  test("out-of-range rowIndex returns the input unchanged", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(setCellValue(data as never, 9, "name", "x")).toBe(data)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/shared/artifacts/citation-table.test.ts`
Expected: FAIL — `sortRowOrder` / `setCellValue` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `lib/shared/artifacts/citation-table.ts`:

```ts
/** Display order (array of original row indices) when sorting by
 *  `columnId`. Numeric-aware: when both cell values parse as finite
 *  numbers, compare numerically; otherwise `localeCompare`. Empty /
 *  missing cells sort last in BOTH directions. Stable for equal keys
 *  (preserves original order). Does NOT mutate `data`. */
export function sortRowOrder(
  data: CitationTable,
  columnId: string,
  dir: "asc" | "desc",
): number[] {
  const sign = dir === "asc" ? 1 : -1
  const valueAt = (rowIndex: number): string => data.rows[rowIndex]?.[columnId]?.value ?? ""
  return data.rows
    .map((_, i) => i)
    .sort((a, b) => {
      const va = valueAt(a)
      const vb = valueAt(b)
      if (va === "" && vb === "") return 0
      if (va === "") return 1
      if (vb === "") return -1
      const na = Number(va)
      const nb = Number(vb)
      if (Number.isFinite(na) && Number.isFinite(nb)) {
        return na === nb ? 0 : (na < nb ? -1 : 1) * sign
      }
      return va.localeCompare(vb) * sign
    })
}

/** Return a NEW CitationTable with `rows[rowIndex][columnId].value`
 *  replaced by `value` (the cell's citations are preserved; an absent
 *  cell is created with empty citations). Out-of-range `rowIndex`
 *  returns `data` unchanged. Pure — never mutates the input. */
export function setCellValue(
  data: CitationTable,
  rowIndex: number,
  columnId: string,
  value: string,
): CitationTable {
  if (rowIndex < 0 || rowIndex >= data.rows.length) return data
  const rows = data.rows.map((row, i) => {
    if (i !== rowIndex) return row
    const existing = row[columnId]
    return { ...row, [columnId]: { value, citations: existing?.citations ?? [] } }
  })
  return { ...data, rows }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/shared/artifacts/citation-table.test.ts`
Expected: PASS (existing + new). Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/citation-table.ts lib/shared/artifacts/citation-table.test.ts
git commit -m "feat(artifacts): sortRowOrder + setCellValue pure helpers"
```

---

### Task 2: `updateArtifactContent` store mutator

**Files:**
- Modify: `lib/client/hooks/store/slices/artifacts.ts`

No unit test — it mirrors the untested `updateArtifactTitle` (a trivial map-set); the testable logic is the Task-1 helpers. Verified by typecheck.

- [ ] **Step 1: Add to the `ArtifactsSlice` interface**

In `lib/client/hooks/store/slices/artifacts.ts`, add to the `ArtifactsSlice` interface, right after `updateArtifactTitle: (artifactId: string, title: string) => void`:

```ts
  /** Replace an artifact's `content` (e.g. an in-place table edit). Like
   *  updateArtifactTitle, this is a plain field set; `content` already
   *  syncs via diffArtifacts. */
  updateArtifactContent: (artifactId: string, content: string) => void
```

- [ ] **Step 2: Add the implementation**

Right after the `updateArtifactTitle` implementation:

```ts
  updateArtifactContent: (artifactId, content) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, content } : a,
      ),
    })),
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add lib/client/hooks/store/slices/artifacts.ts
git commit -m "feat(artifacts): updateArtifactContent mutator"
```

---

### Task 3: Make `CitationTableView` interactive

**Files:**
- Modify: `components/panels/citation-table.tsx`

No component test (repo convention); the logic is the Task-1 helpers. Verified by `bun run typecheck && bun run lint`.

- [ ] **Step 1: Replace the component file**

Replace the entire contents of `components/panels/citation-table.tsx` with:

```tsx
"use client"
import "client-only"

/**
 * Renderer for a citation-table artifact. Read-only by default; when an
 * `onChange` handler is supplied, columns sort on header click and cell
 * VALUES are editable in place (citations stay read-only chips). Sorting
 * is view-state only (never calls `onChange`); an edit calls
 * `onChange(setCellValue(...))`. Self-contained from the embedded
 * `sources`. (Slices 1–3 of the Elicit-style extraction tables.)
 */

import { useState } from "react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  type CitationTable,
  type CitationTableCell,
  setCellValue,
  sortRowOrder,
  sourceIndex,
} from "@/shared/artifacts/citation-table"

function CitationChips({ data, cell }: { data: CitationTable; cell: CitationTableCell }) {
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
                  <a href={source.url} target="_blank" rel="noreferrer" className="hover:underline">
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
}: {
  data: CitationTable
  cell?: CitationTableCell
  editable: boolean
  onStartEdit: () => void
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
      {cell ? <CitationChips data={data} cell={cell} /> : null}
    </span>
  )
}

export function CitationTableView({
  data,
  onChange,
}: {
  data: CitationTable
  onChange?: (next: CitationTable) => void
}) {
  const editable = !!onChange
  const [sort, setSort] = useState<{ columnId: string; dir: "asc" | "desc" } | null>(null)
  const [editing, setEditing] = useState<{ rowIndex: number; columnId: string } | null>(null)
  const [draft, setDraft] = useState("")

  const order = sort
    ? sortRowOrder(data, sort.columnId, sort.dir)
    : data.rows.map((_, i) => i)

  const toggleSort = (columnId: string) =>
    setSort((s) =>
      s && s.columnId === columnId
        ? { columnId, dir: s.dir === "asc" ? "desc" : "asc" }
        : { columnId, dir: "asc" },
    )

  const startEdit = (rowIndex: number, columnId: string, current: string) => {
    if (!editable) return
    setDraft(current)
    setEditing({ rowIndex, columnId })
  }
  const commit = () => {
    if (editing && onChange) {
      onChange(setCellValue(data, editing.rowIndex, editing.columnId, draft))
    }
    setEditing(null)
  }

  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {data.columns.map((col) => {
              const active = sort?.columnId === col.id
              return (
                <th
                  key={col.id}
                  scope="col"
                  className="border border-[var(--border)] bg-[var(--muted)] p-0 text-left font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.id)}
                    className="flex w-full items-center gap-1 px-2 py-1 hover:bg-[var(--accent)]"
                  >
                    {col.label}
                    {active ? <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span> : null}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {order.map((rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {data.columns.map((col) => {
                const cell = data.rows[rowIndex]?.[col.id]
                const isEditing =
                  editing?.rowIndex === rowIndex && editing?.columnId === col.id
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
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            commit()
                          } else if (e.key === "Escape") {
                            e.preventDefault()
                            setEditing(null)
                          }
                        }}
                        className="w-full bg-[var(--background)] px-1 text-xs outline-none ring-1 ring-[var(--ring)]"
                      />
                    ) : (
                      <CellContent
                        data={data}
                        cell={cell}
                        editable={editable}
                        onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
                      />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors). If lint errors on the inline `<input>` (e.g. an a11y label rule), add `aria-label="Edit cell value"` to it.

- [ ] **Step 3: Commit**

```bash
git add components/panels/citation-table.tsx
git commit -m "feat(artifacts): sortable + editable CitationTableView"
```

---

### Task 4: Wire `onChange` in the Artifacts tab

**Files:**
- Modify: `components/panels/artifacts-tab.tsx`

- [ ] **Step 1: Select the mutator + pass `onChange`**

In `components/panels/artifacts-tab.tsx`: READ how the component reads the store (it already uses `useStore(...)` selectors for artifact actions like `deleteArtifact` / `updateArtifactTitle`). Add a selector for the new mutator the same way, in the same component that renders the preview dialog:

```ts
const updateArtifactContent = useStore((s) => s.updateArtifactContent)
```

Then change the `'table'` dispatch branch to pass `onChange` (the branch currently renders `<CitationTableView data={table} />`):

```tsx
              return table ? (
                <CitationTableView
                  data={table}
                  onChange={(next) =>
                    updateArtifactContent(artifact.id, JSON.stringify(next))
                  }
                />
              ) : (
```

(`artifact` is in scope in that branch — it's the same `artifact?.kind === "table"` block. Match the exact existing selector/import style; `useStore` is already imported in this file.)

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/panels/artifacts-tab.tsx
git commit -m "feat(artifacts): persist citation-table edits from the Artifacts tab"
```

---

### Task 5: Full gate + PR

**Files:** none (verification only).

- [ ] **Step 1: TS gate**

Run: `bun run check`
Expected: typecheck + lint clean; `bun test` — confirm `bun test lib/shared/artifacts/citation-table.test.ts` passes and no NEW failures (pre-existing env failures in `app/api/tasks` / `minimax` / `services/agent-ts` are unrelated).

- [ ] **Step 2: user-manual drift check**

Run: `bun run docs:user-manual:check`
Expected: up to date (no new panel/route/env — the renderer is the same `citation-table.tsx`, already in the inventory). If it flags drift, `bun run docs:user-manual:build` and commit the regen.

- [ ] **Step 3: Push + open the PR**

```bash
git push -u origin feat/citation-table-interactive
gh pr create --base dev --title "feat(artifacts): sortable + editable citation tables (slice 3)" --body "Implements docs/superpowers/specs/2026-06-14-citation-table-interactive-design.md (slice 3 of the Elicit-style extraction tables)."
```

(Per the repo's PR rules, auto-subscribe if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **The real logic is Task 1** (`sortRowOrder`, `setCellValue` — pure, fully tested). Tasks 2–4 are thin glue verified by typecheck/lint.
- **Sort is view-only:** `sortRowOrder` returns original indices; the body renders in that order but `data.rows` is never reordered, so sorting never touches the artifact. Editing maps the displayed row back to its original index automatically (the body iterates original indices).
- **Edit persists immediately** on commit (Enter/blur) — no save button, matching `updateArtifactTitle`. A no-op edit produces an equal `content` string → the sync's content compare sees no change.
- **Renderer stays store-agnostic** — `onChange` absent → read-only (today's behavior + reusable by the future Plate-embed slice 4).
- **No migration / no persisted-shape change** — `content` is already a persisted, synced field.
