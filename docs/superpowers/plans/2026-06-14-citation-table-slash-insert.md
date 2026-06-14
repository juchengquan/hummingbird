# Citation-table Slash-Command Insert (slice 4c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/` slash-menu "Citation tables" group that lists the workspace's table artifacts by title and inserts the chosen one as an embedded (editable) citation-table node at the cursor.

**Architecture:** Three small units — (1) a tested pure helper `buildCitationTableSlashItems(artifacts)` that maps workspace artifacts to slash-item descriptors; (2) an `insertCitationTable(editor, artifactId)` editor transform mirroring `insertBlock`'s non-upsert branch; (3) a dynamic "Citation tables" group in `slash-node.tsx` computed from `useWorkspaceArtifacts()`, wired to the transform. Reuses the 4a node element + 4b editability.

**Tech Stack:** TypeScript · React 19 · Plate.js (`platejs`/`platejs/react`, `@platejs/slash-command`) · Zustand · `bun:test`.

---

## Background the implementer needs

- **The node already exists.** Slices 4a/4b shipped the `citationTable` void Plate element (type `CITATION_TABLE_KEY` from `@/shared/artifacts/citation-table-md`), its component, the plugin (registered in `EditorKit`), the Markdown round-trip, and in-doc editing. This slice only adds a *new way to insert* that node; it touches none of those files.
- **Insert shape.** The node is `{ type: CITATION_TABLE_KEY, artifactId, children: [{ text: '' }] }` (a void block carrying only `artifactId`). The component renders the live artifact from the store.
- **`insertBlock` pattern** (`components/editor/transforms.ts:89-126`): wraps in `editor.tf.withoutNormalizing`, gets the current block, inserts at `PathApi.next(path)` with `{ select: true }`, then `editor.getApi(SuggestionPlugin).suggestion.withoutSuggestions(() => editor.tf.removeNodes({ previousEmptyBlock: true }))` to drop the empty `/` paragraph. `PathApi` and `SuggestionPlugin` are already imported in that file.
- **Slash menu** (`components/ui/slash-node.tsx`): a module-level static `groups` array of `{ group, items: [{ icon, value, label, keywords?, onSelect }] }`. `SlashInputElement` renders each group as an `InlineComboboxGroup` with `InlineComboboxItem`s; each item's `onClick={() => onSelect(editor, value)}`. The combobox filters items by `label` + `keywords`. `Table` (lucide) is already imported there.
- **Store selector** `useWorkspaceArtifacts()` (exported from `@/client/hooks/use-store`) returns the active workspace's artifacts, already sorted. `Artifact` has `id: string`, `kind: ArtifactKind` (`'table'` is one), `title: string`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/shared/artifacts/citation-table-slash.ts` | **new** — pure `buildCitationTableSlashItems` + `CitationTableSlashItem` type (no Plate/store/React deps) |
| `lib/shared/artifacts/citation-table-slash.test.ts` | **new** — `bun:test` for the helper |
| `components/editor/transforms.ts` | add `insertCitationTable` + import `CITATION_TABLE_KEY` |
| `components/ui/slash-node.tsx` | dynamic "Citation tables" group from the store, wired to `insertCitationTable` |

---

## Task 1: Pure slash-item helper

**Files:**
- Create: `lib/shared/artifacts/citation-table-slash.ts`
- Test: `lib/shared/artifacts/citation-table-slash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/shared/artifacts/citation-table-slash.test.ts`:

```ts
import { describe, expect, it } from "bun:test"

import type { Artifact } from "@/shared/types"

import { buildCitationTableSlashItems } from "./citation-table-slash"

function artifact(over: Partial<Artifact>): Artifact {
  return {
    id: "id",
    workspaceId: "ws",
    conversationId: null,
    messageId: null,
    kind: "table",
    language: null,
    title: "T",
    content: "{}",
    storagePath: null,
    pinned: false,
    createdAt: new Date(0),
    ...over,
  }
}

describe("buildCitationTableSlashItems", () => {
  it("keeps only kind:'table' and maps id->artifactId, title->label", () => {
    const items = buildCitationTableSlashItems([
      artifact({ id: "a", kind: "table", title: "Sales by region" }),
      artifact({ id: "b", kind: "code", title: "script.ts" }),
      artifact({ id: "c", kind: "markdown", title: "Notes" }),
      artifact({ id: "d", kind: "table", title: "Q3 pipeline" }),
    ])
    expect(items).toEqual([
      { artifactId: "a", label: "Sales by region" },
      { artifactId: "d", label: "Q3 pipeline" },
    ])
  })

  it("falls back to 'Untitled table' for an empty title", () => {
    const items = buildCitationTableSlashItems([
      artifact({ id: "a", kind: "table", title: "" }),
    ])
    expect(items).toEqual([{ artifactId: "a", label: "Untitled table" }])
  })

  it("preserves input order", () => {
    const items = buildCitationTableSlashItems([
      artifact({ id: "z", kind: "table", title: "Z" }),
      artifact({ id: "a", kind: "table", title: "A" }),
    ])
    expect(items.map((i) => i.artifactId)).toEqual(["z", "a"])
  })

  it("returns [] for no artifacts or no tables", () => {
    expect(buildCitationTableSlashItems([])).toEqual([])
    expect(
      buildCitationTableSlashItems([artifact({ kind: "image" })]),
    ).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/artifacts/citation-table-slash.test.ts`
