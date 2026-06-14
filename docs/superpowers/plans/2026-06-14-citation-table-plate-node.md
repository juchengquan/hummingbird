# Citation-table Plate node (slice 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a citation-table artifact as a read-only void node inside the Plate editor document that renders the live `CitationTableView` and survives the editor's Markdown save/load round-trip.

**Architecture:** A void `citationTable` Plate element carries only an `artifactId`; its node component reads the live artifact from the Zustand store and renders `CitationTableView` read-only (placeholder when absent). The Markdown round-trip uses an **MDX flow element** carrier — `<citationTable artifactId="…" />` — serialized/deserialized by custom `MdRules` in the MarkdownPlugin. This carrier is purely additive (it does NOT override the built-in `code_block` rule): on deserialize, `@platejs/markdown`'s `customMdxDeserialize` dispatches an MDX element by its `name` to the rule keyed by the matching plugin (the exact mechanism `callout` and `date` already use in this repo). The real round-trip logic lives in tiny pure helpers in `lib/shared` (unit-tested); the rules and node component are thin glue verified by typecheck/lint + a manual editor round-trip.

**Tech Stack:** TypeScript · React 19 · Plate.js (`platejs`, `platejs/react`) · `@platejs/markdown` (MdRules / MDX) · Zustand · `bun:test`.

---

## Background the implementer needs

**The editor document is Markdown.** `components/panels/editor.tsx` serializes the Plate value to Markdown on every change (`serializeMd(editor)` → `setDocumentContent`) and deserializes Markdown on load (`editor.api.markdown.deserialize(markdown)`). So a custom node must round-trip through Markdown text — it cannot just live in the Plate value.

**Why MDX flow element, not a fenced code block.** Fenced code blocks deserialize through the built-in `code_block` rule (mdast `code` → rule `code_block`); intercepting them would force us to override that rule and replicate its default for non-marker code. The MDX path needs no override: `@platejs/markdown`'s `customMdxDeserialize` (in `node_modules/@platejs/markdown/dist/index.js`) does `key = getPluginKey(editor, mdastNode.name) ?? mdastNode.name` then `getDeserializerByKey(key)` — so an MDX element named `citationTable` is routed to the rule keyed `citationTable`. The built-in `callout` and `date` rules in this same file serialize to `mdxJsxFlowElement` / `mdxJsxTextElement` and rely on exactly this dispatch.

**The MDX mdast shapes** (confirmed against the installed package):
- An MDX flow element node: `{ type: 'mdxJsxFlowElement', name: string, attributes: Array<{ type: 'mdxJsxAttribute', name: string, value: string }>, children: [] }`.
- Serialize rule for an element returns that mdast node (see `callout` rule). Deserialize rule receives that mdast node and returns the Slate node (see `callout` rule, which reads `parseAttributes(mdastNode.attributes)`).
- We hand-build/read the single `artifactId` attribute directly (the shape is tiny and known) so the pure helper has **no dependency on `@platejs/markdown`** and stays trivially testable.

