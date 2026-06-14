# Citation-table typed columns — Slice 2 (Link + Date) Design

**Status:** Approved design. Slice 2 of two in the citation-table typed-columns arc. Slice 1 (Text + Number) shipped in #230; its plan was reconciled with as-shipped reality in #232.

**Goal:** Add two more column types — **Link** (`http(s)://` only) and **Date** (strict ISO `YYYY-MM-DD`) — to the citation-table typed-columns system. Type-aware render, validate (tolerate + warn), sort, and extraction hints, following the exact additive pattern slice 1 established.

**Non-goal:** Any persistence migration. `type` remains `.optional()` and defaults to Text on read, so existing blobs validate unchanged — **zero migration, no `STORE_VERSION` bump.**

---

## Decisions locked during brainstorming

Slice 1 pre-locked two of these (carried forward); the other three are slice-2-specific.

| # | Decision | Choice | Source |
|---|---|---|---|
| Carried | Type set | Text, Number, **Link, Date** | slice 1 Q1 |
| Carried | Link scope | **`http(s)://` only** | slice 1 Q2b |
| D1 | Date semantics | **Strict ISO `YYYY-MM-DD` + a real date comparator.** `validateCell` warns on non-ISO; `compareForSort` gets a dedicated date branch (parse to timestamp; invalid/empty sort last). Fixes the numeric-sniff bug (see Risks). | slice 2 |
| D2 | Date editor | **Native `<input type="date">` picker.** Consequence: editing canonicalizes to ISO; the ⚠ still serves display of un-cleaned values. See "Date editor consequence". | slice 2 |
| D3 | Link cell behavior | **Edit-on-click + `↗` open icon.** Read-only renders a clickable anchor; editable keeps click-to-edit (uniform with all types) plus a small open-in-new-tab affordance for valid URLs. | slice 2 |
| Arch | Module layout | **Centralised** in `lib/shared/artifacts/column-type.ts` (unchanged from slice 1). All new type-aware pure logic lives there. | slice 1 |

---

## Architecture

Slice 2 is purely additive. The slice-1 helpers were designed to extend without touching their consumers:

- `validateCell(cell, type): string | null` — slice 2 adds `date` / `link` branches; the renderer call site is unchanged.
- `compareForSort(a, b, type, dir): number` — slice 2 adds explicit `date` / `link` branches **before** the text fallback.
- `resolveColumnType(col): ColumnType` — needs **no change**; its `includes` check auto-accepts new members and still defaults unknown → `text`.
- The schemas in `citation-table.ts` and `extract-table.ts` already reference the shared `ColumnTypeSchema`, so widening `COLUMN_TYPES` widens them for free.

The only consumer edits are: the renderer (new render branches + extended option lists), the extraction prompt (new per-type instruction lines), and one inline enum in `api-schemas.ts` swapped for `ColumnTypeSchema`.

---

## File Structure

**Modified files:**

- `lib/shared/artifacts/column-type.ts`
  - `COLUMN_TYPES = ["text", "number", "link", "date"] as const`.
  - New private helpers (pure, never-throw):
    - `parseIsoDate(value: string): number | null` — strict. Matches `^\d{4}-\d{2}-\d{2}$` **and** is a real calendar date (rejects `2024-13-40`, `2024-02-30`); returns a UTC-midnight timestamp (ms) or `null`. Implementation: regex-gate, then `Date.parse` of the ISO string, then verify the parsed `Date`'s UTC year/month/day round-trip the input components (guards JS's lenient rollover).
    - `isHttpUrl(value: string): boolean` — `new URL(value)` inside try/catch; `true` only when `protocol === "http:" || "https:"`.
  - `validateCell` — add branches:
    - `type === "date"`: non-empty and `parseIsoDate(value) === null` → `Not a date: "<display>"` (same 30-char truncation as Number).
    - `type === "link"`: non-empty and `!isHttpUrl(value)` → `Not a URL: "<display>"`.
  - `compareForSort` — add explicit branches **before** the existing text fallback:
    - `type === "date"`: parse both via `parseIsoDate`; `null`/empty sort last in both directions; compare timestamps numerically; stable on equal.
    - `type === "link"`: `va.localeCompare(vb) * sign` (NO numeric sniff).
  - `parseCellValue` — extend for coherence: `date` → `parseIsoDate(value) ?? NaN`; `link` → raw string (passthrough).

