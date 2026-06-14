import { describe, expect, test } from "bun:test"

import { parseCitationTable, setCellValue, sortRowOrder, sourceIndex } from "./citation-table"

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

const tbl = (rows: Record<string, { value: string; citations?: { sourceId: string; quote: string }[] }>[]) => ({
  columns: [{ id: "name", label: "Name" }, { id: "n", label: "N" }],
  rows: rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v.value, citations: v.citations ?? [] }])),
  ),
  sources: [],
})

describe("sortRowOrder", () => {
  test("numeric-aware ascending (200 < 1000 numerically, not lexically)", () => {
    const data = tbl([{ n: { value: "200" } }, { n: { value: "1000" } }, { n: { value: "30" } }])
    expect(sortRowOrder(data as never, "n", "asc")).toEqual([2, 0, 1])
  })
  test("descending flips", () => {
    const data = tbl([{ n: { value: "200" } }, { n: { value: "1000" } }, { n: { value: "30" } }])
    expect(sortRowOrder(data as never, "n", "desc")).toEqual([1, 0, 2])
  })
  test("string compare when not numeric", () => {
    const data = tbl([{ name: { value: "Banana" } }, { name: { value: "apple" } }])
    expect(sortRowOrder(data as never, "name", "asc")).toEqual([1, 0])
  })
  test("empty / missing cells sort last (both directions)", () => {
    const data = tbl([{ n: { value: "" } }, { n: { value: "5" } }, {}])
    expect(sortRowOrder(data as never, "n", "asc")[0]).toBe(1)
    expect(sortRowOrder(data as never, "n", "desc")[0]).toBe(1)
  })
  test("stable for equal keys", () => {
    const data = tbl([{ n: { value: "5" } }, { n: { value: "5" } }, { n: { value: "5" } }])
    expect(sortRowOrder(data as never, "n", "asc")).toEqual([0, 1, 2])
  })
  test("does not mutate data", () => {
    const data = tbl([{ n: { value: "2" } }, { n: { value: "1" } }])
    const before = JSON.stringify(data)
    sortRowOrder(data as never, "n", "asc")
    expect(JSON.stringify(data)).toBe(before)
  })
})

describe("setCellValue", () => {
  test("replaces the target value and preserves its citations", () => {
    const data = tbl([{ name: { value: "old", citations: [{ sourceId: "s1", quote: "q" }] } }])
    const out = setCellValue(data as never, 0, "name", "new")
    expect(out.rows[0].name.value).toBe("new")
    expect(out.rows[0].name.citations).toEqual([{ sourceId: "s1", quote: "q" }])
  })
  test("creates an absent cell with empty citations", () => {
    const data = tbl([{ name: { value: "x" } }])
    const out = setCellValue(data as never, 0, "n", "42")
    expect(out.rows[0].n).toEqual({ value: "42", citations: [] })
  })
  test("leaves other rows/cells untouched and returns a new object (no mutation)", () => {
    const data = tbl([{ name: { value: "a" } }, { name: { value: "b" } }])
    const before = JSON.stringify(data)
    const out = setCellValue(data as never, 0, "name", "A")
    expect(out).not.toBe(data)
    expect(out.rows[1].name.value).toBe("b")
    expect(JSON.stringify(data)).toBe(before)
  })
  test("out-of-range rowIndex returns the input unchanged", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(setCellValue(data as never, 9, "name", "x")).toBe(data)
  })
})