**Existing patterns to mirror:**
- Void element type interface: `MyHrElement` in `components/editor/plate-types.ts:81` (`children: [EmptyText]`).
- Void element kit: `DateKit` (`components/editor/plugins/date-kit.tsx`) — `[DatePlugin.withComponent(DateElement)]`. We build our own plugin with `createPlatePlugin`.
- Node component reading the store: `components/editor/plugins/ai-kit.tsx` imports `useStore from '@/client/hooks/use-store'`. `CitationTableView` lives at `components/panels/citation-table.tsx` and takes `{ data, onChange? }` — omit `onChange` for read-only.
- The store selector for an artifact by id: artifacts are `useStore((s) => s.artifacts)` (array of `Artifact` with `.id`, `.content`). `parseCitationTable(content)` is in `@/shared/artifacts/citation-table`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/shared/artifacts/citation-table-md.ts` | **new** — `CITATION_TABLE_KEY` constant + pure `citationTableNodeToMdast` / `mdastMdxToCitationTableNode` / `citationTableMarkerMarkdown` helpers (no Plate/React deps) |
| `lib/shared/artifacts/citation-table-md.test.ts` | **new** — `bun:test` round-trip + marker tests |
| `components/editor/plate-types.ts` | add `MyCitationTableElement` + add it to the `MyValue` union |
| `components/ui/citation-table-node.tsx` | **new** — the read-only void node component |
| `components/editor/plugins/citation-table-kit.tsx` | **new** — the void-element plugin |
| `components/editor/editor-kit.tsx` | register `...CitationTableKit` |
| `components/editor/plugins/markdown-kit.tsx` | add `rules` with `citationTable` serialize + deserialize |
| `components/panels/artifacts-tab.tsx` | `asMarkdownForEditor` returns the MDX marker for `kind:'table'` |

---

## Task 1: Pure Markdown round-trip helpers

**Files:**
- Create: `lib/shared/artifacts/citation-table-md.ts`
- Test: `lib/shared/artifacts/citation-table-md.test.ts`

This task holds the only real logic and is fully unit-tested. The helpers are pure and depend on nothing from Plate or React.

- [ ] **Step 1: Write the failing test**

Create `lib/shared/artifacts/citation-table-md.test.ts`:

```ts
import { describe, expect, it } from "bun:test"

import {
  CITATION_TABLE_KEY,
  citationTableMarkerMarkdown,
  citationTableNodeToMdast,
  mdastMdxToCitationTableNode,
} from "./citation-table-md"

describe("citationTableNodeToMdast", () => {
  it("produces an mdxJsxFlowElement carrying the artifactId attribute", () => {
    const mdast = citationTableNodeToMdast({ artifactId: "abc-123" })
    expect(mdast).toEqual({
      type: "mdxJsxFlowElement",
      name: CITATION_TABLE_KEY,
      attributes: [
        { type: "mdxJsxAttribute", name: "artifactId", value: "abc-123" },
      ],
      children: [],
    })
  })
})

describe("mdastMdxToCitationTableNode", () => {
  it("rebuilds the slate node with the same artifactId", () => {
    const node = mdastMdxToCitationTableNode({
      type: "mdxJsxFlowElement",
      name: CITATION_TABLE_KEY,
      attributes: [
        { type: "mdxJsxAttribute", name: "artifactId", value: "abc-123" },
      ],
    })
    expect(node).toEqual({
      type: CITATION_TABLE_KEY,
      artifactId: "abc-123",
      children: [{ text: "" }],
    })
  })

  it("returns null for an MDX element with a different name", () => {
    expect(
      mdastMdxToCitationTableNode({
        type: "mdxJsxFlowElement",
        name: "callout",
        attributes: [],
      }),
    ).toBeNull()
  })

  it("defaults artifactId to empty string when the attribute is missing", () => {
    const node = mdastMdxToCitationTableNode({
      type: "mdxJsxFlowElement",
      name: CITATION_TABLE_KEY,
      attributes: [],
    })
    expect(node).toEqual({
      type: CITATION_TABLE_KEY,
      artifactId: "",
      children: [{ text: "" }],
    })
  })

  it("round-trips node -> mdast -> node preserving artifactId", () => {
    const mdast = citationTableNodeToMdast({ artifactId: "round-trip-id" })
    const node = mdastMdxToCitationTableNode(mdast)
    expect(node?.artifactId).toBe("round-trip-id")
  })
})

