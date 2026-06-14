# Slash-command insert for citation tables — Slice 4c — Design

Status: **approved design — ready for implementation plan.**
Origin: sub-project 4 of the Elicit-style extraction tables (`docs/PLAN-cross-product-inspirations.md` §9). Slices 4a (embed read-only, PR #215) and 4b (in-doc editing, PR #216) put an editable citation-table node in the editor, inserted via "Send to editor" from the Artifacts tab. This slice adds an **in-editor** way to insert one: a `/` slash-menu group that lists the workspace's table artifacts by title and inserts the chosen one at the cursor.

## Why

Today the only way to embed a table is to leave the editor for the Artifacts tab and click "Send to editor". 4c lets a writer stay in the document: type `/`, filter to a table by title, insert it inline — the natural authoring flow for a Plate editor.

## Picker UX (decided)

**Inline list** in the slash menu (not a dialog). A dedicated **"Citation tables"** group lists each `kind:'table'` workspace artifact as its own item (label = the artifact title). The combobox's built-in keyword search filters by title as the user types. Insertion is synchronous within the slash flow — the same path every other slash item uses (`onSelect(editor, value)`), so there is no dialog and no slash→dialog selection bridging.

## Scope

- **In:** a tested pure helper that maps workspace artifacts → slash-item descriptors; an `insertCitationTable` editor transform; a dynamic "Citation tables" group in the slash menu wired to the transform.
- **Out:** creating a *new* table from the slash menu (use "Extract to table"); a modal picker; multi-select; inserting non-table artifacts.

## Architecture

Three small units, each independently understandable.

### 1. Pure helper (tested) — `lib/shared/artifacts/citation-table-slash.ts` (new)

```ts
import type { Artifact } from "@/shared/types"

/** A slash-menu descriptor for inserting an embedded citation table. */
export interface CitationTableSlashItem {
  artifactId: string
  label: string
}

/** Map the workspace's artifacts to citation-table slash items: keep only
 *  `kind:'table'`, in the given order, mapping id→artifactId and
 *  title→label (falling back to "Untitled table" for an empty title). */
export function buildCitationTableSlashItems(
  artifacts: Artifact[],
): CitationTableSlashItem[] {
  return artifacts
    .filter((a) => a.kind === "table")
    .map((a) => ({ artifactId: a.id, label: a.title || "Untitled table" }))
}
```

This is the testable seam (filtering + mapping + the title fallback). It is isomorphic and pure — no Plate/store/React import. `Artifact` is a type-only import from `@/shared/types` (allowed in `lib/shared`).

### 2. Insert transform — `components/editor/transforms.ts` (modify)

Add `insertCitationTable`, mirroring `insertBlock`'s non-upsert branch (insert at the next path, select, then drop the empty `/` paragraph so the table replaces the trigger line):

```ts
export const insertCitationTable = (editor: PlateEditor, artifactId: string) => {
  editor.tf.withoutNormalizing(() => {
    const block = editor.api.block();
    if (!block) return;
    const [, path] = block;
    editor.tf.insertNodes(
      { type: CITATION_TABLE_KEY, artifactId, children: [{ text: '' }] },
      { at: PathApi.next(path), select: true },
    );
    editor.getApi(SuggestionPlugin).suggestion.withoutSuggestions(() => {
      editor.tf.removeNodes({ previousEmptyBlock: true });
    });
  });
};
```

- `PathApi` and `SuggestionPlugin` are already imported in `transforms.ts`. Add a value import of `CITATION_TABLE_KEY` from `@/shared/artifacts/citation-table-md`.
- The inserted node is the 4a/4b void element shape: `{ type: 'citationTable', artifactId, children: [{ text: '' }] }`. The `removeNodes({ previousEmptyBlock: true })` (run without suggestions, exactly as `insertBlock` does) removes the now-empty paragraph the `/` was typed on, so the table replaces it instead of leaving a blank line above it.

### 3. Dynamic slash group — `components/ui/slash-node.tsx` (modify)

`SlashInputElement` currently renders a module-level static `groups` array. Change it to also render a **dynamic** "Citation tables" group computed from the store:

- Read `const tableArtifacts = useWorkspaceArtifacts();` (selector already exported from `@/client/hooks/use-store`; returns the active workspace's artifacts, sorted).
- `const citationItems = buildCitationTableSlashItems(tableArtifacts);`
- When `citationItems.length > 0`, render one extra `InlineComboboxGroup` titled "Citation tables" **after** the static groups, with one `InlineComboboxItem` per item:
  - `key` / `value` = `item.artifactId`
  - `label` / display text = `item.label`
  - `keywords` = `[item.label]` (so title text filters it)
  - icon = `<Table />` (already imported in this file)
  - `onClick={() => insertCitationTable(editor, item.artifactId)}`
- When `citationItems.length === 0`, render nothing extra (the menu's existing `InlineComboboxEmpty` "No results" covers the case where the user's query matches nothing).

The static `groups` const stays as-is (the built-in blocks). The citation-tables group is rendered as an additional `InlineComboboxGroup` in the JSX, keeping the static/dynamic split clear. `insertCitationTable` is imported from `@/components/editor/transforms`.

## Data flow

type `/` → slash menu opens → the "Citation tables" group lists workspace tables by title → user types to filter (combobox keyword match on the title) → clicks an item → `insertCitationTable(editor, artifactId)` inserts the void node at the cursor and removes the empty `/` line → the 4a/4b node component renders the live, editable table (reading the artifact from the store by `artifactId`).

## Error handling / edge cases

- **No table artifacts:** the group is omitted; the rest of the menu is unaffected.
- **Many tables:** the combobox keyword search filters by title; all matching tables show under the group.
- **Duplicate titles:** allowed — the React `key` and item `value` are the unique `artifactId`, so identical labels don't collide.
- **Empty/missing title:** `buildCitationTableSlashItems` falls back to `"Untitled table"` (titles are auto-generated on save, so this is defensive).
- **Inserted artifact later deleted:** handled downstream by the node component's placeholder (4a) — out of scope here.

## Testing

- **Pure (`lib/shared/artifacts/citation-table-slash.test.ts`, `bun:test`):** `buildCitationTableSlashItems` — keeps only `kind:'table'` (drops `code`/`markdown`/`image`/etc.); maps `id→artifactId` and `title→label`; applies the `"Untitled table"` fallback for an empty title; preserves input order; returns `[]` for an empty input or an input with no tables.
- **Transform + slash wiring:** `bun run check` (typecheck + lint). Editor transforms aren't unit-tested in this repo (consistent with the rest of `transforms.ts`).
- **Manual editor test** (PR test plan): with ≥1 table artifact in the workspace, type `/` → confirm the "Citation tables" group lists them by title → type part of a title → confirm it filters → click one → confirm the embedded table inserts at the cursor, replacing the `/` line, and renders/edits (4a/4b). Then with **no** table artifacts, type `/` → confirm no "Citation tables" group appears and the rest of the menu works.

## Touch-point summary

| File | Change |
|---|---|
| `lib/shared/artifacts/citation-table-slash.ts` | **new** — `buildCitationTableSlashItems` + `CitationTableSlashItem` |
| `lib/shared/artifacts/citation-table-slash.test.ts` | **new** — pure tests |
| `components/editor/transforms.ts` | add `insertCitationTable` (+ import `CITATION_TABLE_KEY`) |
| `components/ui/slash-node.tsx` | dynamic "Citation tables" group from `useWorkspaceArtifacts` + `buildCitationTableSlashItems`, wired to `insertCitationTable` |

## Scope

**S/M.** One tested pure helper (the only real logic) + one editor transform mirroring `insertBlock` + one dynamic slash group. Reuses 4a's node element + 4b's editability and the existing slash/combobox + `useWorkspaceArtifacts` infrastructure. No new deps, no schema/Markdown/persisted-shape change.
