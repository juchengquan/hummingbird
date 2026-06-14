# In-document editing for the embedded citation table — Slice 4b — Design

Status: **approved design — ready for implementation plan.**
Origin: sub-project 4 of the Elicit-style extraction tables (`docs/PLAN-cross-product-inspirations.md` §9). Slice 4a (PR #215) embedded a citation-table artifact as a **read-only** void Plate node that round-trips through Markdown. This slice makes that embedded node **editable in place** — cell values editable inside the editor document, persisting to the shared artifact.

## Why

4a put the table in the document but left it read-only — to edit, the user had to go back to the Artifacts tab. 4b closes the loop: edit the dossier where the research is being written, and the change flows to the single source of truth (the artifact), so the Artifacts tab and any other embed stay in sync.

## Edit semantics (decided)

An in-doc edit writes back to the **shared artifact** via the existing `updateArtifactContent` store mutator — NOT a document-local copy. This is consistent with 4a's design: the node carries only `artifactId` and renders the live artifact, so an edit to the artifact re-renders every view of it (the doc node and the Artifacts-tab view) with no extra wiring and no Markdown change.

```
Doc node ──artifactId──► Artifact (source of truth) ◄───── Artifacts tab
Edit a cell in the doc → updateArtifactContent → artifact.content updates → both views re-render
```

## Scope

- **In:** make the embedded node's `CitationTableView` editable (cell **values**) by passing `onChange`, gated on the editor not being read-only; an event-isolation guard so the inline `<input>` works inside the Plate void node.
- **Out:** editing citations; add/remove rows or columns (already out of slice 3 too); any change to `CitationTableView` itself (it already supports editing); any Markdown/schema/store change.

## Architecture

The **only** file with real change is the node component (`components/ui/citation-table-node.tsx`). `CitationTableView` (`components/panels/citation-table.tsx`) already renders editable cells when given an `onChange` (shipped in slice 3, PR #214) and read-only cells when not — 4a simply omitted `onChange`. 4b passes it, wired to the existing store mutator. Editing is **cell values only**; citations stay read-only chips (slice 3 behavior, unchanged).

### The change — `components/ui/citation-table-node.tsx`

Add two hooks and the conditional `onChange`, plus the event-isolation wrapper:

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

- `useReadOnly` is imported from `platejs/react` (same import `components/ui/date-node.tsx` uses). When the editor is read-only (print, static/shared view), `onChange` is `undefined` → the table renders read-only.
- `updateArtifactContent(artifactId, content)` already exists on the store (`lib/client/hooks/store/slices/artifacts.ts`) from slice 3 — it sets the matching artifact's `content`. No new store work.
- The `onChange` body mirrors the Artifacts-tab wiring exactly: `updateArtifactContent(artifact.id, JSON.stringify(next))`.
- The `stopPropagation` wrapper is applied only on the populated-table branch (the placeholder needs no guard).

## Data flow

cell click → inline `<input>` (slice 3) → Enter/blur commits → `CitationTableView` calls `onChange(setCellValue(data, rowIndex, columnId, value))` → node's handler runs `updateArtifactContent(artifactId, JSON.stringify(next))` → store updates `artifact.content` → the node's `useStore` selector and the Artifacts-tab view both re-render with the new value. Sorting remains local view-state and never calls `onChange` (slice 3).

## Persistence

Editing the artifact does **not** change the Plate document value — the document still stores only the `artifactId` marker — so the editor's `serializeMd`/save cycle is **not** triggered by a cell edit. The artifact persists through its own existing sync (`diffArtifacts` compares `a.content`, the upsert row carries `content`). No Markdown round-trip change, no double-write, no new persisted key.

## Error handling

- **Missing/deleted artifact:** `table` is `null` → placeholder branch (unchanged from 4a); no `onChange` path exists.
- **Read-only editor:** `onChange` is `undefined` → cells render read-only.
- **No-op edit** (value unchanged): writes equal content → the store `map` produces an equal artifact → sync's content compare sees no change. Harmless (same as slice 3).
- **Void-node interaction:** the node is `contentEditable={false}`, so Slate treats it as atomic and does not manage text inside it; a native `<input>` stays interactive (clicks already reach 4a's read-only sort buttons). The `stopPropagation` guard stops Slate's editor-level handlers from interfering with focus/typing/selection and from interpreting Backspace/Enter as void-node commands. This is the main risk and is verified by the manual editor test (the editor isn't unit-tested).

## Testing

- **Pure logic:** none new. The edit transform `setCellValue` is already unit-tested (slice 3, `lib/shared/artifacts/citation-table.test.ts`); 4b adds only thin glue.
- **Glue:** `bun run check` (typecheck + lint).
- **Manual editor round-trip** (documented in the PR test plan, since the editor isn't unit-tested):
  1. Embed a `kind:'table'` artifact in the doc (Send to editor, from 4a).
  2. Click a cell → edit its value → Enter. Confirm the cell updates in the doc.
  3. Open the same artifact in the Artifacts tab → confirm it shows the edited value (shared source of truth).
  4. Reload the document → confirm the edit persisted (the artifact round-tripped via its own sync).
  5. Confirm sorting a column still works and never loses an edit.
  6. Confirm citation chips remain read-only (not editable).
  7. Put the editor in a read-only context if available (or temporarily verify via `useReadOnly`) → confirm cells are not editable.

## Touch-point summary

| File | Change |
|---|---|
| `components/ui/citation-table-node.tsx` | add `useReadOnly` + `updateArtifactContent`; pass `onChange` (gated on `!readOnly && artifact`); wrap the table in a `stopPropagation` guard |

## Scope

**S.** One file changed. Reuses slice 3's `onChange`/`setCellValue` editing path and the existing `updateArtifactContent` mutator; no `CitationTableView` change, no new pure logic, no deps, no schema/Markdown/persisted-shape change. The only genuinely new element is the void-node event-isolation guard, validated by the manual editor test.
