# Citation-table Plate node (read-only embed + Markdown round-trip) — Slice 4a — Design

Status: **approved design — ready for implementation plan.**
Origin: sub-project 4 of the Elicit-style extraction tables (`docs/PLAN-cross-product-inspirations.md` §9). Slices 1–3 shipped render/generate/sort+edit in the **Artifacts tab** (#212/#213/#214). This slice embeds the table **inside the Plate editor document** as a custom node. Decomposed: **4a (this spec)** = read-only embed + Markdown round-trip; **4b (later)** = in-document editing (wire `onChange`); slash-command insert / drag-resize even later.

## Why

The "killer artifact" lives where the research is — in the editor document, not a side tab. This slice lets a user "Send to editor" a citation-table artifact and have it render as a live, referenced node in the doc that survives save/load.

## The governing constraint

The editor document persists as **Markdown** (`components/panels/editor.tsx`: `serializeMd(editor)` on change → `setDocumentContent`; `markdown.deserialize` on load). So a custom node **must round-trip through Markdown** — it can't just live in the Plate value. This is the core work and the main risk.

## Architecture

A node carries only the **`artifactId`** (not a content snapshot) and renders the artifact's live `CitationTable`, so it stays in sync with the Artifacts tab (single source of truth). The Markdown carrier is a **fenced code block** — plain, standard Markdown that `remarkGfm` already parses:

````
```citation-table
<artifactId>
```
````

### 1. Element type — `components/editor/plate-types.ts`
Add a `citationTable` key (mirror how existing element keys are declared) + a void-block interface:
```ts
export interface MyCitationTableElement extends MyBlockElement {
  type: typeof KEYS.citationTable  // or the local key constant the file uses
  artifactId: string
  children: [EmptyText]
}
```

### 2. Plugin — `components/editor/plugins/citation-table-kit.tsx` (new)
A `createPlatePlugin` registering the type as a **void element** (`isVoid: true`, `isElement: true`), `.withComponent(CitationTableNode)`. Add `...CitationTableKit` to `EditorKit` (`components/editor/editor-kit.tsx`) and to the base kit if there's a separate `editor-base-kit.tsx` used for serialization. (Mirror an existing void-element kit, e.g. the media/hr kit.)

### 3. Node component — `components/ui/citation-table-node.tsx` (new)
```tsx
function CitationTableNode(props) {
  const { element } = props // MyCitationTableElement
  const artifact = useStore((s) => s.artifacts.find((a) => a.id === element.artifactId))
  const table = artifact ? parseCitationTable(artifact.content) : null
  return (
    <PlateElement {...props} contentEditable={false}>
      {table ? (
        <CitationTableView data={table} />   // read-only in 4a (no onChange)
      ) : (
        <div className="my-2 rounded border border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">
          Citation table unavailable
        </div>
      )}
      {props.children}
    </PlateElement>
  )
}
```
- Reads the artifact live from the store (`useStore`); a node component is a leaf React component, so this is fine.
- `contentEditable={false}` (void/atomic).
- Missing/deleted artifact or unparseable content → an inert placeholder (no crash).
- Renders `{props.children}` (the empty text Slate requires on a void node).
- **Read-only in 4a** — `CitationTableView` still renders its sort headers (sorting is local view-state, harmless), but no `onChange`, so cells aren't editable. In-doc editing is 4b.

### 4. Markdown round-trip — pure helpers + a rule (the crux)

**Pure helpers** (`lib/shared/artifacts/citation-table-md.ts`, new — isomorphic, tested):
```ts
import type { MyCitationTableElement } from "..."   // or a minimal local shape

/** A `citation-table` slate node → an mdast `code` node carrying the id. */
export function citationTableNodeToMdast(node: { artifactId: string }): {
  type: "code"; lang: "citation-table"; value: string
}

/** An mdast `code` node → a citation-table slate node, or null if it isn't
 *  our marker (lang !== "citation-table"). Caller falls back to the default
 *  `code` handling on null. */
export function mdastCodeToCitationTableNode(
  mdastNode: { type: string; lang?: string | null; value?: string },
): { type: string; artifactId: string; children: [{ text: "" }] } | null
```
These are the testable round-trip core (node → marker → node preserves `artifactId`; a non-`citation-table` code node → `null`).

**Rule wiring** (`components/editor/plugins/markdown-kit.tsx`): `MarkdownPlugin.configure({ options: { rules: {...} } })` — `MdRules` is keyed by node type with `{ serialize, deserialize }` (confirmed against the installed `@platejs/markdown` `MdRules` type).
- **serialize:** a rule keyed by the `citation-table` element type → `citationTableNodeToMdast(node)`.
- **deserialize:** a rule keyed by `"code"` whose `deserialize` calls `mdastCodeToCitationTableNode(mdastNode)`; on a non-null result return it, otherwise **delegate to the default `code` deserialization** so normal fenced code blocks are unaffected. (The exact way to delegate to the default `code` deserializer is the one mechanism to pin against `@platejs/markdown` at implementation — see Risks. If clean delegation proves awkward, the fallback carrier is an MDX flow element `<CitationTable artifactId="…" />` via the already-enabled `remarkMdx` + `customMdxDeserialize`; the pure helpers adapt, the design is otherwise unchanged.)

### 5. Insert path — reuse "Send to editor"
`asMarkdownForEditor(artifact)` in `components/panels/artifacts-tab.tsx` (which today returns raw `content` for `kind:'table'`) returns the fenced marker for `kind === 'table'`:
````ts
if (artifact.kind === "table") {
  return "```citation-table\n" + artifact.id + "\n```"
}
````
The existing "Send to editor" flow (`appendToActiveDocumentOrCreate` + `requestEditorReload`) appends it to the doc Markdown → reload → deserialize rule builds the node → it renders. No new insert plumbing.

## Risks (explicit)

1. **Markdown deserialize delegation** — overriding the `"code"` rule must NOT break normal code blocks. The implementer pins how to delegate to the default `code` deserializer (or switches to the MDX-element carrier). The pure helpers are correct regardless; this is purely the rule-dispatch wiring.
2. **Void-node ↔ interactive child:** with `contentEditable={false}` the table's sort-header buttons shouldn't reach Slate's selection, but a click might still try to set the editor selection on the void node. If observed, add `stopPropagation`/`onMouseDown` guards on the table container. Verified manually.
3. **Missing artifact** — handled by the placeholder; a doc referencing an artifact absent from the current workspace shows "unavailable", never crashes.

## Testing

- **Pure** (`lib/shared/artifacts/citation-table-md.test.ts`, `bun:test`): `citationTableNodeToMdast` produces `{ type:"code", lang:"citation-table", value:id }`; `mdastCodeToCitationTableNode` rebuilds the node with the same `artifactId` and returns `null` for a `code` node with a different `lang` (and for a non-`code` node). A round-trip (`node → mdast → node`) preserves `artifactId`. `asMarkdownForEditor` returns the fenced marker for a `kind:'table'` artifact (and is unchanged for other kinds).
- **Node + plugin + rule wiring:** `bun run typecheck && bun run lint` + a **manual editor round-trip** (send a table to the editor, reload the doc, confirm the node re-renders) — documented in the PR test plan, since the editor isn't unit-tested here.

## Touch-point summary

| File | Change |
|---|---|
| `lib/shared/artifacts/citation-table-md.ts` | **new** — pure node↔mdast helpers |
| `lib/shared/artifacts/citation-table-md.test.ts` | **new** — round-trip + marker tests |
| `components/editor/plate-types.ts` | `citationTable` key + `MyCitationTableElement` |
| `components/editor/plugins/citation-table-kit.tsx` | **new** — the void-element plugin |
| `components/ui/citation-table-node.tsx` | **new** — the node component |
| `components/editor/editor-kit.tsx` (+ base kit) | register the kit |
| `components/editor/plugins/markdown-kit.tsx` | serialize + deserialize rules |
| `components/panels/artifacts-tab.tsx` | `asMarkdownForEditor` returns the marker for `table` |

## Scope

**L (novel)** but bounded to read-only embed + round-trip. The risk is isolated: the Markdown mapping lives in tested pure helpers; the rule dispatch + node component are thin glue verified by typecheck/lint + a manual round-trip. In-document editing (4b) is a small follow-up (pass `onChange` to the node's `CitationTableView`).
