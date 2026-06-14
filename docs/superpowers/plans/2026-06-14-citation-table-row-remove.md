# Citation-table row-remove affordance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `×Row` affordance to the interactive citation table, closing the add/remove symmetry gap (table already has `+Row`, `+Column`, `×Column`).

**Architecture:** UI-only wiring of the already-tested pure helper `removeRow(data, rowIndex)`. A trailing actions `<td>` is added to each `<tbody>` row in editable mode, aligned under the existing trailing `+Column` header `<th>`; its `×` button calls `onChange(removeRow(data, rowIndex))`. The shared `CitationTableView` means the embedded editor-doc copy gains the affordance for free.

**Tech Stack:** React 19, TypeScript, Tailwind v4, shadcn/ui. Pure helpers in `lib/shared/artifacts/citation-table.ts`.

**Spec:** `docs/superpowers/specs/2026-06-14-citation-table-row-remove-design.md`

---

## File Structure

- **Modify:** `components/panels/citation-table.tsx` — add `removeRow` to the existing import; render a trailing actions `<td>` + `×Row` button per row in editable mode; thread the display position for the `aria-label`.
- **No change:** `lib/shared/artifacts/citation-table.ts` — `removeRow` is already exported and tested (`citation-table.test.ts:189-202`).

No new files. No new pure logic ⇒ no new unit test (matching Slices A/B precedent and the absent component-test harness; see spec §Testing).

---

### Task 1: Wire the `×Row` affordance into `CitationTableView`

**Files:**
- Modify: `components/panels/citation-table.tsx`

- [ ] **Step 1: Confirm the existing helper test is green (the safety net for this slice)**

Run: `bun test ./lib/shared/artifacts/citation-table.test.ts`
Expected: PASS, including the `removeRow` describe block (removes the row at index; out-of-range index returns `data` unchanged).

- [ ] **Step 2: Add `removeRow` to the artifacts import**

In `components/panels/citation-table.tsx`, the import block from `@/shared/artifacts/citation-table` currently lists (alphabetical):
`addColumn, addRow, removeColumn, setCellValue, sortRowOrder, sourceIndex`.
Add `removeRow` in alphabetical position (after `removeColumn`):

```tsx
import {
  type CitationTable,
  type CitationTableCell,
  addColumn,
  addRow,
  removeColumn,
  removeRow,
  setCellValue,
  sortRowOrder,
  sourceIndex,
} from "@/shared/artifacts/citation-table"
```

- [ ] **Step 3: Thread the display position into the row map**

In the `<tbody>`, change the row map to expose the 1-based display position for the `aria-label`. Replace:

```tsx
        <tbody>
          {order.map((rowIndex) => (
            <tr key={`row-${rowIndex}`}>
```

with:

```tsx
        <tbody>
          {order.map((rowIndex, displayIdx) => (
            <tr key={`row-${rowIndex}`}>
```

- [ ] **Step 4: Add the trailing actions cell with the `×Row` button**

Inside the same `<tr>`, immediately AFTER the `{data.columns.map((col) => { ... })}` block (i.e. after its closing `)}` and before the `</tr>`), add the editable-gated actions cell:

```tsx
              {editable ? (
                <td className="border border-[var(--border)] p-0 text-center align-top">
                  <button
                    type="button"
                    aria-label={`Remove row ${displayIdx + 1}`}
                    title="Remove row"
                    onClick={() => {
                      setEditing(null)
                      if (onChange) onChange(removeRow(data, rowIndex))
                    }}
                    className="px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                  >
                    ×
                  </button>
                </td>
              ) : null}
```

Notes for the implementer:
- `rowIndex` here is the **original** index (the value yielded by `order`), which is exactly what `removeRow` needs — correct even under an active sort. Do NOT use `displayIdx` for the removal call.
- `setEditing(null)` clears any in-progress cell edit so a stale `{rowIndex}` can't point at the wrong row after the array reindexes.
- `if (onChange)` is the type-narrowing guard, mirroring the existing `×Column` handler (`editable` already implies `onChange` exists).
- This cell aligns under the existing trailing `+Column` `<th>`. The `tfoot` `+Row` cell already uses `colSpan={data.columns.length + 1}`, so all three rows (head / body / foot) now have matching width — no other layout change needed.

- [ ] **Step 5: Typecheck + lint + the split test run**

Run: `bun run check`
Expected: typecheck 0 errors, lint 0 errors, split test run all pass / 0 fail (the `error: postgres unreachable` trace from `route.handler.test.ts:240` is an intentional throw inside a passing test — counts stay `0 fail`).

- [ ] **Step 6: Manual verification**

Run: `bun dev`, open a conversation that produced (or paste/generate) a citation-table artifact.
- In the **Artifacts tab** (editable `CitationTableView`): a muted `×` appears at the right edge of every row; clicking it removes that row.
- Activate a column **sort** (click a header), then remove a row — confirm the correct (visually-targeted) row disappears, not a different one.
- Embed the table in the editor doc (slash-insert or the embed action) — confirm the in-document copy shows the same `×Row` and that removing a row there persists (mirrors via `updateArtifactContent`).
- Confirm a **read-only** render (no `onChange`) shows **no** `×Row` column.

- [ ] **Step 7: Commit**

```bash
git add components/panels/citation-table.tsx
git commit -m "$(cat <<'EOF'
feat(citation-table): row-remove affordance (polish Slice C)

Add a per-row ×Row button (editable mode) wiring the already-tested
removeRow helper, closing the add/remove symmetry gap. Trailing actions
cell aligns under the +Column header; sort-safe (uses original row
index); clears in-progress edit before removal. Embedded editor copy
gains it for free via the shared CitationTableView.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Placement (trailing actions `<td>`, editable-gated, under `+Column`) → Step 4. ✓
- Real `<button>` with `aria-label` using display position → Step 3 (thread `displayIdx`) + Step 4. ✓
- Sort-safe removal via original `rowIndex` → Step 4 note. ✓
- `setEditing(null)` before removal → Step 4. ✓
- Immediate delete, no confirm → Step 4 (no dialog). ✓
- Always-visible muted styling consistent with `×Column` → Step 4 className. ✓
- Embedded copy free → covered by shared component; verified in Step 6. ✓
- No new test file; verify via existing helper test + `bun run check` + manual → Steps 1, 5, 6. ✓
- One file touched → File Structure. ✓

No spec requirement is left without a step.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps — every code step shows the exact code. ✓

**3. Type consistency:** `removeRow(data, rowIndex)` matches the exported signature in `citation-table.ts`. `onChange`, `setEditing`, `data`, `order`, `editable` are all existing identifiers in the component's scope. `displayIdx` is newly introduced in Step 3 and only used in Step 4. ✓