describe("citationTableMarkerMarkdown", () => {
  it("returns a standalone MDX element on its own lines", () => {
    expect(citationTableMarkerMarkdown("abc-123")).toBe(
      '\n<citationTable artifactId="abc-123" />\n',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/shared/artifacts/citation-table-md.test.ts`
Expected: FAIL — `Cannot find module './citation-table-md'`.

- [ ] **Step 3: Write the implementation**

Create `lib/shared/artifacts/citation-table-md.ts`:

```ts
/**
 * Pure round-trip helpers for embedding a citation-table artifact in the
 * editor's Markdown as an MDX flow element: `<citationTable artifactId="…" />`.
 *
 * The editor document persists as Markdown, so a custom Plate node must
 * serialize to / deserialize from Markdown text. We use an MDX flow element
 * (the same carrier the built-in `callout`/`date` nodes use) because the
 * `@platejs/markdown` deserializer dispatches an MDX element by its `name` to
 * the rule keyed by the matching plugin — no override of the built-in
 * `code_block` rule needed. These helpers have no Plate/React dependency so
 * they unit-test trivially; the editor wiring lives in `markdown-kit.tsx`.
 */

/** The Plate node type AND the MDX tag name. Kept identical so the markdown
 *  deserializer's `getPluginKey(editor, name)` lookup resolves to our rule. */
export const CITATION_TABLE_KEY = "citationTable"

/** A minimal mdast MDX-attribute shape (only what we read/write). */
interface MdxAttribute {
  type: "mdxJsxAttribute"
  name: string
  value: string
}

/** A minimal mdast MDX-flow-element shape (only what we read/write). */
export interface CitationTableMdast {
  type: "mdxJsxFlowElement"
  name: string
  attributes: MdxAttribute[]
  children: []
}

/** A `citationTable` slate node → its MDX flow-element mdast carrier. */
export function citationTableNodeToMdast(node: {
  artifactId: string
}): CitationTableMdast {
  return {
    type: "mdxJsxFlowElement",
    name: CITATION_TABLE_KEY,
    attributes: [
      { type: "mdxJsxAttribute", name: "artifactId", value: node.artifactId },
    ],
    children: [],
  }
}

/** An MDX flow-element mdast node → a `citationTable` slate node, or `null`
 *  when it is not our marker (a different `name`). When it IS our marker,
 *  a missing `artifactId` attribute defaults to `""` (renders a placeholder
 *  downstream — never throws). */
export function mdastMdxToCitationTableNode(mdastNode: {
  type?: string
  name?: string
  attributes?: { name?: string; value?: string }[]
}): { type: string; artifactId: string; children: [{ text: "" }] } | null {
  if (mdastNode.name !== CITATION_TABLE_KEY) return null
  const attr = mdastNode.attributes?.find((a) => a.name === "artifactId")
  return {
    type: CITATION_TABLE_KEY,
    artifactId: attr?.value ?? "",
    children: [{ text: "" }],
  }
}

/** The Markdown snippet inserted when sending a table artifact to the editor.
 *  Surrounding newlines keep it a standalone block so remark parses it as an
 *  MDX flow element. */
export function citationTableMarkerMarkdown(artifactId: string): string {
  return `\n<${CITATION_TABLE_KEY} artifactId="${artifactId}" />\n`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/shared/artifacts/citation-table-md.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/citation-table-md.ts lib/shared/artifacts/citation-table-md.test.ts
git commit -m "feat(citation-table): pure MDX round-trip helpers for the Plate node"
```

---

## Task 2: Element type

**Files:**
- Modify: `components/editor/plate-types.ts`

Add the void-element interface (mirrors `MyHrElement` at `components/editor/plate-types.ts:81`) and add it to the `MyValue` union so the editor value type knows about it. The `type` field is the shared constant from Task 1 (not a `KEYS.*`, since this is a custom node).

- [ ] **Step 1: Add the import for the key constant**

At the top of `components/editor/plate-types.ts`, below the existing `import type { … } from 'platejs';` block (ends at line 23), add:

```ts
import { CITATION_TABLE_KEY } from '@/shared/artifacts/citation-table-md';
```

(This is a value import, not `import type` — `CITATION_TABLE_KEY` is a runtime constant used in the `typeof` position.)

- [ ] **Step 2: Add the element interface**

Immediately after the `MyHrElement` interface (ends at `components/editor/plate-types.ts:84`), add:

```ts
export interface MyCitationTableElement extends MyBlockElement {
  artifactId: string;
  children: [EmptyText];
  type: typeof CITATION_TABLE_KEY;
}
```

- [ ] **Step 3: Add it to the `MyValue` union**

In the `MyValue` type (currently `components/editor/plate-types.ts:148-163`), add `| MyCitationTableElement` to the union — insert it after `| MyBlockquoteElement` so the list stays alphabetical-ish:

```ts
export type MyValue = (
  | MyBlockquoteElement
  | MyCitationTableElement
  | MyCodeBlockElement
  | MyH1Element
  | MyH2Element
  | MyH3Element
  | MyH4Element
  | MyH5Element
  | MyH6Element
  | MyHrElement
  | MyImageElement
  | MyMediaEmbedElement
  | MyParagraphElement
  | MyTableElement
  | MyToggleElement
)[];
```

- [ ] **Step 4: Verify it typechecks**

Run: `bun run typecheck`
Expected: PASS (no errors). The new interface is referenced nowhere yet, so this only confirms the import + syntax are valid.

- [ ] **Step 5: Commit**

```bash
git add components/editor/plate-types.ts
git commit -m "feat(citation-table): add MyCitationTableElement editor type"
```

---

## Task 3: Node component

**Files:**
- Create: `components/ui/citation-table-node.tsx`

A read-only void node. Reads the live artifact from the store by `element.artifactId`, parses it, and renders `CitationTableView` (no `onChange` → read-only). Missing artifact or unparseable content → an inert placeholder. `contentEditable={false}` because it is a void/atomic node. Renders `{props.children}` (the empty text Slate requires on a void node).

- [ ] **Step 1: Write the component**

Create `components/ui/citation-table-node.tsx`:

```tsx
'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { CitationTableView } from '@/components/panels/citation-table';
import { useStore } from '@/client/hooks/use-store';
import { parseCitationTable } from '@/shared/artifacts/citation-table';
import type { MyCitationTableElement } from '@/components/editor/plate-types';

export function CitationTableElement(
  props: PlateElementProps<MyCitationTableElement>,
) {
  const { element } = props;
  const artifact = useStore((s) =>
    s.artifacts.find((a) => a.id === element.artifactId),
  );
  const table = artifact ? parseCitationTable(artifact.content) : null;

  return (
    <PlateElement {...props} contentEditable={false}>
      <div className="my-2 overflow-hidden rounded-md border border-[var(--border)]">
        {table ? (
          <CitationTableView data={table} />
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

Notes for the implementer:
- `useStore` is the Zustand hook at `@/client/hooks/use-store` (already used inside `components/editor/plugins/ai-kit.tsx`). `s.artifacts` is the artifacts array.
- `CitationTableView` and `parseCitationTable` already exist (slices 1–3). Do NOT pass `onChange` — read-only is the whole point of 4a.
- The element type is `MyCitationTableElement` from Task 2.

- [ ] **Step 2: Verify it typechecks**

Run: `bun run typecheck`
Expected: PASS. (Component is not yet referenced by any kit; this confirms the props typing + imports.)

- [ ] **Step 3: Commit**

```bash
git add components/ui/citation-table-node.tsx
git commit -m "feat(citation-table): read-only Plate node component"
```

---

## Task 4: Plugin + register in EditorKit

**Files:**
- Create: `components/editor/plugins/citation-table-kit.tsx`
- Modify: `components/editor/editor-kit.tsx`

Register the node type as a **void element** plugin keyed `citationTable` (so the markdown deserializer's `getPluginKey(editor, 'citationTable')` resolves) bound to the Task 3 component.

- [ ] **Step 1: Write the kit**

Create `components/editor/plugins/citation-table-kit.tsx`:

```tsx
'use client';

import { createPlatePlugin } from 'platejs/react';

import { CitationTableElement } from '@/components/ui/citation-table-node';
import { CITATION_TABLE_KEY } from '@/shared/artifacts/citation-table-md';

export const CitationTablePlugin = createPlatePlugin({
  key: CITATION_TABLE_KEY,
  node: {
    isElement: true,
    isVoid: true,
  },
}).withComponent(CitationTableElement);

export const CitationTableKit = [CitationTablePlugin];
```

Notes:
- `createPlatePlugin` is imported from `platejs/react` (same import the toolbar/discussion kits use). Setting `key` makes the node `type` default to that key — so the plugin's node type is `citationTable`, matching `MyCitationTableElement.type`.
- `isVoid: true` marks it atomic (no editable text children); `isElement: true` makes it a block element.

- [ ] **Step 2: Register it in `EditorKit`**

In `components/editor/editor-kit.tsx`:

1. Add the import alongside the other plugin imports (after the `CalloutKit` import at line 13, keeping rough alpha order):

```ts
import { CitationTableKit } from '@/components/editor/plugins/citation-table-kit';
```

2. Add `...CitationTableKit` to the `EditorKit` array, in the `// Elements` group — put it right after `...CalloutKit` (line 52):

```ts
  ...MediaKit,
  ...CalloutKit,
  ...CitationTableKit,
  ...ColumnKit,
```

- [ ] **Step 3: Verify it typechecks**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/editor/plugins/citation-table-kit.tsx components/editor/editor-kit.tsx
git commit -m "feat(citation-table): register the void-element plugin in EditorKit"
```

---

## Task 5: Markdown serialize/deserialize rules

**Files:**
- Modify: `components/editor/plugins/markdown-kit.tsx`

Add `rules` to the `MarkdownPlugin` config. A `citationTable` rule provides BOTH directions, using the Task 1 pure helpers:
- `serialize(slateNode)` → `citationTableNodeToMdast(slateNode)` (the MDX flow element).
- `deserialize(mdastNode)` → `mdastMdxToCitationTableNode(mdastNode)`, falling back to a zero-id node (defensive — the dispatch only routes our element here, so this branch is for type-safety, never hit in practice).

This is purely additive: it touches no existing rule, so normal Markdown (including code blocks) is unaffected.

- [ ] **Step 1: Write the rules**

Replace the entire contents of `components/editor/plugins/markdown-kit.tsx` with:

```tsx
import { MarkdownPlugin, remarkMdx, remarkMention } from '@platejs/markdown';
import { KEYS } from 'platejs';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import {
  CITATION_TABLE_KEY,
  citationTableNodeToMdast,
  mdastMdxToCitationTableNode,
} from '@/shared/artifacts/citation-table-md';

export const MarkdownKit = [
  MarkdownPlugin.configure({
    options: {
      plainMarks: [KEYS.suggestion, KEYS.comment],
      remarkPlugins: [remarkMath, remarkGfm, remarkMdx, remarkMention],
      rules: {
        [CITATION_TABLE_KEY]: {
          serialize: (slateNode: { artifactId?: string }) =>
            citationTableNodeToMdast({ artifactId: slateNode.artifactId ?? '' }),
          deserialize: (mdastNode: {
            name?: string;
            attributes?: { name?: string; value?: string }[];
          }) =>
            mdastMdxToCitationTableNode(mdastNode) ?? {
              type: CITATION_TABLE_KEY,
              artifactId: '',
              children: [{ text: '' }],
            },
        },
      },
    },
  }),
];
```

Notes:
- `MdRules` is typed `Partial<{…}> & Record<string, AnyNodeParser>`, so a string-keyed custom rule (`[CITATION_TABLE_KEY]`) is valid. `AnyNodeParser`'s `serialize`/`deserialize` are `(…) => any`, so the inline param types above satisfy it.
- If `bun run typecheck` complains the computed key needs the rule object typed, cast the rule object `as const` is NOT needed; the `Record<string, AnyNodeParser>` index signature accepts it. If a type error appears on the `rules` object, wrap the single rule's functions to match (they already return plain objects).

- [ ] **Step 2: Verify it typechecks and lints**

Run: `bun run check`
Expected: PASS (typecheck + lint). This is the primary gate for Tasks 2–5 — the rules, plugin, component, and element type are now all wired and must compile together.

- [ ] **Step 3: Commit**

```bash
git add components/editor/plugins/markdown-kit.tsx
git commit -m "feat(citation-table): MDX serialize/deserialize rules for the Plate node"
```

---

## Task 6: Wire "Send to editor" to emit the marker

**Files:**
- Modify: `components/panels/artifacts-tab.tsx`

`asMarkdownForEditor` (at `components/panels/artifacts-tab.tsx:55`) currently returns raw `content` for a `kind:'table'` artifact. Make it return the MDX marker so the existing "Send to editor" flow (`appendToActiveDocumentOrCreate(asMarkdownForEditor(a))` + `requestEditorReload()`, lines 99–101) inserts a node that the Task 5 deserialize rule turns into our element.

- [ ] **Step 1: Add the import**

Below the existing `import { parseCitationTable } from "@/shared/artifacts/citation-table"` (line 45), add:

```ts
import { citationTableMarkerMarkdown } from "@/shared/artifacts/citation-table-md"
```

- [ ] **Step 2: Return the marker for table artifacts**

In `asMarkdownForEditor`, add a `table` branch BEFORE the final `return artifact.content` (i.e. after the `image` branch that ends at line 73). Insert:

```ts
  if (artifact.kind === "table") {
    return citationTableMarkerMarkdown(artifact.id)
  }
```

So the function tail reads:

```ts
  if (artifact.kind === "image") {
    const src = artifact.storagePath ?? artifact.content
    return artifact.content
      ? `![${artifact.content.slice(0, 60)}](${src})`
      : `![](${src})`
  }
  if (artifact.kind === "table") {
    return citationTableMarkerMarkdown(artifact.id)
  }
  return artifact.content
}
```

- [ ] **Step 3: Verify it typechecks and lints**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/panels/artifacts-tab.tsx
git commit -m "feat(citation-table): send-to-editor inserts the MDX marker for table artifacts"
```

---

## Task 7: Full verification + manual round-trip

**Files:** none (verification only).

- [ ] **Step 1: Run the pure tests**

Run: `bun test lib/shared/artifacts/citation-table-md.test.ts`
Expected: PASS — all Task 1 assertions green.

- [ ] **Step 2: Run the full fast gate**

Run: `bun run check`
Expected: PASS (typecheck + lint, mirrors CI without build).

- [ ] **Step 3: Manual editor round-trip (document in the PR test plan)**

Run `bun dev`, then in the app:
1. Generate or open a `kind:'table'` citation-table artifact (Artifacts tab) — e.g. via the "Extract to table" action on a research message (slice 2).
2. Click **Send to editor** on that artifact.
3. Confirm the editor renders the citation table as an embedded node (sortable headers visible, cells read-only).
4. Trigger a reload of the document (switch documents/workspaces and back, or reload the page) so the editor re-deserializes its Markdown.
5. Confirm the node re-renders identically (the `<citationTable artifactId="…" />` Markdown round-tripped).
6. Confirm a normal fenced code block elsewhere in the doc still renders as a code block (the rules are additive and didn't disturb `code_block`).
7. Edge: delete the underlying artifact, reload — confirm the node shows the "Citation table unavailable" placeholder and does not crash.

Record the observed results in the PR description's Test Plan section.

- [ ] **Step 4: Final commit (only if Step 3 surfaced a fix)**

If the manual round-trip required any change, commit it with a descriptive message. Otherwise nothing to commit — proceed to finishing the branch.

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- Carrier (MDX flow element) + round-trip → Tasks 1 + 5. (Spec's fenced-code carrier was its risk #1; the plan resolves it to the spec's explicitly-anticipated MDX fallback — cleaner because additive. Data model unchanged.)
- Element type `MyCitationTableElement` → Task 2.
- Node component (read-only, store-backed, placeholder) → Task 3.
- Plugin (void element) + EditorKit registration → Task 4.
- Insert via `asMarkdownForEditor` reusing Send-to-editor → Task 6.
- Pure helpers + unit tests → Task 1. `citationTableMarkerMarkdown` extracted to `lib/shared` so the marker is unit-tested (spec asked to test `asMarkdownForEditor`; testing the shared helper it now delegates to is the testable equivalent).
- Testing (pure + typecheck/lint + manual round-trip) → Tasks 1, 5, 6, 7.
- Out of scope (4b in-doc editing) → honored: no `onChange` passed.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code.

**3. Type consistency:** `CITATION_TABLE_KEY` is the single source for the node type / MDX name / plugin key across Tasks 1–6. `MyCitationTableElement.type = typeof CITATION_TABLE_KEY`. Helper names (`citationTableNodeToMdast`, `mdastMdxToCitationTableNode`, `citationTableMarkerMarkdown`) are identical in their definition (Task 1) and every use (Tasks 5, 6). Component `CitationTableElement` defined in Task 3, consumed in Task 4. Kit `CitationTableKit` defined in Task 4, registered same task.