Expected: FAIL — `Cannot find module './citation-table-slash'`.

- [ ] **Step 3: Write the implementation**

Create `lib/shared/artifacts/citation-table-slash.ts`:

```ts
import type { Artifact } from "@/shared/types"

/** A slash-menu descriptor for inserting an embedded citation table. */
export interface CitationTableSlashItem {
  artifactId: string
  label: string
}

/** Map the workspace's artifacts to citation-table slash items: keep only
 *  `kind:'table'`, in the given order, mapping id→artifactId and title→label
 *  (falling back to "Untitled table" for an empty title). Pure — no Plate,
 *  store, or React dependency. */
export function buildCitationTableSlashItems(
  artifacts: Artifact[],
): CitationTableSlashItem[] {
  return artifacts
    .filter((a) => a.kind === "table")
    .map((a) => ({ artifactId: a.id, label: a.title || "Untitled table" }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/artifacts/citation-table-slash.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/citation-table-slash.ts lib/shared/artifacts/citation-table-slash.test.ts
git commit -m "feat(citation-table): pure helper mapping artifacts to slash items"
```

---

## Task 2: `insertCitationTable` transform

**Files:**
- Modify: `components/editor/transforms.ts`

- [ ] **Step 1: Add the `CITATION_TABLE_KEY` import**

In `components/editor/transforms.ts`, the import block at the top ends around line 28 (the `} from 'platejs';` of the `NodeEntry/Path/TElement/KEYS/PathApi` import). After that import block (before `const ACTION_THREE_COLUMNS`), add:

```ts
import { CITATION_TABLE_KEY } from '@/shared/artifacts/citation-table-md';
```

- [ ] **Step 2: Add the transform**

Add `insertCitationTable` immediately after the `insertBlock` function (which ends at `components/editor/transforms.ts:126`, the closing `};`), before `insertInlineElement`:

```ts
export const insertCitationTable = (
  editor: PlateEditor,
  artifactId: string
) => {
  editor.tf.withoutNormalizing(() => {
    const block = editor.api.block();

    if (!block) return;

    const [, path] = block;

    editor.tf.insertNodes(
      { type: CITATION_TABLE_KEY, artifactId, children: [{ text: '' }] },
      { at: PathApi.next(path), select: true }
    );

    editor.getApi(SuggestionPlugin).suggestion.withoutSuggestions(() => {
      editor.tf.removeNodes({ previousEmptyBlock: true });
    });
  });
};
```

This mirrors `insertBlock`'s non-upsert branch: insert the void citation-table node at the next path and select it, then remove the empty paragraph the `/` was typed on (run without suggestions, exactly as `insertBlock` does). `PlateEditor`, `PathApi`, and `SuggestionPlugin` are already imported in this file.

- [ ] **Step 3: Typecheck + lint**

Run: `bun run check`
Expected: typecheck PASS (0 errors), lint PASS for this file. The `check` script also runs the test suite, which has **pre-existing, unrelated failures** (9: `Cannot find package 'postgres'` in `services/agent-ts/*`, plus `app/api/tasks/route.handler.test.ts` and `lib/server/skills/minimax-image-client.test.ts`) — confirm none reference `citation-table`/`transforms`, and ignore them.

IMPORTANT — only if typecheck errors on `insertNodes`: the node literal may need a cast to the editor's element type. If TS complains the literal doesn't match the expected node type, cast it minimally: `editor.tf.insertNodes({ type: CITATION_TABLE_KEY, artifactId, children: [{ text: '' }] } as any, { at: PathApi.next(path), select: true });` is acceptable here (the slash items elsewhere insert via library helpers that erase the type). Prefer no cast; report if one was needed and why.

- [ ] **Step 4: Commit**

```bash
git add components/editor/transforms.ts
git commit -m "feat(citation-table): insertCitationTable editor transform"
```

---

## Task 3: Dynamic "Citation tables" slash group

**Files:**
- Modify: `components/ui/slash-node.tsx`

The static `groups` const (the built-in blocks) stays unchanged. We add a dynamic group computed from the store inside `SlashInputElement` and render it as an extra `InlineComboboxGroup` after the static groups.

- [ ] **Step 1: Add imports**

In `components/ui/slash-node.tsx`:

(a) After the existing transforms import block:
```ts
import {
  insertBlock,
  insertInlineElement,
} from '@/components/editor/transforms';
```
change it to also import the new transform:
```ts
import {
  insertBlock,
  insertCitationTable,
  insertInlineElement,
} from '@/components/editor/transforms';
```