- `lib/shared/api-schemas.ts`
  - Replace the inline `z.enum(["text", "number"])` on the `columnHints` object's `type` field with `ColumnTypeSchema` (single source of truth; the slice-1 deviation #3 lesson applied to the one remaining inline enum). Import `ColumnTypeSchema` from `@/shared/artifacts/column-type`.

- `lib/shared/artifacts/extract-table.ts`
  - `buildExtractTablePrompt` — broaden the per-type instruction block (currently Number-only) so it also emits, when the corresponding type appears among the hints:
    - Link: `- For (Link) columns: emit a full http(s):// URL only (no surrounding text).`
    - Date: `- For (Date) columns: emit the date as YYYY-MM-DD (ISO 8601), e.g. "2024-01-15".`
  - The `(Type)` label suffix already renders generically (`(Link)`, `(Date)` come for free via the existing capitalize-of-`h.type`). `extractionToCitationTable`'s `type ?? "text"` fill is unchanged.

- `components/panels/citation-table.tsx`
  - Extend the three `["text", "number"]` option lists (header type pill, add-column dialog radios, extract-popover chips) to `["text", "number", "link", "date"]`. Labels: Text / Number / Link / Date. Pill glyphs: `Aa` / `#` / `↗` / `🗓` (adjustable).
  - `CellContent` gains a `type: ColumnType` prop:
    - **Read-only value render:** `link` + `isHttpUrl(value)` → `<a href={value} target="_blank" rel="noreferrer" className="hover:underline">{value}</a>`; otherwise plain `<span>{value}</span>` (unchanged).
    - **Editable value render:** the click-to-edit text button stays for all types; for `link` + `isHttpUrl(value)`, render a small `↗` open-in-new-tab anchor beside it (`target="_blank" rel="noreferrer"`, `aria-label="Open link in new tab"`, `onClick` stopPropagation so it opens rather than edits).
  - **Body-cell editor `<input>`:** `type={cellType === "date" ? "date" : cellType === "number" ? "number" : "text"}`. Date keeps `inputMode` unset (native picker). Number keeps `inputMode="decimal"` as today.

- `components/panels/extract-table-popover.tsx`
  - Extend the chip type-pill option list to all four types (same `["text","number","link","date"]` widening + glyphs).

**Untouched (explicit non-changes):**
- `resolveColumnType` — no change needed.
- `runMigrations`, `STORE_VERSION`, `store/persist.test.ts` — no persisted-shape change.
- `citation-table-md.ts` — JSON round-trip is shape-stable.
- `CitationChips`, `CitationCellEditor` — no change.
- The read-only **warning** behavior — slice 1's `cellWarning = editable ? validateCell(...) : null` is unchanged; read-only cells never show ⚠ (an invalid read-only link simply renders as plain text).

---

## Semantics summary

| Type | Canonical value | ⚠ warning when (editable, non-empty) | Sort | Editor affordance |
|---|---|---|---|---|
| text | any string | never | numeric-sniff → localeCompare (historical) | text input |
| number | finite `parseFloat` | not a finite number | strict numeric; NaN/empty last | `<input type="number" inputMode="decimal">` |
| link | `http(s)://…` URL | not an http(s) URL | `localeCompare` (no sniff) | text input + `↗` open icon |
| date | `YYYY-MM-DD` (real date) | not a valid ISO date | by parsed timestamp; invalid/empty last | native `<input type="date">` |

Raw cell values are always stored verbatim via `setCellValue` (tolerate). Warnings surface post-commit (warn). The one exception is the date picker — see below.

### Date editor consequence (D2)

A native `<input type="date">` can only hold a valid `YYYY-MM-DD` value or empty. Therefore:

- A date cell whose stored value is **already valid ISO** edits cleanly (the picker shows it).
- A date cell whose stored value is **not** valid ISO (e.g. from extraction, or after toggling a Text column to Date) renders the picker **empty** on edit. Its raw value is still **visible in display mode with a ⚠**, so the data isn't hidden and the ⚠ keeps doing real work for un-cleaned values.
- **Accepted edge:** opening the editor on a non-ISO date and committing (even via blur without interaction) canonicalizes the cell to the picker's value (a real ISO date, or empty). This is the deliberate trade-off of choosing the native picker over a plain text + warn input. It only affects Date columns and only the not-yet-cleaned values.

