import { describe, expect, test } from "bun:test"

import { formatResearchCitations } from "./citation-formatter"

describe("formatResearchCitations — pass-through cases", () => {
  test("returns input verbatim when there's no Sources block", () => {
    const md = "# Title\n\nSome text without a sources list.\n"
    expect(formatResearchCitations(md)).toBe(md)
  })

  test("returns input verbatim on an empty Sources block", () => {
    const md =
      "Body with [1] marker.\n\n## Sources\n\n   \n"
    expect(formatResearchCitations(md)).toBe(md)
  })
})

describe("formatResearchCitations — happy path", () => {
  test("already-canonical numbering is preserved (idempotent)", () => {
    const md =
      "Intro. [1]\n\n## Section A\n\nClaim. [2]\n\n## Sources\n[1] First — https://a.test\n[2] Second — https://b.test\n"
    const out = formatResearchCitations(md)
    // Run twice; same result.
    expect(formatResearchCitations(out)).toBe(out)
    expect(out).toContain("[1]")
    expect(out).toContain("[2]")
    expect(out).toContain("[1] First — https://a.test")
    expect(out).toContain("[2] Second — https://b.test")
  })

  test("renumbers in first-appearance order when the model's numbering skewed", () => {
    // Model lists `[5]` first and `[1]` second in the body; we want them
    // re-mapped to `[1]` and `[2]` in document order.
    const md = [
      "Intro paragraph. [5]",
      "",
      "## Section A",
      "",
      "Claim B. [1]",
      "",
      "## Sources",
      "[1] B — https://b.test",
      "[5] A — https://a.test",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    // First marker in the body should now be `[1]` and bind to A.
    expect(out.indexOf("[1]")).toBeLessThan(out.indexOf("[2]"))
    expect(out).toContain("[1] A — https://a.test")
    expect(out).toContain("[2] B — https://b.test")
  })

  test("deduplicates two sources with the same URL onto one canonical number", () => {
    // The model wrote both `[1]` and `[2]` for the same URL.
    const md = [
      "Claim A. [1]",
      "",
      "Restated. [2]",
      "",
      "## Sources",
      "[1] Title — https://same.test",
      "[2] Title (mirror) — https://same.test",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    // Both inline markers collapse to `[1]`; the Sources block has one entry.
    expect((out.match(/\[1\]/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(out).not.toContain("[2]")
    const sourcesBlock = out.split("## Sources")[1]
    expect(sourcesBlock.match(/\[1\]/g)?.length).toBe(1)
  })

  test("leaves a marker pointing at an unknown index alone", () => {
    const md = [
      "Real source. [1]",
      "Hallucinated. [9]",
      "",
      "## Sources",
      "[1] Real — https://r.test",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    // The `[9]` marker has no source in the Sources block, so we keep it.
    expect(out).toContain("[9]")
    expect(out).toContain("[1] Real — https://r.test")
  })

  test("appends Sources-only entries (never cited inline) after body-derived ones", () => {
    const md = [
      "Only cite source 2. [2]",
      "",
      "## Sources",
      "[1] Never cited — https://x.test",
      "[2] Cited — https://y.test",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    // Cited source becomes [1]; uncited follows as [2].
    expect(out).toContain("[1] Cited — https://y.test")
    expect(out).toContain("[2] Never cited — https://x.test")
  })

  test("handles `file:` markers via filename dedup", () => {
    const md = [
      "From the file. [1]",
      "Restated. [2]",
      "",
      "## Sources",
      "[1] file: report.pdf",
      "[2] file: Report.PDF",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    // Case-insensitive file dedup → single canonical entry.
    expect(out).toContain("[1] file: report.pdf")
    const sourcesBlock = out.split("## Sources")[1]
    expect(sourcesBlock.match(/\[\d+\]/g)?.length).toBe(1)
  })

  test("preserves the model's heading level (##, ###, …)", () => {
    const md = [
      "Inline. [1]",
      "",
      "### Sources",
      "[1] A — https://a.test",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    expect(out).toContain("### Sources")
    // The model used `###`; rebuilt heading should be the same line.
    // (a strict-`##` heading would appear at the start of a line; we
    // assert against that with the line anchor.)
    expect(out.split("\n").some((l) => l === "## Sources")).toBe(false)
  })

  test("strips trailing punctuation when computing URL identity", () => {
    // Trailing paren shouldn't make the two entries look like different URLs.
    const md = [
      "[1]",
      "[2]",
      "",
      "## Sources",
      "[1] A — https://a.test)",
      "[2] A mirror — https://a.test",
      "",
    ].join("\n")
    const out = formatResearchCitations(md)
    const sourcesBlock = out.split("## Sources")[1]
    expect(sourcesBlock.match(/\[\d+\]/g)?.length).toBe(1)
  })

  test("idempotent on the model's gnarliest reasonable case", () => {
    const md = [
      "Summary [3]. More text [1] continues [3].",
      "",
      "## Section",
      "More [2].",
      "",
      "## Sources",
      "[1] Beta — https://b.test",
      "[2] Gamma — https://g.test",
      "[3] Alpha — https://a.test",
      "",
    ].join("\n")
    const once = formatResearchCitations(md)
    const twice = formatResearchCitations(once)
    expect(twice).toBe(once)
    expect(once).toContain("[1] Alpha — https://a.test")
    expect(once).toContain("[2] Beta — https://b.test")
    expect(once).toContain("[3] Gamma — https://g.test")
  })
})
