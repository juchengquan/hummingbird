# Citation-table typed columns — Slice 1 (Text + Number) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `type` field (Text or Number) to citation-table columns. Type-aware sort + render. Tolerate-and-warn on edit-time type mismatches. Type-aware extraction prompt.

**Architecture:** Centralise all type-aware pure logic in a new `lib/shared/artifacts/column-type.ts` module (5 helpers: schema, resolver, parser, validator, comparator). Widen the `citation-table.ts` and `extract-table.ts` schemas by adding an optional `type` field. Replace `sortRowOrder`'s numeric sniff with explicit delegation to the new comparator. Renderer branches on `resolveColumnType(col)` to right-align Number cells, use `<input type="number">` for editing, and show an inline warning glyph via `validateCell`. The extraction popover chips carry `{ label, type }` and the prompt builder renders per-type value-format instructions.

**Tech Stack:** TypeScript 5.x · Bun · Zod · React 19.2 · shadcn/ui (Popover, Dialog) · Tailwind 4 · Plate.js (no plugin changes; embedded editor-doc copy inherits via `CitationTableView`)

**Spec:** `docs/superpowers/specs/2026-06-14-citation-typed-columns-slice-1-design.md`

**Loop:** This plan follows the established slice pattern. Pure-helper tasks (1–4) are TDD and verifiable in isolation. The renderer task (5) is the substantive UI change and gets a combined spec+quality review subagent at the end. Extraction prompt task (6) is small + isolated. End with `bun run check` and the manual browser pass.

---

## File Structure

**New files (3):**
- `lib/shared/artifacts/column-type.ts` — pure helpers (ColumnTypeSchema, resolveColumnType, parseCellValue, validateCell, compareForSort).
- `lib/shared/artifacts/column-type.test.ts` — one `describe` per helper, ~25 tests.
- `lib/shared/artifacts/extract-table.test.ts` — prompt + extraction tests.

**Modified files (5):**
- `lib/shared/artifacts/citation-table.ts` — schema gains optional `type`; `addColumn` gains type arg; `sortRowOrder` delegates to `compareForSort`.
- `lib/shared/artifacts/citation-table.test.ts` — new describe blocks for type-aware sort + addColumn; existing assertions untouched.
- `lib/shared/artifacts/extract-table.ts` — `ExtractionColumnSchema` gains optional `type`; `buildExtractTablePrompt` accepts typed hints; `extractionToCitationTable` fills type on write.
- `components/panels/citation-table.tsx` — header type pill (Popover), add-column dialog type picker, body cell `TypedCell` wrapper with tolerate+warn glyph.
- `components/panels/extract-table-popover.tsx` — chips carry `{ label, type }`; small type pill on each chip with click-to-edit dropdown.
- `components/panels/chat-message.tsx` — **(as-shipped; omitted from the original plan)** widen `handleExtractTable` + the `ExtractTablePopover` `onRun` prop from `string[]` to `ExtractColumnHint[]`.

**API contract change (2):**
- `lib/shared/api-schemas.ts` — `ExtractTableRequestSchema.columnHints` widens from `z.array(z.string())` to a `z.union([z.string(), z.object({ label, type? })])` array (cap 8). This is the wire field; the original plan mis-named it `body.hints`.
- `app/api/extract-table/route.ts` — destructures `columnHints` from the parsed body and threads it to `buildExtractTablePrompt` (the route ignored it before). Old `string[]` clients continue to work via the union.

**Untouched (explicit non-changes):**
- `citation-table-md.ts` — JSON round-trip is shape-stable.
- `components/editor/plugins/citation-table-kit.tsx`, `components/ui/citation-table-node.tsx` — inherit via `CitationTableView`.
- `store/persist.test.ts`, `runMigrations`, `STORE_VERSION` — no persisted-shape change.
- `CitationChips`, `CitationCellEditor` — no change.

---

## Task 1: New module — `column-type.ts` (helpers + schema)

