import { describe, expect, test } from "bun:test"

import {
  citationMarkerAttrs,
  decorateWebCitations,
  replaceInHtmlText,
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

  test("markers inside tags / attributes are left alone", () => {
    const input =
      '<p><a href="https://e.com/?q= [1]" title="see [2]">link [1]</a> ' +
      '<img src="https://e.com/a [1].png" alt="fig [2]"> after [2]</p>'
    const html = decorateWebCitations(input, 2, new Map())
    // Attributes survive byte-for-byte.
    expect(html).toContain('href="https://e.com/?q= [1]"')
    expect(html).toContain('title="see [2]"')
    expect(html).toContain('<img src="https://e.com/a [1].png" alt="fig [2]">')
    // Text runs are still decorated.
    expect(html).toContain('link <button type="button" class="web-citation" data-citation-index="1">[1]</button>')
    expect(html).toContain('after <button type="button" class="web-citation" data-citation-index="2">[2]</button>')
    expect(html.match(/<button/g)).toHaveLength(2)
  })

  test("a marker at the start of a text run (right after a tag) is decorated", () => {
    expect(decorateWebCitations("<p><em>x</em>[1]</p>", 1)).toContain(
      '<em>x</em><button type="button" class="web-citation" data-citation-index="1">[1]</button>'
    )
  })

  test("flagged claim text is attribute-escaped in the tooltip", () => {
    const marks = new Map([["1", mark({ claimText: 'a "q" <b> & c' })]])
    const html = decorateWebCitations("<p>Fact [1].</p>", 1, marks)
    expect(html).toContain('title="a &quot;q&quot; &lt;b&gt; &amp; c')
  })
})

describe("replaceInHtmlText", () => {
  test("rewrites text runs only", () => {
    expect(
      replaceInHtmlText('<a title="X">X</a> X', /X/g, () => "Y")
    ).toBe('<a title="X">Y</a> Y')
  })
})
