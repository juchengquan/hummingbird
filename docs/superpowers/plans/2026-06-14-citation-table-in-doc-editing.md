# Citation-table In-Document Editing (slice 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the citation-table node embedded in the Plate editor document editable in place — cell values editable inline, persisting back to the shared artifact so the Artifacts tab stays in sync.

**Architecture:** The only file that changes is the node component `components/ui/citation-table-node.tsx`. `CitationTableView` already renders editable cells when given an `onChange` (shipped slice 3) and read-only cells otherwise — slice 4a just omitted `onChange`. 4b passes it (gated on the editor not being read-only), wired to the existing `updateArtifactContent` store mutator, and wraps the table in a `stopPropagation` guard so the inline `<input>` works inside the Plate void node. Editing scope is cell **values** only; citations stay read-only chips.

**Tech Stack:** TypeScript · React 19 · Plate.js (`platejs/react` — `useReadOnly`, `PlateElement`) · Zustand.

---

## Background the implementer needs

- **The component today** (`components/ui/citation-table-node.tsx`, shipped in slice 4a / PR #215) is read-only: it renders `<CitationTableView data={table} />` with no `onChange`. It reads the artifact live from the store by `element.artifactId` and renders a placeholder when the artifact is missing or unparseable.
- **`CitationTableView`** (`components/panels/citation-table.tsx`) is already editable: `const editable = !!onChange` — when an `onChange` is supplied, clicking a cell value opens an inline `<input>` (Enter/blur commits via `onChange(setCellValue(...))`, Escape cancels); sorting is local view-state and never calls `onChange`. Citations are always read-only chips. **Do NOT modify this file** — it is shared with the non-editor Artifacts tab.
- **`updateArtifactContent(artifactId: string, content: string): void`** already exists on the store (`lib/client/hooks/store/slices/artifacts.ts:144`, declared in the slice interface at line 41). It sets the matching artifact's `content`. The Artifacts tab wires its own table the same way: `updateArtifactContent(artifact.id, JSON.stringify(next))`.
- **`useReadOnly`** is exported from `platejs/react` (see `components/ui/date-node.tsx:6` — `import { PlateElement, useReadOnly } from 'platejs/react';`).
- **Why the `stopPropagation` guard:** the node is a Plate void (`contentEditable={false}`), so Slate treats it as atomic and does not manage text inside it; a native `<input>` stays interactive (clicks already reach 4a's read-only sort buttons). The guard stops Slate's editor-level handlers (selection, hotkeys, void-node deletion via Backspace/Enter) from firing while a cell input is focused. Event order is safe: the input's own `onKeyDown` (Enter/Escape, defined inside `CitationTableView`) fires at the target before the wrapper's bubble-phase handler stops further propagation to Slate.
- **Persistence:** editing the artifact does NOT change the Plate document (the doc stores only the `artifactId` marker), so the editor's save/serialize cycle is not triggered by a cell edit. The artifact persists through its own existing sync. No Markdown/schema/persisted-shape change.

## File Structure

| File | Change |
|---|---|
| `components/ui/citation-table-node.tsx` | add `useReadOnly` + `updateArtifactContent`; pass `onChange` gated on `!readOnly && artifact`; wrap the populated table in a `stopPropagation` guard |

There is **no new pure logic** (the edit transform `setCellValue` is already unit-tested in slice 3, `lib/shared/artifacts/citation-table.test.ts`), so this plan has one implementation task plus a verification task — no new automated test is added.

---

## Task 1: Make the embedded node editable

**Files:**
- Modify: `components/ui/citation-table-node.tsx` (full-file replacement below)

- [ ] **Step 1: Replace the file contents**

Replace the ENTIRE contents of `components/ui/citation-table-node.tsx` with:

```tsx
'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement, useReadOnly } from 'platejs/react';

import { CitationTableView } from '@/components/panels/citation-table';
import { useStore } from '@/client/hooks/use-store';
import { parseCitationTable } from '@/shared/artifacts/citation-table';
import type { MyCitationTableElement } from '@/components/editor/plate-types';

export function CitationTableElement(
  props: PlateElementProps<MyCitationTableElement>,
) {
  const { element } = props;
  const readOnly = useReadOnly();
  const artifact = useStore((s) =>
    s.artifacts.find((a) => a.id === element.artifactId),
  );
  const updateArtifactContent = useStore((s) => s.updateArtifactContent);
  const table = artifact ? parseCitationTable(artifact.content) : null;

  return (
    <PlateElement
      {...props}
      attributes={{
        ...props.attributes,
        contentEditable: false,
      }}
    >
      <div className="my-2 overflow-hidden rounded-md border border-[var(--border)]">
        {table ? (
          <div
            // Keep cell-input clicks/keys from reaching Slate's editor-level
            // handlers (selection, hotkeys, void-node deletion) while editing.
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <CitationTableView
              data={table}
              onChange={
                readOnly || !artifact
                  ? undefined
                  : (next) =>
                      updateArtifactContent(artifact.id, JSON.stringify(next))
              }
            />
          </div>
        ) : (
          <div className="p-3 text-xs text-[var(--muted-foreground)]">
            Citation table unavailable
          </div>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}
```

What changed vs. the slice-4a version (for the reviewer):
- Added `useReadOnly` to the `platejs/react` import.
- Added `const readOnly = useReadOnly();`.
- Added `const updateArtifactContent = useStore((s) => s.updateArtifactContent);`.
- Wrapped `<CitationTableView>` in a `<div>` with `onMouseDown`/`onKeyDown` `stopPropagation` (populated-table branch only — the placeholder branch is unchanged).
- Passed `onChange`, gated: `readOnly || !artifact ? undefined : (next) => updateArtifactContent(artifact.id, JSON.stringify(next))`.
- The placeholder branch and `{props.children}` are unchanged.

- [ ] **Step 2: Typecheck + lint**

Run: `bun run check`
Expected: typecheck PASS (0 errors), lint PASS (0 errors) for this file. Note: the `check` script also runs the test suite, which has **pre-existing, unrelated failures** — 9 failures from `Cannot find package 'postgres'` in `services/agent-ts/*` plus `app/api/tasks/route.handler.test.ts` and `lib/server/skills/minimax-image-client.test.ts`. These predate this branch and touch none of these files. Confirm none of the failures reference `citation-table-node` or `citation-table`.

- [ ] **Step 3: Commit**

```bash
git add components/ui/citation-table-node.tsx
git commit -m "feat(citation-table): make the embedded Plate node editable in-document"
```

---

## Task 2: Manual editor round-trip verification

**Files:** none (verification only — the editor is not unit-tested, and `setCellValue` is already covered by slice 3's pure tests).

- [ ] **Step 1: Run the fast gate**

Run: `bun run check`
Expected: typecheck + lint clean (ignore the pre-existing unrelated test failures noted in Task 1 Step 2).

- [ ] **Step 2: Manual in-document editing round-trip**

Run `bun dev`, then in the app:
1. Embed a `kind:'table'` citation-table artifact in the editor document — open/generate one in the Artifacts tab (e.g. via "Extract to table"), then click **Send to editor**. Confirm it renders as an embedded node.
2. Click a cell's value → an inline input appears → type a new value → press **Enter**. Confirm the cell shows the new value in the document.
3. Open the same artifact in the **Artifacts tab** → confirm it shows the edited value (the edit wrote to the shared artifact — single source of truth).
4. Reload the document (switch documents/workspaces and back, or reload the page) → confirm the edited value persisted (the artifact round-tripped via its own sync).
5. Click a column header to **sort** → confirm sorting still works and the edited value is not lost.
6. Confirm a **citation chip** (`[N]`) is still read-only (clicking it opens the source popover, not an editor).
7. Confirm **Escape** cancels an in-progress edit (value reverts).
8. Confirm a normal fenced **code block** elsewhere in the doc is unaffected (the change is isolated to the node component).

Record the observed results in the PR description's Test Plan section.

- [ ] **Step 3: Final commit (only if Step 2 surfaced a fix)**

If the manual round-trip required a change (e.g. the `stopPropagation` guard needed adjustment for typing/selection to work cleanly), commit it with a descriptive message. Otherwise nothing to commit — proceed to finishing the branch.

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- Pass `onChange` gated on `!readOnly` → Task 1 (the `onChange` ternary + `useReadOnly`).
- Write edits to the shared artifact via `updateArtifactContent` → Task 1 (`updateArtifactContent(artifact.id, JSON.stringify(next))`).
- Event-isolation guard for the void-node `<input>` → Task 1 (the wrapping `<div>` with `stopPropagation`).
- Read-only contexts disable editing → Task 1 (`readOnly ? undefined`).
- Cell values only; citations read-only → inherited unchanged from `CitationTableView` (not modified).
- Persistence without Markdown change → no doc/markdown/store change made; verified in Task 2 step 4.
- Testing (no new pure logic; check + manual round-trip) → Tasks 1 & 2.
- Scope (one file) → only `components/ui/citation-table-node.tsx` is touched.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; the full file content is shown.

**3. Type consistency:** `updateArtifactContent(artifactId: string, content: string)` matches the store signature (`lib/client/hooks/store/slices/artifacts.ts:41`). `useReadOnly` import path matches `date-node.tsx`. `CitationTableView`'s `onChange?: (next: CitationTable) => void` matches the supplied `(next) => updateArtifactContent(artifact.id, JSON.stringify(next))`. `element.artifactId` is `string` per `MyCitationTableElement`.
