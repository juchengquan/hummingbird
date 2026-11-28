import { describe, expect, test } from "bun:test"

import type { ColumnType } from "./column-type"

import {
  addCitation,
  addColumn,
  addRow,
  moveColumn,
  parseCitationTable,
  removeCitation,
  removeColumn,
  removeRow,
  setCellValue,
  setColumnType,
  slugifyColumnId,
  sortRowOrder,
  sourceIndex,
  uniqueColumnId,
  updateCitation,
} from "./citation-table"
import type { CitationTable } from "./citation-table"

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

describe("addRow", () => {
  test("appends a new empty row and returns a new object (no mutation)", () => {
    const data = tbl([{ name: { value: "a" } }, { name: { value: "b" } }])
    const before = JSON.stringify(data)
    const out = addRow(data as never)
    expect(out).not.toBe(data)
    expect(out.rows.length).toBe(3)
    expect(out.rows[2]).toEqual({})
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged when at the row cap (200)", () => {
    const data = {
      columns: [{ id: "x", label: "X" }],
      rows: Array.from({ length: 200 }, () => ({})),
      sources: [],
    }
    expect(addRow(data as never)).toBe(data)
  })
})

describe("addColumn", () => {
  test("appends a new column with the given id and label, leaving existing cells untouched", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q" }] } }])
    const before = JSON.stringify(data)
    const out = addColumn(data as never, "Color", "color")
    expect(out).not.toBe(data)
    expect(out.columns[2]).toEqual({ id: "color", label: "Color" })
    expect(out.rows[0].name.value).toBe("a")
    expect(out.rows[0].name.citations).toEqual([{ sourceId: "s1", quote: "q" }])
    expect(out.rows[0].color).toBeUndefined()
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged on duplicate columnId (collision)", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(addColumn(data as never, "Name 2", "name")).toBe(data)
  })
  test("returns the input unchanged when at the column cap (12)", () => {
    const data = {
      columns: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `C${i}` })),
      rows: [],
      sources: [],
    }
    expect(addColumn(data as never, "X", "x")).toBe(data)
  })
})

describe("removeRow", () => {
  test("removes the target row and returns a new object (no mutation)", () => {
    const data = tbl([{ name: { value: "a" } }, { name: { value: "b" } }, { name: { value: "c" } }])
    const before = JSON.stringify(data)
    const out = removeRow(data as never, 1)
    expect(out).not.toBe(data)
    expect(out.rows.length).toBe(2)
    expect(out.rows.map((r) => r.name.value)).toEqual(["a", "c"])
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged for an out-of-range rowIndex", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(removeRow(data as never, 9)).toBe(data)
    expect(removeRow(data as never, -1)).toBe(data)
  })
})

describe("removeColumn", () => {
  test("removes the target column and every cell tagged with that column id", () => {
    const data = tbl([
      { name: { value: "a" }, n: { value: "1" } },
      { name: { value: "b" }, n: { value: "2" } },
    ])
    const out = removeColumn(data as never, "n")
    expect(out.columns).toEqual([{ id: "name", label: "Name" }])
    expect(out.rows[0].n).toBeUndefined()
    expect(out.rows[0].name.value).toBe("a")
  })
  test("returns the input unchanged for an unknown columnId", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(removeColumn(data as never, "ghost")).toBe(data)
  })
})

describe("addCitation", () => {
  test("appends a citation to an existing cell (no mutation)", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const before = JSON.stringify(data)
    const out = addCitation(data as never, 0, "name", { sourceId: "s2", quote: "q2" })
    expect(out).not.toBe(data)
    expect(out.rows[0].name.citations).toEqual([
      { sourceId: "s1", quote: "q1" },
      { sourceId: "s2", quote: "q2" },
    ])
    expect(JSON.stringify(data)).toBe(before)
  })
  test("creates an absent cell with value '' and the citation", () => {
    const data = tbl([{ name: { value: "a" } }])
    const out = addCitation(data as never, 0, "n", { sourceId: "s1", quote: "q" })
    expect(out.rows[0].n).toEqual({ value: "", citations: [{ sourceId: "s1", quote: "q" }] })
  })
  test("returns the input unchanged at the 8-citation cap", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ sourceId: `s${i}`, quote: `q${i}` }))
    const data = tbl([{ name: { value: "a", citations: eight } }])
    expect(addCitation(data as never, 0, "name", { sourceId: "s9", quote: "q9" })).toBe(data)
  })
  test("returns the input unchanged for an out-of-range rowIndex", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(addCitation(data as never, 9, "name", { sourceId: "s1", quote: "q" })).toBe(data)
    expect(addCitation(data as never, -1, "name", { sourceId: "s1", quote: "q" })).toBe(data)
  })
})

