import { describe, expect, test } from "bun:test"

import { CitationTableSchema } from "./citation-table"
import {
  ExtractionSchema,
  buildExtractTablePrompt,
  extractionToCitationTable,
} from "./extract-table"

const sources = [
  { id: "s1", title: "Trial A", url: "https://a.test", snippet: "snip a" },
  { id: "s2", title: "Trial B" },
]

const extraction = {
  columns: [
    { id: "drug", label: "Drug" },
    { id: "n", label: "Sample size" },
  ],
  rows: [
    {
      cells: [
        { columnId: "drug", value: "Aspirin", citations: [{ source: 1, quote: "Aspirin used" }] },
        { columnId: "n", value: "200", citations: [] },
      ],
    },
  ],
}

describe("ExtractionSchema", () => {
  test("accepts a valid extraction", () => {
    expect(ExtractionSchema.safeParse(extraction).success).toBe(true)
  })
  test("rejects a non-integer source", () => {
    const bad = {
      columns: [{ id: "c", label: "C" }],
      rows: [{ cells: [{ columnId: "c", value: "x", citations: [{ source: "1", quote: "q" }] }] }],
    }
    expect(ExtractionSchema.safeParse(bad).success).toBe(false)
  })
  test("rejects a row without cells", () => {
    expect(
      ExtractionSchema.safeParse({ columns: [{ id: "c", label: "C" }], rows: [{}] }).success,
    ).toBe(false)
  })
})

describe("extractionToCitationTable", () => {
  test("maps cells → record and source numbers → sourceIds", () => {
    const out = extractionToCitationTable(ExtractionSchema.parse(extraction), sources)
    expect(out.columns.length).toBe(2)
    expect(out.rows[0].drug.value).toBe("Aspirin")
    expect(out.rows[0].drug.citations).toEqual([{ sourceId: "s1", quote: "Aspirin used" }])
    expect(out.rows[0].n.citations).toEqual([])
    expect(out.sources.map((s) => s.id)).toEqual(["s1", "s2"])
  })
  test("drops a citation whose source number is out of range", () => {
    const ex = ExtractionSchema.parse({
      columns: [{ id: "c", label: "C" }],
      rows: [{ cells: [{ columnId: "c", value: "x", citations: [{ source: 9, quote: "q" }] }] }],
    })
    expect(extractionToCitationTable(ex, sources).rows[0].c.citations).toEqual([])
  })
  test("ignores a cell tagged with an undeclared column", () => {
    const ex = ExtractionSchema.parse({
      columns: [{ id: "c", label: "C" }],
      rows: [{ cells: [{ columnId: "ghost", value: "x", citations: [] }] }],
    })
    expect(extractionToCitationTable(ex, sources).rows[0]).toEqual({})
  })
  test("coerces an empty source title to a non-empty value", () => {
    const out = extractionToCitationTable(
      ExtractionSchema.parse({ columns: [{ id: "c", label: "C" }], rows: [] }),
      [{ id: "s1", title: "", url: "https://x.test" }],
    )
    expect(out.sources[0].title.length).toBeGreaterThan(0)
    expect(CitationTableSchema.safeParse(out).success).toBe(true)
  })
  test("clamps an over-long snippet to 1000 chars", () => {
    const out = extractionToCitationTable(
      ExtractionSchema.parse({ columns: [{ id: "c", label: "C" }], rows: [] }),
      [{ id: "s1", title: "T", snippet: "x".repeat(2000) }],
    )
    expect(out.sources[0].snippet?.length).toBe(1000)
  })
  test("clamps an over-long title to 300 chars", () => {
    const out = extractionToCitationTable(
      ExtractionSchema.parse({ columns: [{ id: "c", label: "C" }], rows: [] }),
      [{ id: "s1", title: "A".repeat(400) }],
    )
    expect(out.sources[0].title.length).toBe(300)
    expect(CitationTableSchema.safeParse(out).success).toBe(true)
  })
})

describe("buildExtractTablePrompt", () => {
  test("includes numbered sources and the report text", () => {
    const p = buildExtractTablePrompt("THE REPORT BODY", sources)
    expect(p).toContain("THE REPORT BODY")
    expect(p).toContain("[1] Trial A")
    expect(p).toContain("[2] Trial B")
  })
})
