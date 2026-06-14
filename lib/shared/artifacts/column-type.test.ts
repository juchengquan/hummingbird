import { describe, expect, test } from "bun:test"

import {
  ColumnTypeSchema,
  compareForSort,
  parseCellValue,
  resolveColumnType,
  validateCell,
} from "./column-type"
import type { CitationTableCell } from "./citation-table"

const cell = (value: string, citations: { sourceId: string; quote: string }[] = []): CitationTableCell => ({ value, citations })

describe("resolveColumnType", () => {
  test("returns 'text' when col.type is absent", () => {
    expect(resolveColumnType({})).toBe("text")
  })
  test("returns 'text' when col.type is '' or unknown", () => {
    expect(resolveColumnType({ type: "" })).toBe("text")
    expect(resolveColumnType({ type: "link" })).toBe("text")
    expect(resolveColumnType({ type: "banana" })).toBe("text")
  })
  test("returns the declared type when valid ('text' / 'number')", () => {
    expect(resolveColumnType({ type: "text" })).toBe("text")
    expect(resolveColumnType({ type: "number" })).toBe("number")
  })
  test("never throws", () => {
    expect(() => resolveColumnType({ type: undefined as unknown as string })).not.toThrow()
  })
})

describe("parseCellValue", () => {
  test("'number' + '200' → 200 (number)", () => {
    expect(parseCellValue("200", "number")).toBe(200)
  })
  test("'number' + 'abc' → NaN", () => {
    expect(parseCellValue("abc", "number")).toBeNaN()
  })
  test("'number' + '' → NaN", () => {
    expect(parseCellValue("", "number")).toBeNaN()
  })
  test("'text' + anything → raw string (passthrough)", () => {
    expect(parseCellValue("hello", "text")).toBe("hello")
    expect(parseCellValue("", "text")).toBe("")
  })
  test("never throws", () => {
    expect(() => parseCellValue("\u0000", "number")).not.toThrow()
  })
})

describe("validateCell", () => {
  test("returns null for empty cell", () => {
    expect(validateCell(cell(""), "number")).toBeNull()
  })
  test("returns null for missing cell", () => {
    expect(validateCell(undefined, "number")).toBeNull()
    expect(validateCell(undefined, "text")).toBeNull()
  })
  test("returns null for valid number ('200')", () => {
    expect(validateCell(cell("200"), "number")).toBeNull()
    expect(validateCell(cell("3.14"), "number")).toBeNull()
    expect(validateCell(cell("-1"), "number")).toBeNull()
  })
  test("returns a warning for invalid number ('two hundred')", () => {
    const msg = validateCell(cell("two hundred"), "number")
    expect(msg).not.toBeNull()
    expect(msg).toContain("Not a number")
    expect(msg).toContain("two hundred")
  })
  test("returns null for '1.2.3' — parseFloat coerces it to 1.2 (acceptable)", () => {
    // Documented behavior: Number.parseFloat is lenient. Slice 1 does
    // not reject multi-dot strings; users see the parsed value, not a
    // warning. Slice 2 may tighten this if desired.
    expect(validateCell(cell("1.2.3"), "number")).toBeNull()
  })
  test("truncates the displayed value at 30 chars in the warning", () => {
    const longValue = "x".repeat(50)
    const msg = validateCell(cell(longValue), "number")
    expect(msg).toContain("…")
    expect(msg?.length).toBeLessThan(60)
  })
  test("returns null for 'text' + arbitrary value", () => {
    expect(validateCell(cell("anything goes"), "text")).toBeNull()
    expect(validateCell(cell("123"), "text")).toBeNull()
  })
})

describe("compareForSort", () => {
  test("numeric ascending (200 < 1000 numerically, not lexically)", () => {
    expect(compareForSort(cell("200"), cell("1000"), "number", "asc")).toBeLessThan(0)
    expect(compareForSort(cell("200"), cell("1000"), "number", "asc")).toBe(-1)
  })
  test("numeric descending flips", () => {
    expect(compareForSort(cell("200"), cell("1000"), "number", "desc")).toBeGreaterThan(0)
  })
  test("NaN / empty sort last (both directions)", () => {
    expect(compareForSort(cell(""), cell("5"), "number", "asc")).toBeGreaterThan(0)
    expect(compareForSort(cell(""), cell("5"), "number", "desc")).toBeGreaterThan(0)
    expect(compareForSort(cell("abc"), cell("5"), "number", "asc")).toBeGreaterThan(0)
  })
  test("stable for equal keys", () => {
    expect(compareForSort(cell("5"), cell("5"), "number", "asc")).toBe(0)
    expect(compareForSort(cell("abc"), cell("xyz"), "number", "asc")).toBe(0)
  })
  test("'text' uses localeCompare for non-numeric strings (Banana vs apple)", () => {
    expect(compareForSort(cell("Banana"), cell("apple"), "text", "asc")).toBeGreaterThan(0)
    expect(compareForSort(cell("Banana"), cell("apple"), "text", "desc")).toBeLessThan(0)
  })
  test("'text' preserves the historical numeric sniff (200 vs 1000 numerically)", () => {
    // This is the deliberate behavior preservation: un-typed columns
    // (default text) keep doing what they always did — try numeric
    // first, fall back to localeCompare. Opting OUT requires
    // explicit type='number', at which point the strict comparator
    // takes over.
    expect(compareForSort(cell("200"), cell("1000"), "text", "asc")).toBeLessThan(0)
    expect(compareForSort(cell("200"), cell("1000"), "text", "desc")).toBeGreaterThan(0)
  })
  test("'text' numeric sniff ignores bad input (one side unparseable → localeCompare)", () => {
    // When either side doesn't parse as a finite number, fall through
    // to localeCompare. '200' < 'apple' lexically (digits sort before
    // letters), so the asc case expects '200' first.
    expect(compareForSort(cell("apple"), cell("200"), "text", "asc")).toBeGreaterThan(0)
    expect(compareForSort(cell("apple"), cell("200"), "text", "desc")).toBeLessThan(0)
  })
  test("asc vs desc: empty cells sort last in both", () => {
    expect(compareForSort(cell(""), cell(""), "number", "asc")).toBe(0)
    expect(compareForSort(cell(""), cell(""), "number", "desc")).toBe(0)
  })
  test("does not throw on undefined inputs", () => {
    expect(() => compareForSort(undefined, undefined, "number", "asc")).not.toThrow()
    expect(() => compareForSort(undefined, cell("5"), "text", "desc")).not.toThrow()
  })
})

describe("ColumnTypeSchema", () => {
  test("accepts 'text' and 'number'", () => {
    expect(ColumnTypeSchema.safeParse("text").success).toBe(true)
    expect(ColumnTypeSchema.safeParse("number").success).toBe(true)
  })
  test("rejects 'date' / 'link' / '' / 123", () => {
    expect(ColumnTypeSchema.safeParse("date").success).toBe(false)
    expect(ColumnTypeSchema.safeParse("link").success).toBe(false)
    expect(ColumnTypeSchema.safeParse("").success).toBe(false)
    expect(ColumnTypeSchema.safeParse(123).success).toBe(false)
  })
})