describe("updateCitation", () => {
  test("patches the sourceId only", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const out = updateCitation(data as never, 0, "name", 0, { sourceId: "s2" })
    expect(out.rows[0].name.citations[0]).toEqual({ sourceId: "s2", quote: "q1" })
  })
  test("patches the quote only", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const out = updateCitation(data as never, 0, "name", 0, { quote: "q2" })
    expect(out.rows[0].name.citations[0]).toEqual({ sourceId: "s1", quote: "q2" })
  })
  test("patches both fields and returns a new object (no mutation)", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    const before = JSON.stringify(data)
    const out = updateCitation(data as never, 0, "name", 0, { sourceId: "s2", quote: "q2" })
    expect(out).not.toBe(data)
    expect(out.rows[0].name.citations[0]).toEqual({ sourceId: "s2", quote: "q2" })
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged for a missing cell", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(updateCitation(data as never, 0, "n", 0, { quote: "x" })).toBe(data)
  })
  test("returns the input unchanged for an out-of-range citIndex or rowIndex", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    expect(updateCitation(data as never, 0, "name", 5, { quote: "x" })).toBe(data)
    expect(updateCitation(data as never, 9, "name", 0, { quote: "x" })).toBe(data)
  })
})

describe("removeCitation", () => {
  test("removes the citation at the index and returns a new object (no mutation)", () => {
    const data = tbl([
      {
        name: {
          value: "a",
          citations: [
            { sourceId: "s1", quote: "q1" },
            { sourceId: "s2", quote: "q2" },
          ],
        },
      },
    ])
    const before = JSON.stringify(data)
    const out = removeCitation(data as never, 0, "name", 0)
    expect(out).not.toBe(data)
    expect(out.rows[0].name.citations).toEqual([{ sourceId: "s2", quote: "q2" }])
    expect(JSON.stringify(data)).toBe(before)
  })
  test("returns the input unchanged for a missing cell", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(removeCitation(data as never, 0, "n", 0)).toBe(data)
  })
  test("returns the input unchanged for an out-of-range citIndex or rowIndex", () => {
    const data = tbl([{ name: { value: "a", citations: [{ sourceId: "s1", quote: "q1" }] } }])
    expect(removeCitation(data as never, 0, "name", 5)).toBe(data)
    expect(removeCitation(data as never, 9, "name", 0)).toBe(data)
  })
})

describe("moveColumn", () => {
  const t = () => ({
    columns: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    rows: [
      {
        a: { value: "1", citations: [] },
        b: { value: "2", citations: [] },
        c: { value: "3", citations: [] },
      },
    ],
    sources: [],
  })
  test("moves a column to the right", () => {
    const out = moveColumn(t() as never, 0, 2)
    expect(out.columns.map((c) => c.id)).toEqual(["b", "c", "a"])
  })
  test("moves a column to the left", () => {
    const out = moveColumn(t() as never, 2, 0)
    expect(out.columns.map((c) => c.id)).toEqual(["c", "a", "b"])
  })
  test("returns the input unchanged when fromIndex === toIndex", () => {
    const data = t()
    expect(moveColumn(data as never, 1, 1)).toBe(data)
  })
  test("returns the input unchanged for an out-of-range index", () => {
    const data = t()
    expect(moveColumn(data as never, 5, 0)).toBe(data)
    expect(moveColumn(data as never, 0, 5)).toBe(data)
    expect(moveColumn(data as never, -1, 0)).toBe(data)
  })
  test("does not mutate the input and leaves row cell data untouched", () => {
    const data = t()
    const before = JSON.stringify(data)
    const out = moveColumn(data as never, 0, 2)
    expect(out).not.toBe(data)
    expect(out.rows[0]).toEqual(data.rows[0])
    expect(JSON.stringify(data)).toBe(before)
  })
})

describe("parseCitationTable tolerates columns without type", () => {
  test("returns a valid CitationTable when columns omit type", () => {
    const obj = {
      columns: [{ id: "c", label: "C" }],
      rows: [{ c: { value: "x", citations: [] } }],
      sources: [],
    }
    const out = parseCitationTable(JSON.stringify(obj))
    expect(out).not.toBeNull()
    expect(out?.columns[0].type).toBeUndefined()
  })
})

describe("addColumn with type", () => {
  test("defaults type to 'text' when omitted (back-compat)", () => {
    const data = tbl([{ name: { value: "a" } }])
    const out = addColumn(data as never, "Color", "color")
    // tbl() produces 2 columns (name, n); the new column is at index 2.
    expect(out.columns[2]).toEqual({ id: "color", label: "Color" })
  })
  test("sets type='number' when supplied", () => {
    const data = tbl([{ name: { value: "a" } }])
    const out = addColumn(data as never, "Score", "score", "number" as ColumnType)
    // tbl() produces 2 columns (name, n); the new column is at index 2.
    expect(out.columns[2]).toEqual({ id: "score", label: "Score", type: "number" })
  })
  test("returns input unchanged on duplicate columnId (type irrelevant)", () => {
    const data = tbl([{ name: { value: "a" } }])
    expect(addColumn(data as never, "Name 2", "name", "number" as ColumnType)).toBe(data)
  })
  test("returns input unchanged at the column cap (12)", () => {
    const data = {
      columns: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `C${i}` })),
      rows: [],
      sources: [],
    }
    expect(addColumn(data as never, "X", "x", "number" as ColumnType)).toBe(data)
  })
})

