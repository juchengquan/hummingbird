import { describe, expect, test } from "bun:test"

import {
  buildExtractTablePrompt,
  extractionToCitationTable,
} from "./extract-table"

const sources = [
  { id: "s1", title: "Trial A", url: "https://a.test" },
  { id: "s2", title: "Trial B", url: "https://b.test" },
]

describe("buildExtractTablePrompt", () => {
  test("no hints → today's prompt unchanged (regression guard)", () => {
    const prompt = buildExtractTablePrompt("report body", sources)
    expect(prompt).toContain("REPORT:")
    expect(prompt).toContain("report body")
    expect(prompt).toContain("SOURCES (cite by number):")
    expect(prompt).toContain("[1] Trial A")
    expect(prompt).not.toContain("(Text)")
    expect(prompt).not.toContain("(Number)")
    expect(prompt).toContain("Build a table capturing the key comparable attributes")
  })

  test("string[] hints still work (back-compat thin signature)", () => {
    const prompt = buildExtractTablePrompt("report", sources, ["Drug", "N"])
    expect(prompt).toContain("Required columns")
    expect(prompt).toContain("`Drug`")
    expect(prompt).toContain("`N`")
    expect(prompt).toContain("EXACTLY these columns")
  })

  test("typed hints render the type suffix in the prompt", () => {
    const prompt = buildExtractTablePrompt("report", sources, [
      { label: "Drug", type: "text" },
      { label: "Sample size", type: "number" },
    ])
    expect(prompt).toContain("`Drug` (Text)")
    expect(prompt).toContain("`Sample size` (Number)")
  })

  test("Number hints instruct 'emit bare numeric value, no units'", () => {
    const prompt = buildExtractTablePrompt("report", sources, [
      { label: "N", type: "number" },
    ])
    expect(prompt).toContain("emit the bare numeric value")
    expect(prompt).toContain('"200" not "two hundred"')
  })

  test("Text hints have no per-type instruction line", () => {
    const prompt = buildExtractTablePrompt("report", sources, [
      { label: "Drug", type: "text" },
    ])
    expect(prompt).toContain("`Drug` (Text)")
    expect(prompt).not.toContain("emit the bare numeric value")
  })

  test("mixed Text + Number hints render correctly", () => {
    const prompt = buildExtractTablePrompt("report", sources, [
      { label: "Drug", type: "text" },
      { label: "N", type: "number" },
    ])
    expect(prompt).toContain("`Drug` (Text)")
    expect(prompt).toContain("`N` (Number)")
    expect(prompt).toContain("emit the bare numeric value")
  })
})

describe("buildExtractTablePrompt (link + date hints)", () => {
  test("renders the (Link) / (Date) label suffixes", () => {
    const prompt = buildExtractTablePrompt("report", sources, [
      { label: "Home page", type: "link" },
      { label: "Launched", type: "date" },
    ])
    expect(prompt).toContain("`Home page` (Link)")
    expect(prompt).toContain("`Launched` (Date)")
  })
  test("Link hints add the http(s) URL instruction", () => {
    const prompt = buildExtractTablePrompt("report", sources, [{ label: "Site", type: "link" }])
    expect(prompt).toContain("emit a full http(s):// URL")
  })
  test("Date hints add the YYYY-MM-DD instruction", () => {
    const prompt = buildExtractTablePrompt("report", sources, [{ label: "When", type: "date" }])
    expect(prompt).toContain("YYYY-MM-DD")
  })
  test("Text-only hints still add no per-type format block", () => {
    const prompt = buildExtractTablePrompt("report", sources, [{ label: "Drug", type: "text" }])
    expect(prompt).not.toContain("Per-type value format")
  })
  test("no-hints path stays unchanged (regression guard)", () => {
    const prompt = buildExtractTablePrompt("report body", sources)
    expect(prompt).not.toContain("Per-type value format")
    expect(prompt).toContain("Build a table capturing the key comparable attributes")
  })
})

describe("extractionToCitationTable", () => {
  test("fills type:'text' on write when extraction omits type", () => {
    const out = extractionToCitationTable(
      {
        columns: [{ id: "drug", label: "Drug" }],
        rows: [{ cells: [{ columnId: "drug", value: "Aspirin", citations: [] }] }],
      },
      sources,
    )
    expect(out.columns[0].type).toBe("text")
  })

  test("carries type:'number' through when extraction supplies it", () => {
    const out = extractionToCitationTable(
      {
        columns: [{ id: "n", label: "N", type: "number" }],
        rows: [{ cells: [{ columnId: "n", value: "200", citations: [] }] }],
      },
      sources,
    )
    expect(out.columns[0].type).toBe("number")
  })

  test("tolerates a column missing the type field", () => {
    const out = extractionToCitationTable(
      {
        columns: [{ id: "drug", label: "Drug" }],
        rows: [],
      },
      sources,
    )
    expect(out.columns[0].type).toBe("text")
  })

  test("cells and citations are unaffected by the type fill", () => {
    const out = extractionToCitationTable(
      {
        columns: [{ id: "drug", label: "Drug" }],
        rows: [
          {
            cells: [
              {
                columnId: "drug",
                value: "Aspirin",
                citations: [{ source: 1, quote: "Aspirin was administered" }],
              },
            ],
          },
        ],
      },
      sources,
    )
    expect(out.rows[0].drug.value).toBe("Aspirin")
    expect(out.rows[0].drug.citations).toEqual([
      { sourceId: "s1", quote: "Aspirin was administered" },
    ])
  })
})