This is the single intentional departure from slice 1's strict "store raw verbatim on every edit" invariant, and it is scoped to the Date editor alone.

---

## Testing

Following slice 1's "one describe per helper / TDD for pure helpers, combined review for the renderer" pattern.

- `lib/shared/artifacts/column-type.test.ts` — new describe blocks:
  - `validateCell` (date): null for valid ISO / empty / missing; warning for `2024-13-40`, `15/01/2024`, `"last tuesday"`; 30-char truncation.
  - `validateCell` (link): null for `https://a.test` / `http://x` / empty; warning for `ftp://x`, `not a url`, `javascript:alert(1)`.
  - `compareForSort` (date): `2024-01-15 < 2024-12-01` ascending; the **same-year regression** (`2024-01-15` vs `2024-12-01` must NOT tie — the bug a text comparator would have); invalid/empty last in both directions; stable on equal.
  - `compareForSort` (link): `localeCompare` order; no numeric sniff (`http://8.8.8.8` vs `http://1.1.1.1` sort lexically, not numerically).
  - `parseCellValue` (date → timestamp / NaN; link → passthrough).
  - `ColumnTypeSchema` accepts `link` / `date`; still rejects `""` / `banana` / `123`.
- `lib/shared/artifacts/extract-table.test.ts` — `buildExtractTablePrompt` renders `(Link)` / `(Date)` suffixes and the new per-type instruction lines; no-hint and Text-only paths stay byte-identical (regression guard).
- `lib/shared/artifacts/citation-table.test.ts` — `sortRowOrder(data, col, dir, "date")` orders chronologically incl. the same-year case; un-typed regression guard untouched.
- **Renderer** — combined spec + quality review subagent at the end (proportionate pattern), plus the manual browser pass below. The agent cannot drive an AI-gateway extraction.

### Manual browser pass (reviewer-driven)

1. Add a **Link** column; paste `https://example.com` into a cell → it renders as a clickable link in read-only; the `↗` icon opens it in a new tab in editable mode.
2. Type `not a url` into a Link cell → ⚠ `Not a URL: "not a url"` appears (editable); read-only shows plain text.
3. Add a **Date** column; the cell editor is a native date picker; pick a date → stores `YYYY-MM-DD`.
4. Sort the Date column → chronological order, including two dates in the same year (regression).
5. An extracted/Text-toggled non-ISO date shows ⚠ in display; opening the picker shows empty; picking a date canonicalizes it.
6. The header type pill, add-column dialog, and extraction chips all offer Text / Number / Link / Date.
7. Reload → Link/Date `type` persists in the JSON.

---

## Risks

- **The numeric-sniff trap (motivates D1).** `compareForSort`'s text branch tries `parseFloat` first. `parseFloat("2024-01-15")` returns `2024`, so two same-year ISO dates would parse to the same number and tie — a date column sorted via the text comparator would be visibly wrong. Slice 2's dedicated date branch (parse the full ISO date) is required, not optional. Link's branch must also bypass the sniff (a URL like `http://8.8.8.8` should not sort numerically).
- **Date timezone.** `parseIsoDate` parses the date-only ISO form as UTC midnight, used only for comparison — consistent across rows, no display conversion. Out of scope: time-of-day, locale display, relative dates.
- **Native picker data-loss edge.** Documented under "Date editor consequence" — accepted, scoped to Date, surfaced by the persisting ⚠ on un-cleaned values.
- **Schema desync.** Eliminated by routing the last inline `z.enum` (in `api-schemas.ts`) through `ColumnTypeSchema`.

---

## Out of scope (explicit deferrals)

- Date time-of-day, timezone display, locale-formatted or relative/natural dates.
- Link display truncation, favicons, or title resolution (the full URL is the link text).
- Persisted sort order; undo/redo; row drag-reorder; keyboard-accessible column reorder — separate handoff items.

---

## Slice arc complete

With Link + Date, `ColumnTypeSchema` covers the full Core type set (Text, Number, Link, Date) from slice 1's Q1. No further slices planned for the typed-columns arc.
