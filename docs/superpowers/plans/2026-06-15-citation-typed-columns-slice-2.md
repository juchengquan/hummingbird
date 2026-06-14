# Citation-table typed columns — Slice 2 (Link + Date) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Link (`http(s)://` only) and Date (strict ISO `YYYY-MM-DD`) column types to the citation-table typed-columns system — type-aware validate, sort, render, and extraction hints.

**Architecture:** Purely additive over slice 1. Widen `COLUMN_TYPES` and add `date`/`link` branches to the centralised pure helpers in `lib/shared/artifacts/column-type.ts` (`validateCell`, `compareForSort`, `parseCellValue`), plus two new helpers (`parseIsoDate`, `isHttpUrl`) and display-metadata constants. The schemas in `citation-table.ts` and `extract-table.ts` widen for free (they already reference `ColumnTypeSchema`); the one remaining inline enum in `api-schemas.ts` is swapped to `ColumnTypeSchema`. The renderer gains link/date branches and a native date picker. No persistence migration.

**Tech Stack:** TypeScript 5.x · Bun · Zod · React 19.2 · shadcn/ui (Popover, Dialog) · Tailwind 4

**Spec:** `docs/superpowers/specs/2026-06-15-citation-typed-columns-slice-2-design.md`

**Loop:** Slice pattern. Pure-helper tasks (1–3) are TDD and verifiable in isolation. The renderer task (4) is the substantive UI change and gets a combined spec+quality review subagent at the end. End with `bun run check`, `bun run test`, `bun run build`, `bun run audit:bundle`, and the manual browser pass.

---

## File Structure

**Modified files (6):**
- `lib/shared/artifacts/column-type.ts` — widen `COLUMN_TYPES`; add `parseIsoDate` + `isHttpUrl` + display-metadata constants; add `date`/`link` branches to `validateCell`, `compareForSort`, `parseCellValue`.
- `lib/shared/artifacts/column-type.test.ts` — new describe blocks for the date/link branches + schema + display constants.
- `lib/shared/api-schemas.ts` — swap the inline `z.enum(["text","number"])` on `columnHints[].type` for `ColumnTypeSchema`.
- `lib/shared/artifacts/extract-table.ts` — broaden the prompt's per-type instruction block to cover Link + Date.
- `lib/shared/artifacts/extract-table.test.ts` — new tests for the link/date prompt hints.
- `components/panels/citation-table.tsx` — extend the type option lists (via the new display constants); `CellContent` gains a `type` prop with link/date render branches; body-cell editor uses `<input type="date">` for date columns.
- `components/panels/extract-table-popover.tsx` — extend the chip type-pill option list to all four types.

**Untouched (explicit non-changes):**
- `resolveColumnType` — no change needed (its `includes` check auto-accepts the new members).
- `runMigrations`, `STORE_VERSION`, `store/persist.test.ts` — no persisted-shape change.
- `citation-table-md.ts`, `CitationChips`, `CitationCellEditor` — no change.
- Read-only warning behavior — `cellWarning = editable ? validateCell(...) : null` is unchanged (read-only cells never show ⚠).

---

## Task 1: Helpers — widen `column-type.ts` for Link + Date

**Files:**
- Modify: `lib/shared/artifacts/column-type.ts`
- Modify: `lib/shared/artifacts/column-type.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Append to `lib/shared/artifacts/column-type.test.ts` (do not modify existing tests). Note the existing test file already defines `cell` and imports the helpers — add the new symbols to the existing import and add the new describe blocks:

Add `COLUMN_TYPE_GLYPHS`, `COLUMN_TYPE_LABELS`, and `isHttpUrl` to the existing import from `./column-type`, then append:

```ts
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
    // parseFloat('2024-01-15') === 2024 === parseFloat('2024-12-01'); a text
    // comparator would tie these. The date branch must not.
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
    // localeCompare: '1...' < '8...'. A numeric sniff would compare 1.1.1.1
    // vs 8.8.8.8 as parseFloat 1 vs 8 — same direction here, so use a case
    // where lexical and numeric disagree:
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
```

Also add `COLUMN_TYPES` to the existing import if not already present.

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `bun test lib/shared/artifacts/column-type.test.ts`
Expected: FAIL — `isHttpUrl`, `COLUMN_TYPE_LABELS`, `COLUMN_TYPE_GLYPHS` are not exported; the `date`/`link` validate/compare branches don't exist yet (date/link currently fall through to the text comparator, so the same-year and warning assertions fail).

- [ ] **Step 1.3: Widen `COLUMN_TYPES` + add display metadata**

In `lib/shared/artifacts/column-type.ts`, replace the `COLUMN_TYPES` / `ColumnTypeSchema` / `ColumnType` block (currently lines 5-9):

```ts
/** The full Core column-type set. Slice 1 shipped text + number;
 *  slice 2 adds link + date. */
