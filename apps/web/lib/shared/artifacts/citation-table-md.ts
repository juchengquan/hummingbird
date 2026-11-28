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
  attributes?: { type?: string; name?: string; value?: string }[]
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