**Files:**
- Create: `lib/shared/artifacts/column-type.ts`
- Create: `lib/shared/artifacts/column-type.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Write `lib/shared/artifacts/column-type.test.ts` with these `describe` blocks:

```ts
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
  test("returns a warning for invalid number ('1.2.3')", () => {
    expect(validateCell(cell("1.2.3"), "number")).toContain("Not a number")
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
  test("'text' delegates to localeCompare (matches today)", () => {
    expect(compareForSort(cell("Banana"), cell("apple"), "text", "asc")).toBeGreaterThan(0)
    expect(compareForSort(cell("Banana"), cell("apple"), "text", "desc")).toBeLessThan(0)
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
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test lib/shared/artifacts/column-type.test.ts`
Expected: FAIL — module `./column-type` not found.

- [ ] **Step 1.3: Write the implementation**

Write `lib/shared/artifacts/column-type.ts`:

```ts
import { z } from "zod"

import type { CitationTableCell } from "./citation-table"

/** The set of column types shipped in slice 1. Slice 2 adds "link"
 *  and "date". */
export const COLUMN_TYPES = ["text", "number"] as const
export const ColumnTypeSchema = z.enum(COLUMN_TYPES)
export type ColumnType = (typeof COLUMN_TYPES)[number]

/** Resolve a column's effective type. Defaults to "text" when type
 *  is absent or unknown. Pure, never throws. */
export function resolveColumnType(col: { type?: string }): ColumnType {
  return (COLUMN_TYPES as readonly string[]).includes(col.type ?? "")
    ? (col.type as ColumnType)
    : "text"
}

/** Coerce a cell's string value to a sortable scalar for `type`.
 *  - "number" → Number.parseFloat(value), or NaN if not finite
 *  - "text" → raw string (passthrough)
 *  Empty string yields NaN for number and "" for text. Never throws. */
export function parseCellValue(value: string, type: ColumnType): number | string {
  if (type === "number") {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : NaN
  }
  return value
}

/** Return a warning message when the cell value doesn't fit the
 *  declared type, or null when it does. Returns null for empty /
 *  missing cells (no warning to show for an empty cell). */
export function validateCell(
  cell: CitationTableCell | undefined,
  type: ColumnType,
): string | null {
  if (!cell || cell.value === "") return null
  if (type === "number") {
    const n = Number.parseFloat(cell.value)
    if (Number.isFinite(n)) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a number: "${display}"`
  }
  return null
}

/** Type-aware comparator for sortRowOrder. NaN / empty sort last in
 *  BOTH directions (matches today's "empty cells sort last" rule).
 *  Stable for equal keys. "text" delegates to localeCompare. */
export function compareForSort(
  a: CitationTableCell | undefined,
  b: CitationTableCell | undefined,
  type: ColumnType,
  dir: "asc" | "desc",
): number {
  const sign = dir === "asc" ? 1 : -1
  const va = a?.value ?? ""
  const vb = b?.value ?? ""
  if (va === "" && vb === "") return 0
  if (va === "") return 1
  if (vb === "") return -1
  if (type === "number") {
    const na = Number.parseFloat(va)
    const nb = Number.parseFloat(vb)
    const aBad = !Number.isFinite(na)
    const bBad = !Number.isFinite(nb)
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return na === nb ? 0 : (na < nb ? -1 : 1) * sign
  }
  return va.localeCompare(vb) * sign
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `bun test lib/shared/artifacts/column-type.test.ts`
Expected: PASS (all 28 tests green).

- [ ] **Step 1.5: Commit**

```bash
git add lib/shared/artifacts/column-type.ts lib/shared/artifacts/column-type.test.ts
git commit -m "feat(citation-table): add column-type helpers (Text + Number)

Centralise the slice-1 type-aware pure logic in a new module:
- ColumnTypeSchema + COLUMN_TYPES union
- resolveColumnType (default Text on absent/unknown)
- parseCellValue (number coercion, NaN-on-bad-input)
- validateCell (returns warning string or null)
- compareForSort (type-aware comparator for sortRowOrder)

All helpers are pure, never-mutate, never-throw. One describe per
helper, matching the citation-table test template.

Part of citation-table typed-columns slice 1 (Text + Number).
Spec: docs/superpowers/specs/2026-06-14-citation-typed-columns-slice-1-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Widen `citation-table.ts` schema + helper signatures

**Files:**
- Modify: `lib/shared/artifacts/citation-table.ts:1-244`
- Modify: `lib/shared/artifacts/citation-table.test.ts:1-358`

- [ ] **Step 2.1: Write the failing tests**

Append to `lib/shared/artifacts/citation-table.test.ts` (do not modify any existing test):

```ts
import { ColumnType } from "./column-type"

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
    expect(out.columns[1]).toEqual({ id: "color", label: "Color" })
  })
  test("sets type='number' when supplied", () => {
    const data = tbl([{ name: { value: "a" } }])
    const out = addColumn(data as never, "Score", "score", "number" as ColumnType)
    expect(out.columns[1]).toEqual({ id: "score", label: "Score", type: "number" })
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
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test lib/shared/artifacts/citation-table.test.ts`
Expected: FAIL on the new `sortRowOrder with type` block — `sortRowOrder` signature doesn't accept a 4th arg.

- [ ] **Step 2.3: Widen the schema + helpers in `citation-table.ts`**

Three edits to `lib/shared/artifacts/citation-table.ts`:

**Edit A** — import + add to the top (after the existing imports):

```ts
import type { ColumnType } from "./column-type"
import { compareForSort } from "./column-type"
```

**Edit B** — widen `CitationTableColumnSchema` (currently at lines 22-25):

```ts
export const CitationTableColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  /** Slice 1: "text" | "number". Absent = "text". Slice 2 extends
   *  the union with "link" | "date". */
  type: z.enum(["text", "number"]).optional(),
})
```

**Edit C** — widen `addColumn` signature (currently at lines 126-134):

```ts
export function addColumn(
  data: CitationTable,
  label: string,
  columnId: string,
  type: ColumnType = "text",
): CitationTable {
  if (data.columns.length >= 12) return data
  if (data.columns.some((c) => c.id === columnId)) return data
  const newColumn: CitationTable["columns"][number] = { id: columnId, label }
  if (type !== "text") newColumn.type = type
  return { ...data, columns: [...data.columns, newColumn] }
}
```

(Setting `type` only when not "text" keeps the persisted JSON shape byte-identical to today's for the default case. The `parseCitationTable` schema accepts both with and without `type`.)

**Edit D** — replace `sortRowOrder` (currently at lines 67-89) with delegation:

```ts
export function sortRowOrder(
  data: CitationTable,
  columnId: string,
  dir: "asc" | "desc",
  type: ColumnType = "text",
): number[] {
  return data.rows
    .map((_, i) => i)
    .sort((a, b) =>
      compareForSort(data.rows[a]?.[columnId], data.rows[b]?.[columnId], type, dir),
    )
}
```

The numeric sniff that lived inside the comparator is removed — `compareForSort` handles it.

- [ ] **Step 2.4: Run all citation-table tests to verify they pass**

Run: `bun test lib/shared/artifacts/citation-table.test.ts`
Expected: PASS on every assertion (existing + new). The existing `sortRowOrder` block continues to pass because the type defaults to "text" and the text branch of `compareForSort` is byte-identical to today's inline comparator (localeCompare + empty-sort-last).

Run: `bun test lib/shared/artifacts/column-type.test.ts`
Expected: PASS (regression guard).

- [ ] **Step 2.5: Run lint + typecheck**

Run: `bun run check`
Expected: PASS. No new errors or warnings. (`check` runs typecheck + lint — the split test runner is invoked separately.)

- [ ] **Step 2.6: Commit**

```bash
git add lib/shared/artifacts/citation-table.ts lib/shared/artifacts/citation-table.test.ts
git commit -m "feat(citation-table): widen schema + helpers with optional type

Three pure-helper changes, all gated by TDD:

1. CitationTableColumnSchema gains optional type ('text' | 'number').
   Existing un-typed blobs validate unchanged (zero migration).
2. addColumn gains a type argument defaulting to 'text'. Only writes
   the field when not 'text' (preserves byte-identical JSON shape
   for default-case persistence).
3. sortRowOrder delegates to compareForSort via an optional type arg.
   The today's numeric sniff inside the comparator is removed; the
   text branch is byte-identical to the previous localeCompare +
   empty-sort-last behavior.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Widen extraction schema + prompt builder

**Files:**
- Modify: `lib/shared/artifacts/extract-table.ts:1-117`
- Create: `lib/shared/artifacts/extract-table.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Write `lib/shared/artifacts/extract-table.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import {
  buildExtractTablePrompt,
  extractionToCitationTable,
} from "./extract-table"
import type { ColumnType } from "./column-type"

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
        columns: [{ id: "drug", label: "Drug" } as never],
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
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `bun test lib/shared/artifacts/extract-table.test.ts`
Expected: FAIL on every typed-hints test — the prompt doesn't render type suffixes yet; FAIL on extraction type-fill tests — current code doesn't fill `type`.

- [ ] **Step 3.3: Widen `extract-table.ts`**

**Edit A** — imports + new `ExtractColumnHint` type (top of file, after `ExtractionColumnSchema`):

```ts
import type { ColumnType } from "./column-type"

export type ExtractColumnHint = { label: string; type?: ColumnType }
```

**Edit B** — widen `ExtractionColumnSchema` (currently at lines 18-21):

```ts
export const ExtractionColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  /** Slice 1: "text" | "number". Absent = "text". The model does NOT
   *  emit this — it's set by `extractionToCitationTable` on write. */
  type: z.enum(["text", "number"]).optional(),
})
```

**Edit C** — widen `buildExtractTablePrompt` signature (currently at lines 76-117):

Replace the entire function with:

```ts
export function buildExtractTablePrompt(
  reportText: string,
  sources: NumberedSource[],
  hints?: ExtractColumnHint[] | string[],
): string {
  // Back-compat: normalize string[] to typed hints (treated as Text).
  const typedHints: ExtractColumnHint[] | undefined =
    hints === undefined
      ? undefined
      : hints.map((h) => (typeof h === "string" ? { label: h } : h))

  const sourceLines = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}${s.url ? ` — ${s.url}` : ""}${s.snippet ? `\n    ${s.snippet}` : ""}`,
    )
    .join("\n")

  // When typed hints are supplied, render per-type value-format instructions.
  const typeBlock =
    typedHints && typedHints.length > 0 && typedHints.some((h) => h.type === "number")
      ? [
          "",
          "Per-type value format:",
          "- For (Text) columns: emit prose.",
          '- For (Number) columns: emit the bare numeric value only, no units or words (e.g. "200" not "two hundred", "3.14" not "approximately three").',
        ].join("\n")
      : ""

  const hintBlock =
    typedHints && typedHints.length > 0
      ? [
          "",
          `Required columns (use these labels and value formats exactly): ${typedHints
            .map((h) => `\`${h.label}\` (${(h.type ?? "text").replace(/^./, (c) => c.toUpperCase())})`)
            .join(", ")}.`,
          "If the report doesn't support one of these, leave that cell empty (do NOT invent a different column).",
        ].join("\n")
      : ""

  return [
    "You extract a structured comparison table from a research report.",
    "",
    "REPORT:",
    reportText,
    "",
    "SOURCES (cite by number):",
    sourceLines,
    "",
    typedHints && typedHints.length > 0
      ? `Build a table with EXACTLY these columns (one per hint, in the order given):`
      : "Build a table capturing the key comparable attributes across the entities the report discusses:",
    typedHints && typedHints.length > 0
      ? ""
      : "- Choose 3–6 columns (the comparable attributes). Each column has a short slug `id` and a human `label`.",
    "- One row per entity/item the report compares. Each row is a list of `cells`; each cell has the column's `columnId`, the extracted `value`, and `citations`.",
    "- Back each value with `citations` referencing the SOURCE NUMBER above plus the exact supporting quote. Only cite what the report/sources actually state; leave `citations` empty when a value isn't directly supported.",
    "- Keep values concise.",
    typeBlock,
    hintBlock,
  ]
    .filter((s) => s !== "")
    .join("\n")
}
```

**Edit D** — fill type on write in `extractionToCitationTable` (currently at lines 44-67). Update the return statement:

```ts
return {
  columns: extraction.columns.map((c) => ({
    ...c,
    type: c.type ?? "text",
  })),
  rows,
  sources: safeSources,
}
```

(Replace the existing `return { columns: extraction.columns, rows, sources: safeSources }`.)

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `bun test lib/shared/artifacts/extract-table.test.ts`
Expected: PASS on all tests. Run `bun test lib/shared/artifacts/column-type.test.ts lib/shared/artifacts/citation-table.test.ts` to confirm no regressions in adjacent helpers.

- [ ] **Step 3.5: Run lint + typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3.6: Commit**

```bash
git add lib/shared/artifacts/extract-table.ts lib/shared/artifacts/extract-table.test.ts
git commit -m "feat(citation-table): widen extraction prompt with typed hints

Three pure-helper changes:
1. ExtractionColumnSchema gains optional type ('text' | 'number').
   The model does not emit this; extractionToCitationTable fills it.
2. buildExtractTablePrompt accepts ExtractColumnHint[] | string[].
   String[] is normalized to typed hints (default Text). The prompt
   renders per-type value-format instructions only when at least one
   hint is typed as Number. No-hints path is byte-identical to today.
3. extractionToCitationTable fills type:'text' on write so newly
   extracted artifacts are self-describing in localStorage.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: API route + request schema widening (`/api/extract-table`)

**Files:**
- Modify: `lib/shared/api-schemas.ts` (the wire schema for the request)
- Modify: `app/api/extract-table/route.ts` (the route handler)

**Important:** The plan originally described widening `body.hints` in the route. The actual field is `columnHints` in `ExtractTableRequestSchema`, and the route never passes it through to `buildExtractTablePrompt` today. So this task does **two things**: (a) widen the wire schema to accept the typed shape, (b) thread `columnHints` through the route to the prompt builder.

- [ ] **Step 4.1: Widen the wire schema in `lib/shared/api-schemas.ts`**

Find the `ExtractTableRequestSchema` (currently around lines 599-617). Replace the `columnHints` field:

Current:
```ts
/** Optional user-supplied column labels. ... */
columnHints: z.array(z.string().min(1).max(60)).max(8).optional(),
```

New:
```ts
/** Optional user-supplied column hints. Each entry is either a plain
 *  string (legacy thin shape, treated as Text) or { label, type? }.
 *  When non-empty, the prompt builder steers the model to use these
 *  labels verbatim and (for typed hints) to emit values in the
 *  declared format. Capped at 8 to match the popover's UX. */
columnHints: z
  .array(
    z.union([
      z.string().min(1).max(60),
      z.object({
        label: z.string().min(1).max(60),
        type: z.enum(["text", "number"]).optional(),
      }),
    ]),
  )
  .max(8)
  .optional(),
```

- [ ] **Step 4.2: Update the route handler**

In `app/api/extract-table/route.ts`:

**Edit A** — adjust the `@/shared/artifacts/extract-table` import only if needed. The route does **not** reference `ExtractColumnHint` directly (it threads `columnHints` straight to `buildExtractTablePrompt`, which does its own normalization), so do **not** add a `type ExtractColumnHint` import — it would be unused and trip `no-unused-vars`. The existing import block is sufficient:

```ts
import {
  ExtractionSchema,
  buildExtractTablePrompt,
  extractionToCitationTable,
  type Extraction,
} from '@/shared/artifacts/extract-table'
```

> **As-shipped note:** Threading `columnHints` (the Zod-inferred type
> `(string | { label; type? })[]`) into `buildExtractTablePrompt`
> requires its `hints` param to be an **array-of-union**
> `(ExtractColumnHint | string)[]`, not the union-of-arrays
> `ExtractColumnHint[] | string[]` that Task 3 first wrote — TS won't
> assign the former to the latter. Widen the Task 3 signature
> accordingly (the `.map` normalization already handles a mixed array).

**Edit B** — destructure `columnHints` from `parsed.data` and pass it to `buildExtractTablePrompt`. Replace:

```ts
const { reportText, sources, model } = parsed.data
const modelId = model ?? DEFAULT_EXTRACT_TABLE_MODEL
const numbered = sources.map((s, i) => ({ id: `s${i + 1}`, ...s }))
const prompt = buildExtractTablePrompt(reportText, numbered)
```

with:

```ts
const { reportText, sources, model, columnHints } = parsed.data
const modelId = model ?? DEFAULT_EXTRACT_TABLE_MODEL
const numbered = sources.map((s, i) => ({ id: `s${i + 1}`, ...s }))
// The wire schema accepts both string[] (legacy) and { label, type? }[].
// buildExtractTablePrompt handles both shapes; passing it through.
const prompt = buildExtractTablePrompt(reportText, numbered, columnHints)
```

- [ ] **Step 4.3: Run lint + typecheck**

Run: `bun run check`
Expected: PASS. The route gains type-safety for the typed shape; old `string[]` callers continue to work via the union.

- [ ] **Step 4.4: Commit**

```bash
git add lib/shared/api-schemas.ts app/api/extract-table/route.ts lib/shared/artifacts/extract-table.ts
git commit -m "feat(api): widen /api/extract-table columnHints to accept typed shape

The columnHints field now accepts:
  - undefined (model decides) — unchanged
  - string[] (legacy thin shape, treated as Text)
  - { label: string; type?: 'text' | 'number' }[] (new typed shape)

The route handler now threads columnHints through to
buildExtractTablePrompt (it didn't before — Task 3 widened the
prompt signature but Task 4 is the call site that uses it).

Old clients posting string[] continue to work unchanged via the
Zod union. The wire schema change is the source of truth for
both back-compat and new-shape clients.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Renderer — header pill + add-column dialog + body TypedCell

**Files:**
- Modify: `components/panels/citation-table.tsx`
- Modify: `components/panels/extract-table-popover.tsx`
- Modify: `components/panels/chat-message.tsx` — **(as-shipped deviation; the original plan omitted this file.)** `ExtractTablePopover`'s `onRun` prop and `chat-message`'s `handleExtractTable` are both typed `(hints?: string[])` today. Once the popover emits typed chips, both widen to `ExtractColumnHint[]` (the build fails otherwise). `handleExtractTable`'s body already flows `columnHints` to `apiClient.artifacts.extractTable`, whose request type accepts the widened union, so no further call-site change is needed.

This is the substantive UI task. After committing, dispatch the combined spec+quality review subagent (Task 5.6) before moving to Task 6.

> **As-shipped deviation — read-only alignment.** Step 5.4's reference
> snippet applied `text-right` to the `<td>` unconditionally, but the
> spec's hard constraint is "do NOT touch the read-only path." The
> shipped implementation honors the constraint literally: only the
> **editable** cell branch right-aligns Number columns; the read-only
> branch renders byte-identical to before. Consequence: read-only
> Number columns are not right-aligned. Deferred to slice 2 (which
> already touches the read-only renderer for Link/Date and can
> right-align there).

- [ ] **Step 5.1: Add imports to `citation-table.tsx`**

Add to the existing import block at the top of `components/panels/citation-table.tsx`:

```ts
import type { ColumnType } from "@/shared/artifacts/column-type"
import { resolveColumnType, validateCell } from "@/shared/artifacts/column-type"
```

- [ ] **Step 5.2: Add the header type pill**

In the `<thead>` `<tr>` rendering loop (currently around lines 202-289), add a small `Type` button to the right of the column label (before the existing `×` remove button). On click, opens a `Popover` with `text` / `number` radios:

```tsx
const type = resolveColumnType(col)
const [typeOpen, setTypeOpen] = useState(false)

// Inside the <th> render, alongside the sort button:
{editable ? (
  <Popover open={typeOpen} onOpenChange={setTypeOpen}>
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label={`Change type of ${col.label}`}
        onClick={(e) => e.stopPropagation()}
        className="ml-1 rounded bg-[var(--muted)] px-1 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
      >
        {type === "number" ? "#" : "Aa"}
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-32 p-2 text-xs">
      <div className="space-y-1">
        {(["text", "number"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => {
              if (onChange) {
                onChange({
                  ...data,
                  columns: data.columns.map((c) =>
                    c.id === col.id ? { ...c, type: opt } : c,
                  ),
                })
              }
              setTypeOpen(false)
            }}
            className={`block w-full rounded px-2 py-1 text-left hover:bg-[var(--accent)] ${
              type === opt ? "bg-[var(--accent)] font-medium" : ""
            }`}
          >
            {opt === "text" ? "Text" : "Number"}
          </button>
        ))}
      </div>
    </PopoverContent>
  </Popover>
) : null}
```

Right-align the header text when `type === "number"`: change the sort button's className to add `justify-end` conditionally:

```tsx
className={`flex w-full items-center gap-1 px-2 py-1 hover:bg-[var(--accent)] ${
  type === "number" ? "justify-end" : ""
}`}
```

- [ ] **Step 5.3: Add the type picker to the Add-column dialog**

In the `Dialog` block (currently around lines 395-428), add a Type `<div>` between the `Input` and the `DialogFooter`:

```tsx
<div className="flex items-center gap-3 py-1 text-xs">
  <span className="text-[var(--muted-foreground)]">Type</span>
  {(["text", "number"] as const).map((opt) => (
    <label key={opt} className="flex cursor-pointer items-center gap-1">
      <input
        type="radio"
        name="column-type"
        value={opt}
        checked={newColType === opt}
        onChange={() => setNewColType(opt)}
      />
      {opt === "text" ? "Text" : "Number"}
    </label>
  ))}
</div>
```

Add state above the dialog:

```tsx
const [newColType, setNewColType] = useState<ColumnType>("text")
```

Update `submitAddColumn` to pass the type:

```tsx
const submitAddColumn = () => {
  const label = newColLabel.trim().slice(0, 120)
  if (!label || !onChange) return
  const base = slugify(label) || "column"
  const columnId = dedupeColumnId(base)
  onChange(addColumn(data, label, columnId, newColType))
  setNewColLabel("")
  setNewColType("text")
  setAddColOpen(false)
}
```

Reset `newColType` to "text" when the dialog closes (add to the `onOpenChange` handler).

- [ ] **Step 5.4: Wrap the body cell in `TypedCell` with tolerate+warn**

This step **replaces** the existing `<td>` block in the body cell rendering loop (currently around lines 311-353). The replace is structural — the existing `<td>` becomes a new `<td>` that:

1. Adds `text-right` to its className when `cellType === "number"`.
2. Wraps the existing inner content in a flex container.
3. Renders a `⚠` glyph after the content when `validateCell(cell, cellType)` returns non-null.
4. Uses `<input type="number" inputMode="decimal">` instead of `<input>` when `cellType === "number"` (and the existing `<input>` is used otherwise).

```tsx
const cellType = resolveColumnType(col)
const cellWarning = editable ? validateCell(cell, cellType) : null

return (
  <td
    key={col.id}
    className={`border border-[var(--border)] px-2 py-1 align-top ${
      cellType === "number" ? "text-right" : ""
    }`}
  >
    <span className="inline-flex items-start gap-0.5">
      <span className="flex-1">
        {isEditing ? (
          <input
            autoFocus
            type={cellType === "number" ? "number" : "text"}
            inputMode={cellType === "number" ? "decimal" : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                setEditing(null)
              }
            }}
            aria-label="Edit cell value"
            className="w-full bg-[var(--background)] px-1 text-xs outline-none ring-1 ring-[var(--ring)]"
          />
        ) : (
          <CellContent
            data={data}
            cell={cell}
            editable={editable}
            onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
            onAddCitation={(c) => onChange?.(addCitation(data, rowIndex, col.id, c))}
            onUpdateCitation={(i, patch) =>
              onChange?.(updateCitation(data, rowIndex, col.id, i, patch))
            }
            onRemoveCitation={(i) => onChange?.(removeCitation(data, rowIndex, col.id, i))}
          />
        )}
      </span>
      {cellWarning ? (
        <span
          title={cellWarning}
          aria-label={cellWarning}
          className="select-none text-[var(--destructive)]"
        >
          ⚠
        </span>
      ) : null}
    </span>
  </td>
)
```

The `<input type="number">` is a thin HTML affordance — it gives mobile keyboards a numeric keypad but does NOT block the user from typing "two hundred". We commit via `setCellValue` (raw string verbatim) and the warning glyph surfaces post-commit.

**Important:** Do NOT touch the read-only path (when `editable === false`). The `<td>` block is rendered only for editable tables; the read-only rendering in `CitationChips` is unaffected.

- [ ] **Step 5.5: Update the extraction popover chips**

In `components/panels/extract-table-popover.tsx`, replace the `chips` state and related handlers:

State:
```tsx
import type { ColumnType } from "@/shared/artifacts/column-type"
import { resolveColumnType } from "@/shared/artifacts/column-type"
import type { ExtractColumnHint } from "@/shared/artifacts/extract-table"

const [chips, setChips] = useState<ExtractColumnHint[]>(() => {
  const seen = new Set<string>()
  const out: ExtractColumnHint[] = []
  for (const t of sourceTitles) {
    const label = t.trim().slice(0, 60)
    const key = label.toLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    out.push({ label })
    if (out.length >= 8) break
  }
  return out
})
```

`addChip`:
```tsx
const addChip = (raw: string) => {
  const label = raw.trim().slice(0, 60)
  if (!label) return
  if (chips.length >= 8) return
  if (chips.some((c) => c.label.toLowerCase() === label.toLowerCase())) return
  setChips([...chips, { label }])
  setDraft("")
}
const removeChip = (i: number) => setChips(chips.filter((_, idx) => idx !== i))
const setChipType = (i: number, type: ColumnType) =>
  setChips(chips.map((c, idx) => (idx === i ? { ...c, type } : c)))
```

Render — each chip now shows a small type pill next to its label:

```tsx
{chips.map((c, i) => (
  <span
    key={`${c.label}-${i}`}
    className="inline-flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5"
  >
    {c.label}
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change type of ${c.label}`}
          className="rounded bg-[var(--background)] px-1 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          {resolveColumnType(c) === "number" ? "#" : "Aa"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-24 p-1 text-xs">
        {(["text", "number"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setChipType(i, opt)}
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--accent)]"
          >
            {opt === "text" ? "Text" : "Number"}
          </button>
        ))}
      </PopoverContent>
    </Popover>
    <button
      type="button"
      aria-label={`Remove ${c.label}`}
      onClick={() => removeChip(i)}
      className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
    >
      ×
    </button>
  </span>
))}
```

The "Run extraction" button passes the typed chips:
```tsx
onClick={() => {
  onRun(chips)  // already typed as ExtractColumnHint[]
  setOpen(false)
}}
```

The "Let the model decide" button keeps passing `undefined`.

- [ ] **Step 5.6: Run check + the manual browser pass checklist**

Run: `bun run check` — expected PASS.

Manual browser pass checklist (record results in the PR description's Test Plan):
1. Open the editor, click **Extract to table**. Default chips show with `Aa` pill (Text).
2. Click the `Aa` pill on the "Sample size" chip → switch to `#` (Number).
3. Add a new chip via the input → defaults to `Aa` (Text).
4. Click **Run extraction**. Verify the resulting table has a right-aligned "Sample size" column.
5. Sort the table by "Sample size" — confirm numeric order (`30, 200, 1000` not `1000, 200, 30`).
6. Click **Add column** in the table toolbar. Verify the new dialog has a Type radio row defaulting to Text.
7. Add a Number column. Right-align header, sort by it, confirm numeric sort.
8. Edit a Number cell, type "two hundred" → blur → confirm `⚠ Not a number: "two hundred"` appears next to the value.
9. Edit a Number cell, type "200" → blur → confirm no warning, value renders as `200` right-aligned.
10. Click the `Aa`/`#` pill on an existing Text column → toggle to Number → confirm sort + warning glyph update accordingly (no value coercion).
11. Re-load the page → confirm the type persists (column was set in the JSON).

