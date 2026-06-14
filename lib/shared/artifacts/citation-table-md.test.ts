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
