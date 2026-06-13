import { describe, expect, test } from "bun:test"

import {
  citationMarkerAttrs,
  decorateWebCitations,
} from "./citation-marker"
import type { CitationMarkerMark } from "@/shared/verify"

const mark = (over: Partial<CitationMarkerMark>): CitationMarkerMark => ({
  markerId: "1",
  claimText: "The sky is blue.",
  status: "unsupported",
  ...over,
})

describe("citationMarkerAttrs", () => {
  test("unsupported gets a red wavy underline + tooltip", () => {
    const { className, title } = citationMarkerAttrs(mark({ status: "unsupported" }))
    expect(className).toContain("citation-marker")
    expect(className).toContain("text-red-600")
    expect(title).toContain("The sky is blue.")
    expect(title).toContain("not found in cited sources")
  })

  test("partial gets the marker class + tooltip but no color", () => {
    const { className, title } = citationMarkerAttrs(mark({ status: "partial" }))
    expect(className).toContain("citation-marker")
    expect(className).not.toContain("text-red-600")
    expect(title).toContain("partially supported")
  })
})

describe("decorateWebCitations", () => {
  test("wraps a flagged [N] in a citation-marker button", () => {
    const marks = new Map<string, CitationMarkerMark>([["1", mark({})]])
    const html = decorateWebCitations("<p>The sky is blue [1].</p>", 1, marks)
    expect(html).toContain("citation-marker")
    expect(html).toContain("text-red-600")
    expect(html).toContain('data-citation-index="1"')
    expect(html).toContain("[1]")
  })

  test("an unflagged [N] is a plain web-citation button (no marker class)", () => {
    const html = decorateWebCitations("<p>Fact [1].</p>", 1, new Map())
    expect(html).toContain('class="web-citation"')
    expect(html).not.toContain("citation-marker")
  })

  test("decorates without a marks map (backward compatible)", () => {
    const html = decorateWebCitations("<p>Fact [1].</p>", 1)
    expect(html).toContain('class="web-citation"')
    expect(html).not.toContain("citation-marker")
  })

  test("out-of-range marker stays plain text", () => {
    const html = decorateWebCitations("<p>Fact [9].</p>", 1, new Map())
    expect(html).not.toContain("web-citation")
    expect(html).toContain("[9]")
  })
})