(b) Add these two imports alongside the other top-of-file imports (e.g. right after the transforms import):
```ts
import { useWorkspaceArtifacts } from '@/client/hooks/use-store';
import { buildCitationTableSlashItems } from '@/shared/artifacts/citation-table-slash';
```

- [ ] **Step 2: Compute the dynamic group inside `SlashInputElement`**

In `SlashInputElement` (currently `components/ui/slash-node.tsx:226-267`), the body starts:
```tsx
export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const { editor, element } = props;

  return (
```
Insert two lines between `const { editor, element } = props;` and `return (`:
```tsx
  const workspaceArtifacts = useWorkspaceArtifacts();
  const citationTableItems = buildCitationTableSlashItems(workspaceArtifacts);
```

- [ ] **Step 3: Render the dynamic group**

In the same component's JSX, the static groups are rendered by `{groups.map(({ group, items }) => ( … ))}` inside `<InlineComboboxContent>`, just after `<InlineComboboxEmpty>No results</InlineComboboxEmpty>`. Immediately AFTER the closing `))}` of that `groups.map(...)` block (and before the closing `</InlineComboboxContent>`), add the dynamic group:

```tsx
          {citationTableItems.length > 0 && (
            <InlineComboboxGroup>
              <InlineComboboxGroupLabel>
                Citation tables
              </InlineComboboxGroupLabel>

              {citationTableItems.map((item) => (
                <InlineComboboxItem
                  key={item.artifactId}
                  value={item.artifactId}
                  onClick={() => insertCitationTable(editor, item.artifactId)}
                  label={item.label}
                  group="Citation tables"
                  keywords={[item.label]}
                >
                  <div className="mr-2 text-muted-foreground">
                    <Table />
                  </div>
                  {item.label}
                </InlineComboboxItem>
              ))}
            </InlineComboboxGroup>
          )}
```

`InlineComboboxGroup`, `InlineComboboxGroupLabel`, `InlineComboboxItem`, and `Table` are all already imported in this file. The `value` and `key` are the unique `artifactId`, so duplicate labels don't collide; `keywords={[item.label]}` makes the title filter the item.

- [ ] **Step 4: Typecheck + lint**

Run: `bun run check`
Expected: typecheck PASS (0 errors), lint PASS for this file. (Ignore the pre-existing unrelated test failures noted in Task 2 Step 3.)

- [ ] **Step 5: Commit**

```bash
git add components/ui/slash-node.tsx
git commit -m "feat(citation-table): /-menu 'Citation tables' group inserts an embedded table"
```

---

## Task 4: Full verification + manual test

**Files:** none (verification only).

- [ ] **Step 1: Pure tests**

Run: `bun test lib/shared/artifacts/citation-table-slash.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 2: Full fast gate**

Run: `bun run check`
Expected: typecheck + lint clean (ignore the pre-existing unrelated test failures).

- [ ] **Step 3: Manual editor test (document in the PR test plan)**

Run `bun dev`, then in the app:
1. Ensure the workspace has ≥1 `kind:'table'` citation-table artifact (create via "Extract to table" if needed).
2. In the editor, type `/` → confirm a **"Citation tables"** group appears listing the table artifacts by title.
3. Type part of a title → confirm the list filters to matching tables.
4. Click an item → confirm the embedded citation table inserts at the cursor (replacing the `/` line), renders the data, and is editable (4a/4b).
5. Insert into a non-empty paragraph and into an empty line → confirm placement is correct in both (no stray blank line left behind).
6. In a workspace (or fresh document) with **no** table artifacts, type `/` → confirm **no** "Citation tables" group appears and the rest of the menu works normally.

Record the results in the PR description's Test Plan section.

- [ ] **Step 4: Final commit (only if Step 3 surfaced a fix)**

If the manual test required a change, commit it. Otherwise nothing to commit — proceed to finishing the branch.

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- Pure helper `buildCitationTableSlashItems` (filter table, map id/title, fallback, order) → Task 1.
- `insertCitationTable` transform mirroring `insertBlock` → Task 2.
- Dynamic "Citation tables" group from `useWorkspaceArtifacts`, omitted when empty, wired to the transform → Task 3.
- Edge cases (no tables → omitted; many → filtered; duplicate titles → unique `artifactId` key; empty title → fallback) → covered by Task 1 (fallback/filter) + Task 3 (`value`/`key`=artifactId, conditional render).
- Testing (pure unit tests + check + manual) → Tasks 1, 3, 4.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code.

**3. Type consistency:** `buildCitationTableSlashItems(artifacts: Artifact[]): { artifactId, label }[]` is defined in Task 1 and consumed in Task 3 with the same property names (`item.artifactId`, `item.label`). `insertCitationTable(editor, artifactId)` defined in Task 2, called in Task 3 as `insertCitationTable(editor, item.artifactId)`. `CITATION_TABLE_KEY` import path (`@/shared/artifacts/citation-table-md`) matches its definition from slice 4a. The inserted node shape matches `MyCitationTableElement` (`{ type, artifactId, children: [{ text: '' }] }`).
