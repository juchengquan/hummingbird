import { describe, expect, test } from "bun:test"

import {
  COLUMN_TYPES,
  COLUMN_TYPE_GLYPHS,
  COLUMN_TYPE_LABELS,
  ColumnTypeSchema,
  compareForSort,
  isHttpUrl,
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
    expect(resolveColumnType({ type: "banana" })).toBe("text")
  })
  test("returns the declared type when valid ('text' / 'number' / 'link' / 'date')", () => {
    expect(resolveColumnType({ type: "text" })).toBe("text")
    expect(resolveColumnType({ type: "number" })).toBe("number")
    expect(resolveColumnType({ type: "link" })).toBe("link")
    expect(resolveColumnType({ type: "date" })).toBe("date")
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
  test("rejects '' / 123", () => {
    expect(ColumnTypeSchema.safeParse("").success).toBe(false)
    expect(ColumnTypeSchema.safeParse(123).success).toBe(false)
  })
})

describe("validateCell (date)", () => {
  test("returns null for valid ISO dates", () => {
    expect(validateCell(cell("2024-01-15"), "date")).toBeNull()
    expect(validateCell(cell("1999-12-31"), "date")).toBeNull()
  })
  test("returns null for empty / missing", () => {
    expect(validateCell(cell(""), "date")).toBeNull()
    expect(validateCell(undefined, "date")).toBeNull()
  })
  test("warns for non-ISO formats", () => {
    expect(validateCell(cell("15/01/2024"), "date")).toContain("Not a date")
    expect(validateCell(cell("last tuesday"), "date")).toContain("Not a date")
    expect(validateCell(cell("2024-1-5"), "date")).toContain("Not a date")
  })
  test("warns for impossible calendar dates", () => {
    expect(validateCell(cell("2024-13-40"), "date")).toContain("Not a date")
    expect(validateCell(cell("2024-02-30"), "date")).toContain("Not a date")
  })
  test("includes the offending value, truncated at 30 chars", () => {
    const msg = validateCell(cell("x".repeat(50)), "date")
    expect(msg).toContain("…")
    expect(msg?.length).toBeLessThan(60)
  })
})

describe("validateCell (link)", () => {
  test("returns null for http(s) URLs", () => {
    expect(validateCell(cell("https://example.com"), "link")).toBeNull()
    expect(validateCell(cell("http://x.test/path?q=1"), "link")).toBeNull()
  })
  test("returns null for empty / missing", () => {
    expect(validateCell(cell(""), "link")).toBeNull()
    expect(validateCell(undefined, "link")).toBeNull()
  })
  test("warns for non-http(s) values", () => {
    expect(validateCell(cell("ftp://x.test"), "link")).toContain("Not a URL")
    expect(validateCell(cell("javascript:alert(1)"), "link")).toContain("Not a URL")
    expect(validateCell(cell("example.com"), "link")).toContain("Not a URL")
    expect(validateCell(cell("not a url"), "link")).toContain("Not a URL")
  })
})

describe("compareForSort (date)", () => {
  test("orders chronologically ascending", () => {
    expect(compareForSort(cell("2024-01-15"), cell("2024-12-01"), "date", "asc")).toBeLessThan(0)
  })
  test("same-year dates do NOT tie (numeric-sniff regression)", () => {
    expect(compareForSort(cell("2024-01-15"), cell("2024-12-01"), "date", "asc")).not.toBe(0)
  })
  test("descending flips", () => {
    expect(compareForSort(cell("2024-01-15"), cell("2024-12-01"), "date", "desc")).toBeGreaterThan(0)
  })
  test("invalid / empty sort last in both directions", () => {
    expect(compareForSort(cell("not a date"), cell("2024-01-01"), "date", "asc")).toBeGreaterThan(0)
    expect(compareForSort(cell("not a date"), cell("2024-01-01"), "date", "desc")).toBeGreaterThan(0)
    expect(compareForSort(cell(""), cell("2024-01-01"), "date", "asc")).toBeGreaterThan(0)
  })
  test("stable for equal dates", () => {
    expect(compareForSort(cell("2024-01-01"), cell("2024-01-01"), "date", "asc")).toBe(0)
  })
})

describe("compareForSort (link)", () => {
  test("orders lexically, not numerically (no sniff)", () => {
    expect(compareForSort(cell("http://10.0.0.1"), cell("http://9.0.0.1"), "link", "asc")).toBeLessThan(0)
  })
  test("descending flips", () => {
    expect(compareForSort(cell("http://a.test"), cell("http://b.test"), "link", "desc")).toBeGreaterThan(0)
  })
})

describe("parseCellValue (date + link)", () => {
  test("date → UTC timestamp for valid ISO, NaN otherwise", () => {
    expect(parseCellValue("2024-01-15", "date")).toBe(Date.UTC(2024, 0, 15))
    expect(parseCellValue("nope", "date")).toBeNaN()
  })
  test("link → raw string passthrough", () => {
    expect(parseCellValue("https://x.test", "link")).toBe("https://x.test")
  })
})

describe("isHttpUrl", () => {
  test("true for http(s)", () => {
    expect(isHttpUrl("https://example.com")).toBe(true)
    expect(isHttpUrl("http://x.test")).toBe(true)
  })
  test("false for everything else", () => {
    expect(isHttpUrl("ftp://x")).toBe(false)
    expect(isHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isHttpUrl("example.com")).toBe(false)
    expect(isHttpUrl("")).toBe(false)
  })
})

describe("ColumnTypeSchema accepts link + date", () => {
  test("accepts the full slice-2 set", () => {
    expect(ColumnTypeSchema.safeParse("link").success).toBe(true)
    expect(ColumnTypeSchema.safeParse("date").success).toBe(true)
  })
  test("still rejects junk", () => {
    expect(ColumnTypeSchema.safeParse("").success).toBe(false)
    expect(ColumnTypeSchema.safeParse("banana").success).toBe(false)
  })
})

describe("display metadata", () => {
  test("labels + glyphs cover every column type", () => {
    for (const t of COLUMN_TYPES) {
      expect(typeof COLUMN_TYPE_LABELS[t]).toBe("string")
      expect(COLUMN_TYPE_LABELS[t].length).toBeGreaterThan(0)
      expect(typeof COLUMN_TYPE_GLYPHS[t]).toBe("string")
      expect(COLUMN_TYPE_GLYPHS[t].length).toBeGreaterThan(0)
    }
  })
})
