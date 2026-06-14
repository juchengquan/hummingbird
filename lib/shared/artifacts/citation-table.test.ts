import { describe, expect, test } from "bun:test"

import { parseCitationTable, sourceIndex } from "./citation-table"

const validObj = {
  columns: [
    { id: "drug", label: "Drug" },
    { id: "n", label: "Sample size" },
  ],
  rows: [
    {
      drug: {
        value: "Aspirin",
        citations: [{ sourceId: "s1", quote: "Aspirin was administered" }],
      },
      n: { value: "200", citations: [] },
    },
  ],
  sources: [{ id: "s1", title: "Trial A", url: "https://a.test" }],
}

describe("parseCitationTable", () => {
  test("parses a valid citation table", () => {
    const out = parseCitationTable(JSON.stringify(validObj))
    expect(out).not.toBeNull()
    expect(out?.columns.length).toBe(2)
    expect(out?.rows[0].drug.value).toBe("Aspirin")
    expect(out?.rows[0].drug.citations[0].quote).toBe("Aspirin was administered")
  })

  test("returns null on malformed JSON", () => {
    expect(parseCitationTable("{not json")).toBeNull()
  })

  test("returns null when a required field is missing (no columns)", () => {
    expect(parseCitationTable(JSON.stringify({ rows: [], sources: [] }))).toBeNull()
  })

  test("defaults citations to [] when a cell omits them", () => {
    const obj = {
      columns: [{ id: "c", label: "C" }],
      rows: [{ c: { value: "x" } }],
      sources: [],
    }
    const out = parseCitationTable(JSON.stringify(obj))
    expect(out?.rows[0].c.citations).toEqual([])
  })

  test("tolerates a citation whose sourceId is not in sources", () => {
    const obj = {
      columns: [{ id: "c", label: "C" }],
      rows: [{ c: { value: "x", citations: [{ sourceId: "ghost", quote: "q" }] } }],
      sources: [{ id: "s1", title: "Real" }],
    }
    expect(parseCitationTable(JSON.stringify(obj))).not.toBeNull()
  })
})

describe("sourceIndex", () => {
  test("returns the 1-based index of a known source", () => {
    const out = parseCitationTable(JSON.stringify(validObj))!
    expect(sourceIndex(out, "s1")).toBe(1)
  })
  test("returns null for an unknown source id", () => {
    const out = parseCitationTable(JSON.stringify(validObj))!
    expect(sourceIndex(out, "nope")).toBeNull()
  })
})