- [ ] **Step 5.7: Commit the renderer changes**

```bash
git add components/panels/citation-table.tsx components/panels/extract-table-popover.tsx components/panels/chat-message.tsx
git commit -m "feat(citation-table): renderer + edit affordances for typed columns

Three UI additions (editable mode only; read-only unchanged):

1. Header type pill — small Aa/# button next to each column label,
   opens a Popover with text/number radios. Updates col.type via
   onChange. Right-aligns the header when type === 'number'.
2. Add-column dialog — gains a Type radio row defaulting to Text.
   Submission calls addColumn(data, label, columnId, type).
3. Body cell — wrapped in TypedCell: <input type='number'> for
   Number columns; inline warning glyph (⚠) via validateCell when
   the typed value isn't a finite number. Raw user input is
   preserved verbatim (no coercion).

Toggling a column's type does not rewrite cell values. The renderer
just changes how the same string is displayed + sorted.

The extraction popover chips carry { label, type } and render a
small Aa/# pill on each chip with click-to-edit dropdown.

Spec: docs/superpowers/specs/2026-06-14-citation-typed-columns-slice-1-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5.8: Dispatch combined spec+quality review subagent**

After committing, dispatch a fresh subagent (per the handoff's proportionate pattern) with:

- The spec file path.
- This plan (the renderer task section).
- The list of files changed in Task 5.
- The instruction: "Verify the implementation matches the spec section by section, and run a quality review for accessibility, edge cases, and adherence to the established citation-table polish pattern. Report findings as a list of (1) blockers, (2) suggestions, (3) nits. Do not change code."

Block on any blockers before Task 6.

---

## Task 6: End-to-end verification + PR

**Files:** none modified — verification only.

- [ ] **Step 6.1: Run the full local gate**

Run:
```bash
bun run check
bun run test
```

Expected: `check` 0 errors / 0 warnings. `test` shows the prior 1321 tests + the new column-type tests (~28) + the new extract-table tests (~10) + the new citation-table tests (~7) green; **0 failures**.

The split test runner (`scripts/run-tests.sh`) is what `bun run test` invokes. It hand-enumerates roots and isolates `app/api/tasks/`. New tests at `lib/shared/artifacts/column-type.test.ts` and `lib/shared/artifacts/extract-table.test.ts` live under `lib/` and are picked up by `MAIN_ROOTS`.

- [ ] **Step 6.2: Confirm production build still bundles correctly**

Run: `bun run audit:bundle`
Expected: no new server-only paths or secret env-var names leaked into `.next/static/chunks/*.js`.

- [ ] **Step 6.3: Write the PR description**

Open a PR into `dev` per the handoff loop (push + PR). The PR description should include:

- Summary: optional `type` field; Text + Number slice 1; centralised helpers; tolerate+warn.
- Spec link: `docs/superpowers/specs/2026-06-14-citation-typed-columns-slice-1-design.md`.
- Test Plan: the 11-step manual browser pass from Task 5.6 (reviewer checks these; unchecked by the agent because it needs an AI-gateway extraction to drive).
- Slice 2 follow-up note: Link + Date (additive extension of `ColumnTypeSchema` + renderer branches).

- [ ] **Step 6.4: Cleanup after merge**

After the PR is squash-merged to `dev`:

```bash
git checkout dev && git pull --ff-only && git branch -d feat/citation-table-typed-columns-slice-1
```

(Remote auto-deletes; `-d` warns "not merged to HEAD" because of the squash — expected, the branch IS merged via the squash commit.)

---

## Out of scope (explicit deferrals — covered by other slices or handoff items)

- **Link + Date types** — slice 2.
- **Persisted sort order** — separate handoff item.
- **Undo/redo** — separate handoff item.
- **Row drag-reorder** — separate handoff item.
- **Keyboard-accessible column reorder** — separate handoff item.

## Risks (called out, no mitigations needed in this slice)

- **Existing un-typed "Sample size"-style columns** don't suddenly sort numerically — they default to Text and behave identically to today.
- **`sortRowOrder` signature widens** (gains optional `type` arg). All existing callers pass `undefined`; behavior is identical when type is absent.
- **The today's numeric sniff inside `sortRowOrder`** is removed; replaced by explicit `compareForSort` delegation. Text-typed columns use `localeCompare` exactly as before.
- **Extraction prompt gains a per-type instruction line** when typed hints are supplied. The model may still occasionally emit a value that doesn't match the type; `validateCell` surfaces the inline warning.