describe("sortRowOrder with type", () => {
  test("defaults to text behavior when type omitted (regression guard)", () => {
    const data = tbl([{ name: { value: "Banana" } }, { name: { value: "apple" } }])
    expect(sortRowOrder(data as never, "name", "asc")).toEqual([1, 0])
  })
  test("numeric ascending when type='number'", () => {
    const data = tbl([{ n: { value: "200" } }, { n: { value: "1000" } }, { n: { value: "30" } }])
    expect(sortRowOrder(data as never, "n", "asc", "number")).toEqual([2, 0, 1])
  })
  test("numeric descending when type='number'", () => {
    const data = tbl([{ n: { value: "200" } }, { n: { value: "1000" } }, { n: { value: "30" } }])
    expect(sortRowOrder(data as never, "n", "desc", "number")).toEqual([1, 0, 2])
  })
  test("NaN / empty sort last for type='number' (both directions)", () => {
    const data = tbl([{ n: { value: "" } }, { n: { value: "5" } }, { n: { value: "abc" } }])
    expect(sortRowOrder(data as never, "n", "asc", "number")[0]).toBe(1)
    expect(sortRowOrder(data as never, "n", "desc", "number")[0]).toBe(1)
  })
  test("stable for equal keys with type='number'", () => {
    const data = tbl([{ n: { value: "5" } }, { n: { value: "5" } }, { n: { value: "5" } }])
    expect(sortRowOrder(data as never, "n", "asc", "number")).toEqual([0, 1, 2])
  })
  test("does not mutate data (regression guard for the new path)", () => {
    const data = tbl([{ n: { value: "2" } }, { n: { value: "1" } }])
    const before = JSON.stringify(data)
    sortRowOrder(data as never, "n", "asc", "number")
    expect(JSON.stringify(data)).toBe(before)
  })
})

describe("slugifyColumnId", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugifyColumnId("Column Label")).toBe("column-label")
  })
  test("trims leading and trailing dashes", () => {
    expect(slugifyColumnId("  --Hello-- ")).toBe("hello")
  })
  test("falls back to 'column' for empty input", () => {
    expect(slugifyColumnId("")).toBe("column")
    expect(slugifyColumnId("   ")).toBe("column")
    expect(slugifyColumnId("!!!")).toBe("column")
  })
  test("truncates to 60 chars", () => {
    const long = "a".repeat(100)
    expect(slugifyColumnId(long).length).toBe(60)
  })
})

describe("uniqueColumnId", () => {
  const emptyTable: CitationTable = {
    columns: [],
    rows: [],
    sources: [],
  }

  test("returns base if unused", () => {
    expect(uniqueColumnId(emptyTable, "price")).toBe("price")
  })

  test("appends -2 when base is taken", () => {
    const t: CitationTable = {
      ...emptyTable,
      columns: [{ id: "price", label: "Price" }],
    }
    expect(uniqueColumnId(t, "price")).toBe("price-2")
  })

  test("appends -3 when base and -2 are taken", () => {
    const t: CitationTable = {
      ...emptyTable,
      columns: [
        { id: "price", label: "Price" },
        { id: "price-2", label: "Price 2" },
      ],
    }
    expect(uniqueColumnId(t, "price")).toBe("price-3")
  })
})

describe("setColumnType", () => {
  const fixture: CitationTable = {
    columns: [
      { id: "name", label: "Name" },
      { id: "score", label: "Score" },
    ],
    rows: [],
    sources: [],
  }

  test("sets the type on the matching column", () => {
    const out = setColumnType(fixture, "score", "number")
    expect(out.columns.find((c) => c.id === "score")?.type).toBe("number")
  })

  test("leaves other columns untouched", () => {
    const out = setColumnType(fixture, "score", "number")
    expect(out.columns.find((c) => c.id === "name")?.type).toBeUndefined()
    expect(out.columns.find((c) => c.id === "name")?.label).toBe("Name")
  })

  test("returns a new object and does not mutate the input", () => {
    const before = JSON.stringify(fixture)
    const out = setColumnType(fixture, "score", "number")
    expect(out).not.toBe(fixture)
    expect(out.columns).not.toBe(fixture.columns)
    expect(JSON.stringify(fixture)).toBe(before)
  })

  test("no-op shape when columnId matches nothing (all columns unchanged, new top-level object)", () => {
    const out = setColumnType(fixture, "ghost", "number")
    expect(out).not.toBe(fixture)
    expect(out.columns.every((c) => c.type === undefined)).toBe(true)
    expect(out.columns.map((c) => c.id)).toEqual(["name", "score"])
  })
})