export const COLUMN_TYPES = ["text", "number", "link", "date"] as const
export const ColumnTypeSchema = z.enum(COLUMN_TYPES)
export type ColumnType = (typeof COLUMN_TYPES)[number]

/** Human labels for the type picker / radios / chips. */
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  text: "Text",
  number: "Number",
  link: "Link",
  date: "Date",
}

/** Short glyphs for the inline type pills. */
export const COLUMN_TYPE_GLYPHS: Record<ColumnType, string> = {
  text: "Aa",
  number: "#",
  link: "↗",
  date: "🗓",
}
```

- [ ] **Step 1.4: Add the `parseIsoDate` + `isHttpUrl` helpers**

In `lib/shared/artifacts/column-type.ts`, add these after the `resolveColumnType` function (pure, never-throw):

```ts
/** Strict ISO date parser. Accepts only `YYYY-MM-DD` that is also a
 *  real calendar date (rejects 2024-13-40, 2024-02-30). Returns a
 *  UTC-midnight timestamp (ms) or null. Never throws. */
function parseIsoDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const ts = Date.UTC(year, month - 1, day)
  const dt = new Date(ts)
  // Reject lenient rollover (e.g. month 13 / day 40 wrapping forward).
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null
  }
  return ts
}

/** True only for `http://` / `https://` URLs. Never throws. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}
```

- [ ] **Step 1.5: Extend `parseCellValue`**

Replace the body of `parseCellValue` (currently lines 23-29) so it handles date + link:

```ts
export function parseCellValue(value: string, type: ColumnType): number | string {
  if (type === "number") {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : NaN
  }
  if (type === "date") {
    return parseIsoDate(value) ?? NaN
  }
  return value
}
```

(The JSDoc above it stays accurate enough; optionally note date → timestamp.)

- [ ] **Step 1.6: Add `validateCell` date + link branches**

In `validateCell`, after the existing `if (type === "number") {...}` block and before the final `return null`, add:

```ts
  if (type === "date") {
    if (parseIsoDate(cell.value) !== null) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a date: "${display}"`
  }
  if (type === "link") {
    if (isHttpUrl(cell.value)) return null
    const display = cell.value.length > 30 ? `${cell.value.slice(0, 30)}…` : cell.value
    return `Not a URL: "${display}"`
  }
```

- [ ] **Step 1.7: Add `compareForSort` date + link branches**

In `compareForSort`, after the existing `if (type === "number") {...}` block and before the `// type === "text"` text-fallback comment, add:

```ts
  if (type === "date") {
    const ta = parseIsoDate(va)
    const tb = parseIsoDate(vb)
    const aBad = ta === null
    const bBad = tb === null
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return ta === tb ? 0 : (ta < tb ? -1 : 1) * sign
  }
  if (type === "link") {
    return va.localeCompare(vb) * sign
  }
```

- [ ] **Step 1.8: Run the tests to verify they pass**

Run: `bun test lib/shared/artifacts/column-type.test.ts`
Expected: PASS (all slice-1 tests + the new date/link/schema/display blocks).

- [ ] **Step 1.9: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: typecheck clean; lint 0 errors (pre-existing warnings in `app/api/summarize/route.ts` + `services/agent-ts/*` are unrelated).

- [ ] **Step 1.10: Commit**

```bash
git add lib/shared/artifacts/column-type.ts lib/shared/artifacts/column-type.test.ts
git commit -m "feat(citation-table): add Link + Date column-type helpers

Widen COLUMN_TYPES to the full Core set (text, number, link, date) and
add the slice-2 pure logic to the centralised module:
- parseIsoDate (strict YYYY-MM-DD, rejects impossible dates) + isHttpUrl
- validateCell date/link branches (tolerate + warn)
- compareForSort date branch (real chronological sort — NOT the text
  numeric-sniff, which would tie same-year dates) + link branch
  (localeCompare, no sniff)
- parseCellValue date → timestamp
- COLUMN_TYPE_LABELS / COLUMN_TYPE_GLYPHS display metadata for the UI

All helpers pure / never-throw. Schemas referencing ColumnTypeSchema
widen for free; no persistence migration.

Spec: docs/superpowers/specs/2026-06-15-citation-typed-columns-slice-2-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route the last inline enum through `ColumnTypeSchema`

**Files:**
- Modify: `lib/shared/api-schemas.ts`

- [ ] **Step 2.1: Add the import**

At the top of `lib/shared/api-schemas.ts`, below `import { z } from 'zod'`, add:

```ts
import { ColumnTypeSchema } from '@/shared/artifacts/column-type'
```

- [ ] **Step 2.2: Swap the inline enum**

In `ExtractTableRequestSchema.columnHints` (currently around lines 617-628), replace the inline `type` enum:

```ts
        z.object({
          label: z.string().min(1).max(60),
          type: z.enum(["text", "number"]).optional(),
        }),
```

with:

```ts
        z.object({
          label: z.string().min(1).max(60),
          type: ColumnTypeSchema.optional(),
        }),
```

- [ ] **Step 2.3: Add a regression test for the widened wire shape**

Append to `lib/shared/api-schemas.test.ts` if it exists; otherwise create it with:

```ts
import { describe, expect, test } from "bun:test"

import { ExtractTableRequestSchema } from "./api-schemas"

describe("ExtractTableRequestSchema.columnHints accepts the full type set", () => {
  const base = { reportText: "r", sources: [{ title: "t" }] }
  test("accepts link + date typed hints", () => {
    const r = ExtractTableRequestSchema.safeParse({
      ...base,
      columnHints: [
        { label: "Home page", type: "link" },
        { label: "Launched", type: "date" },
      ],
    })
    expect(r.success).toBe(true)
  })
  test("still accepts legacy string hints", () => {
    const r = ExtractTableRequestSchema.safeParse({ ...base, columnHints: ["Drug", "N"] })
    expect(r.success).toBe(true)
  })
  test("rejects an unknown type", () => {
    const r = ExtractTableRequestSchema.safeParse({
      ...base,
      columnHints: [{ label: "X", type: "banana" }],
    })
    expect(r.success).toBe(false)
  })
})
```

> **Check before writing:** if `lib/shared/api-schemas.test.ts` already exists, inspect the `sources` element shape it uses and match it (the `sources` item schema may require `url`/`snippet` — adapt `base.sources` so the fixtures validate for reasons unrelated to `columnHints`). The goal is that the only variable under test is `columnHints`.

- [ ] **Step 2.4: Run the test + typecheck**

Run: `bun test lib/shared/api-schemas.test.ts && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 2.5: Commit**

```bash
git add lib/shared/api-schemas.ts lib/shared/api-schemas.test.ts
git commit -m "refactor(api-schemas): route columnHints type through ColumnTypeSchema

The last inline z.enum(['text','number']) on the extract-table request
schema is replaced with the shared ColumnTypeSchema, so the wire shape
widens to link + date with COLUMN_TYPES and can never desync again
(the slice-1 deviation-3 lesson applied to the final inline enum).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extraction prompt — Link + Date hints

**Files:**
- Modify: `lib/shared/artifacts/extract-table.ts`
- Modify: `lib/shared/artifacts/extract-table.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Append to `lib/shared/artifacts/extract-table.test.ts` (the file already imports `buildExtractTablePrompt` and defines `sources`):

```ts
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
```

- [ ] **Step 3.2: Run the tests to verify they fail**

Run: `bun test lib/shared/artifacts/extract-table.test.ts`
Expected: FAIL on the link/date instruction tests (the prompt only emits Number instructions today). The `(Link)`/`(Date)` suffix test may already pass — the suffix renders generically — but the instruction-line tests fail.

- [ ] **Step 3.3: Broaden the per-type instruction block**

In `lib/shared/artifacts/extract-table.ts`, replace the `typeBlock` definition (currently lines 113-124) with one that conditionally includes each type's line:

```ts
  // When typed hints are supplied, render per-type value-format
  // instructions only for the types actually present. Text needs no
  // explicit instruction beyond "use these labels exactly".
  const presentTypes = new Set((typedHints ?? []).map((h) => h.type ?? "text"))
  const typeLines: string[] = []
  if (presentTypes.has("number")) {
    typeLines.push(
      '- For (Number) columns: emit the bare numeric value only, no units or words (e.g. "200" not "two hundred", "3.14" not "approximately three").',
    )
  }
  if (presentTypes.has("link")) {
    typeLines.push(
      "- For (Link) columns: emit a full http(s):// URL only (no surrounding text).",
    )
  }
  if (presentTypes.has("date")) {
    typeLines.push(
      '- For (Date) columns: emit the date as YYYY-MM-DD (ISO 8601), e.g. "2024-01-15".',
    )
  }
  const typeBlock =
    typeLines.length > 0
      ? ["", "Per-type value format:", "- For (Text) columns: emit prose.", ...typeLines].join("\n")
      : ""
```

(This preserves the slice-1 behavior: Number-only hints produce the same block content, just assembled from the array. Text-only hints produce no block.)

- [ ] **Step 3.4: Run the tests to verify they pass**

Run: `bun test lib/shared/artifacts/extract-table.test.ts`
Expected: PASS (new + existing). Then run `bun test lib/shared/artifacts/column-type.test.ts` to confirm no regression.

- [ ] **Step 3.5: Run lint + typecheck**

Run: `bun run typecheck && bun run lint`
Expected: clean / 0 errors.

- [ ] **Step 3.6: Commit**

```bash
git add lib/shared/artifacts/extract-table.ts lib/shared/artifacts/extract-table.test.ts
git commit -m "feat(citation-table): extraction prompt hints for Link + Date

buildExtractTablePrompt now emits per-type value-format instructions for
Link (full http(s):// URL) and Date (YYYY-MM-DD), assembled per the
types actually present among the hints. Number-only behavior is
preserved; the (Link)/(Date) label suffixes render via the existing
generic capitalize. No-hints + Text-only paths unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Renderer — Link + Date cells, type pills, date picker

**Files:**
- Modify: `components/panels/citation-table.tsx`
- Modify: `components/panels/extract-table-popover.tsx`

This is the substantive UI task. After committing, dispatch the combined spec+quality review subagent (Step 4.10) before Task 5.

- [ ] **Step 4.1: Update imports in `citation-table.tsx`**

Find the existing import from `@/shared/artifacts/column-type` (currently imports `resolveColumnType, validateCell` + `type ColumnType`). Replace it with:

```ts
import type { ColumnType } from "@/shared/artifacts/column-type"
import {
  COLUMN_TYPES,
  COLUMN_TYPE_GLYPHS,
  COLUMN_TYPE_LABELS,
  isHttpUrl,
  resolveColumnType,
  validateCell,
} from "@/shared/artifacts/column-type"
```

- [ ] **Step 4.2: Drive the header type pill glyph + options from the constants**

In the header pill, replace the trigger glyph (currently `{colType === "number" ? "#" : "Aa"}`, around line 294):

```tsx
{COLUMN_TYPE_GLYPHS[colType]}
```

Replace the popover option loop (currently `(["text", "number"] as const).map((opt) => (...))` around lines 299-320). Change the iterator to `COLUMN_TYPES.map((opt) => (...))` and the label (currently `{opt === "text" ? "Text" : "Number"}`, line 318) to:

```tsx
{COLUMN_TYPE_LABELS[opt]}
```

(Leave the existing `onClick` body that sets `col.type` and the `colType === opt` active-class logic intact.)

- [ ] **Step 4.3: Drive the add-column dialog radios from the constants**

In the add-column dialog radio row (currently `(["text", "number"] as const).map((opt) => (...))` around lines 521-533), change the iterator to `COLUMN_TYPES.map((opt) => (...))` and the label (line 530) to:

```tsx
{COLUMN_TYPE_LABELS[opt]}
```

- [ ] **Step 4.4: Give `CellContent` a `type` prop**

In the `CellContent` props type (currently lines 96-104), add `type`:

```ts
}: {
  data: CitationTable
  cell?: CitationTableCell
  type: ColumnType
  editable: boolean
  onStartEdit: () => void
  onAddCitation: (citation: Citation) => void
  onUpdateCitation: (citIndex: number, patch: Partial<Citation>) => void
  onRemoveCitation: (citIndex: number) => void
}) {
```

Add `type,` to the destructured params at the top of the function (currently lines 88-95).

- [ ] **Step 4.5: Render link branches in `CellContent`**

Replace the `valueEl` definition (currently lines 105-114) with:

```tsx
  const value = cell?.value ?? ""
  const isLink = type === "link" && isHttpUrl(value)
  const valueEl = editable ? (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={onStartEdit} className="text-left hover:underline">
        {value || <span className="text-[var(--muted-foreground)]">—</span>}
      </button>
      {isLink ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          aria-label="Open link in new tab"
          onClick={(e) => e.stopPropagation()}
          className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          ↗
        </a>
      ) : null}
    </span>
  ) : value ? (
    isLink ? (
      <a href={value} target="_blank" rel="noreferrer" className="hover:underline">
        {value}
      </a>
    ) : (
      <span>{value}</span>
    )
  ) : (
    <span className="text-[var(--muted-foreground)]">—</span>
  )
```

- [ ] **Step 4.6: Pass `type` to `CellContent` at the call site**

In the body-cell `cellInner` definition (currently around lines 379-393), add `type={cellType}` to the `<CellContent>` props:

```tsx
                  <CellContent
                    data={data}
                    cell={cell}
                    type={cellType}
                    editable={editable}
                    onStartEdit={() => startEdit(rowIndex, col.id, cell?.value ?? "")}
                    onAddCitation={(c) => onChange?.(addCitation(data, rowIndex, col.id, c))}
                    onUpdateCitation={(i, patch) =>
                      onChange?.(updateCitation(data, rowIndex, col.id, i, patch))
                    }
                    onRemoveCitation={(i) =>
                      onChange?.(removeCitation(data, rowIndex, col.id, i))
                    }
                  />
```

- [ ] **Step 4.7: Use the native date picker for Date cells**

In the editable body-cell `<input>` (currently lines 417-418), replace the `type` and `inputMode` props:

```tsx
                            type={
                              cellType === "date"
                                ? "date"
                                : cellType === "number"
                                  ? "number"
                                  : "text"
                            }
                            inputMode={cellType === "number" ? "decimal" : undefined}
```

(Leave `value={draft}`, `onChange`, `onBlur={commit}`, the Enter/Escape handler, `aria-label`, and `className` unchanged. A non-ISO date renders the picker empty — the accepted consequence from the spec.)

- [ ] **Step 4.8: Update `extract-table-popover.tsx`**

In `components/panels/extract-table-popover.tsx`:

Add the constants to the existing `@/shared/artifacts/column-type` import (which currently imports `resolveColumnType`):

```ts
import { COLUMN_TYPES, COLUMN_TYPE_GLYPHS, COLUMN_TYPE_LABELS, resolveColumnType } from "@/shared/artifacts/column-type"
```

Replace the chip pill glyph (currently `{chipType === "number" ? "#" : "Aa"}`, around line 96):

```tsx
{COLUMN_TYPE_GLYPHS[chipType]}
```

Replace the chip popover option loop (currently `(["text", "number"] as const).map((opt) => (...))` around lines 101-114): change the iterator to `COLUMN_TYPES.map((opt) => (...))` and the label (line 113) to:

```tsx
{COLUMN_TYPE_LABELS[opt]}
```

- [ ] **Step 4.9: Run check**

Run: `bun run typecheck && bun run lint`
Expected: typecheck clean; lint 0 errors (pre-existing warnings only).

- [ ] **Step 4.10: Commit the renderer changes**

```bash
git add components/panels/citation-table.tsx components/panels/extract-table-popover.tsx
git commit -m "feat(citation-table): Link + Date renderer + native date picker

- Type pill / add-column radios / extraction chips now iterate
  COLUMN_TYPES and use COLUMN_TYPE_LABELS + COLUMN_TYPE_GLYPHS (all four
  types; DRY display metadata).
- CellContent gains a type prop: Link cells render a clickable
  <a target=_blank rel=noreferrer> in read-only, and keep click-to-edit
  plus a small ↗ open-in-new-tab icon in editable mode.
- Date cells edit via a native <input type=date> picker; a non-ISO
  value shows the picker empty (accepted canonicalization consequence)
  while the ⚠ surfaces it in display mode via validateCell.

Editable-mode only; the read-only path's warning behavior is unchanged.

Spec: docs/superpowers/specs/2026-06-15-citation-typed-columns-slice-2-design.md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4.11: Dispatch the combined spec+quality review subagent**

Dispatch a fresh subagent with: the spec path, this plan's Task 4 section, the list of files changed in Task 4, and the instruction: "Verify the implementation matches the spec section by section, and run a quality review for accessibility (link `↗` reachable + labelled, nested-interactive validity, date input aria), edge cases (non-ISO date edit canonicalization, invalid link rendering, empty cells), and adherence to the established citation-table polish pattern. Report findings as (1) blockers, (2) suggestions, (3) nits. Do not change code." Block on any blockers before Task 5.

---

## Task 5: End-to-end verification + PR

**Files:** none modified — verification only.

- [ ] **Step 5.1: Run the full local gate**

Run:
```bash
bun run typecheck
bun run lint
bun run test
```
Expected: typecheck clean; lint 0 errors (pre-existing warnings OK); `test` shows all prior tests + the new column-type / extract-table / api-schemas tests green, 0 failures.

- [ ] **Step 5.2: Production build + bundle audit**

Run:
```bash
bun run build
bun run audit:bundle
```
Expected: build succeeds; audit reports no server-only paths or secret env-var names in client chunks (the slice-2 changes are client/isomorphic only).

- [ ] **Step 5.3: Push + open the PR into `dev`**

```bash
git push -u origin feat/citation-table-typed-columns-slice-2
gh pr create --base dev --head feat/citation-table-typed-columns-slice-2 \
  --title "feat(citation-table): typed columns slice 2 (Link + Date)" \
  --body-file <(cat <<'BODY'
## Summary

Completes the citation-table typed-columns arc: adds **Link** (`http(s)://` only) and **Date** (strict ISO `YYYY-MM-DD`) column types. Type-aware validate (tolerate + warn), sort, render, and extraction hints. Additive — no persistence migration, no `STORE_VERSION` bump.

## Changes
- `column-type.ts`: `COLUMN_TYPES` → text/number/link/date; `parseIsoDate` + `isHttpUrl`; date/link branches in `validateCell`, `compareForSort` (real chronological date sort, **not** the text numeric-sniff that would tie same-year dates), `parseCellValue`; `COLUMN_TYPE_LABELS` / `COLUMN_TYPE_GLYPHS`.
- `api-schemas.ts`: last inline `z.enum` routed through `ColumnTypeSchema`.
- `extract-table.ts`: per-type prompt hints for Link + Date.
- Renderer: clickable links (read-only anchor; editable click-to-edit + `↗` open icon); native `<input type="date">` for Date cells; all four types in the pills/radios/chips.

## Links
- Spec: `docs/superpowers/specs/2026-06-15-citation-typed-columns-slice-2-design.md`
- Plan: `docs/superpowers/plans/2026-06-15-citation-typed-columns-slice-2.md`

## Verification
- typecheck / lint / test / build / audit:bundle all green.

## Test Plan (manual browser pass — reviewer-driven)
1. Add a Link column; paste `https://example.com` → clickable in read-only; `↗` opens it in editable mode.
2. Type `not a url` into a Link cell → ⚠ `Not a URL`.
3. Add a Date column; cell editor is a native date picker; pick a date → stores `YYYY-MM-DD`.
4. Sort the Date column → chronological, including two same-year dates (regression).
5. A non-ISO date (extracted / Text-toggled) shows ⚠ in display; picker opens empty; picking canonicalizes.
6. Pills / add-column dialog / extraction chips all offer Text / Number / Link / Date.
7. Reload → Link/Date `type` persists.

## Notes
- Native date picker canonicalizes a bad date on edit (accepted, scoped to Date) — see spec "Date editor consequence".
- Closes the typed-columns arc (full Core type set shipped).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)
```

> If `gh` process-substitution of the body is awkward in the execution shell, write the body to a temp file and pass `--body-file /tmp/pr-body-slice2.md`.

- [ ] **Step 5.4: Cleanup after merge**

After the PR is squash-merged to `dev`:

```bash
git checkout dev && git pull --ff-only && git branch -d feat/citation-table-typed-columns-slice-2
```

(`-d` may warn "not merged" because of the squash — expected; the branch IS merged via the squash commit.)

---

## Out of scope (explicit deferrals)

- Date time-of-day, timezone display, locale-formatted or relative/natural dates.
- Link display truncation, favicons, or title resolution.
- Persisted sort order; undo/redo; row drag-reorder; keyboard-accessible column reorder — separate handoff items.

## Risks (called out)

- **Numeric-sniff trap (motivates the date comparator):** `compareForSort`'s text branch numeric-sniffs, and `parseFloat("2024-01-15") === 2024`, so a date column sorted via the text comparator would tie all same-year dates. Task 1's date branch is required — Step 1.1's "same-year dates do NOT tie" test guards it.
- **Native picker canonicalization:** editing a non-ISO date via the picker replaces it with a real ISO date (or empty). Accepted, scoped to Date, surfaced by the persisting ⚠.
- **Link sort lexical:** `localeCompare` on URLs (no numeric sniff); a URL like `http://10.0.0.1` sorts lexically, intended.
```
