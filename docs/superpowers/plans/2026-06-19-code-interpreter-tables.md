# Code interpreter — rich tables (PR-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runCode` returns a structured table (the model writes `/tmp/<name>.table.json`) that renders as a data-grid in chat.

**Architecture:** The microsandbox client `JSON.parse`s any `/tmp/*.table.json` into `RawRun.tables: unknown[]` (parse only). The **pure** marshaller owns all interpretation — `normalizeTable()` handles both `{columns,rows}` and pandas `to_json(orient="split")` `{columns,data}`, stringifies cells, and caps cols/rows/cell length — emitting `{ type:"table" }` `CodeResult` cells. Those ride the existing `data-code-result` path (route/translator/store/schema unchanged — PR-1 reserved the `table` cell). A new `table` branch in the render component draws the grid.

**Tech Stack:** TypeScript, microsandbox Node SDK, React, bun:test.

**Spec:** `docs/superpowers/specs/2026-06-19-code-interpreter-tables-design.md` · **Builds on:** #243 (PR-1), #244 (PR-2).

---

## File structure

**Modified:**
- `lib/server/code-sandbox/config.ts` — table caps.
- `lib/server/code-sandbox/marshal.ts` (+ `marshal.test.ts`) — `RawRun.tables`, `normalizeTable`, table mapping + caps.
- `lib/server/code-sandbox/microsandbox-client.ts` — read + `JSON.parse` `/tmp/*.table.json`.
- `lib/server/skills/code-interpreter.ts` — prompt: how to emit a table.
- `components/panels/code-result.tsx` — `table` render branch.

**Unchanged (PR-1 already carries the `table` cell):** `app/api/chat/route.ts`, `sse-emitter.ts`, `sse-frame-translator.ts`, `messages` slice, `lib/shared/types.ts`, `api-schemas.ts`.

---

## Task 1: Table caps in config

**Files:** Modify `lib/server/code-sandbox/config.ts`

- [ ] **Step 1: Add the caps** (after the `MOUNT_*` block)

```ts
/** Rich-table caps (runCode PR-3). Over-cap → truncated + a note. */
export const TABLE_MAX_COLS = Number(process.env.CODE_SANDBOX_TABLE_MAX_COLS) || 50
export const TABLE_MAX_ROWS = Number(process.env.CODE_SANDBOX_TABLE_MAX_ROWS) || 1000
export const TABLE_CELL_MAX = Number(process.env.CODE_SANDBOX_TABLE_CELL_MAX) || 500
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/code-sandbox/config.ts
git commit -m "feat(code-sandbox): table size caps config (PR-3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Marshal — normalize + cap tables (TDD)

**Files:** Modify `lib/server/code-sandbox/marshal.ts` + `marshal.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `marshal.test.ts`; it already imports `toCodeRunResult` + `base: RawRun`)

```ts
import { normalizeTable } from "./marshal"

describe("normalizeTable", () => {
  test("{columns, rows} shape → stringified table", () => {
    expect(normalizeTable({ columns: ["a", "b"], rows: [[1, 2], [3, 4]] })).toEqual({
      columns: ["a", "b"],
      rows: [["1", "2"], ["3", "4"]],
    })
  })
  test("pandas orient=split {columns, data, index} → uses data, ignores index", () => {
    expect(
      normalizeTable({ columns: ["x"], data: [[true], [null]], index: [0, 1] }),
    ).toEqual({ columns: ["x"], rows: [["true"], [""]] })
  })
  test("non-scalar cells are JSON-encoded (no [object Object])", () => {
    expect(normalizeTable({ columns: ["c"], rows: [[{ k: 1 }]] })).toEqual({
      columns: ["c"],
      rows: [['{"k":1}']],
    })
  })
  test("garbage → null", () => {
    expect(normalizeTable(null)).toBeNull()
    expect(normalizeTable({ columns: "nope" })).toBeNull()
    expect(normalizeTable({ rows: [[1]] })).toBeNull() // no columns
  })
})

describe("toCodeRunResult — tables", () => {
  test("tables become table CodeResult cells", () => {
    const r = toCodeRunResult({ ...base, tables: [{ columns: ["a"], rows: [["1"]] }] })
    expect(r.results).toContainEqual({ type: "table", columns: ["a"], rows: [["1"]] })
  })
  test("ignores unparseable table entries", () => {
    const r = toCodeRunResult({ ...base, tables: [42, { columns: ["a"], rows: [["1"]] }] })
    expect(r.results.filter((x) => x.type === "table")).toHaveLength(1)
  })
  test("caps columns/rows and notes the truncation", () => {
    const cols = Array.from({ length: 60 }, (_, i) => `c${i}`)
    const rows = Array.from({ length: 1100 }, () => cols.map(() => "x"))
    const r = toCodeRunResult({ ...base, tables: [{ columns: cols, rows }] })
    const t = r.results.find((x) => x.type === "table") as { columns: string[]; rows: string[][] }
    expect(t.columns.length).toBe(50)
    expect(t.rows.length).toBe(1000)
    expect(t.rows[0].length).toBe(50)
    expect(r.results.some((x) => x.type === "text" && x.value.toLowerCase().includes("truncated"))).toBe(true)
  })
  test("caps long cell values", () => {
    const r = toCodeRunResult({ ...base, tables: [{ columns: ["a"], rows: [["y".repeat(600)]] }] })
    const t = r.results.find((x) => x.type === "table") as { rows: string[][] }
    expect(t.rows[0][0].length).toBeLessThanOrEqual(500 + 1) // +1 for the … marker
  })
})
```
> The `marshal.test.ts` `base` fixture predates `tables`; since `RawRun.tables` is optional (below), existing `base`-spread tests stay valid. Add `tables` only in the new cases.

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement in `marshal.ts`**

Add `tables?` to `RawRun`:
```ts
  /** Raw JSON values parsed from /tmp/*.table.json (PR-3). Interpreted
   *  + capped here so the client stays parse-only. */
  tables?: unknown[]
```
Add the imports + the pure normalizer + cap helper, and emit table cells in `toCodeRunResult`:
```ts
import { RESULT_CAP, STDOUT_CAP, TABLE_CELL_MAX, TABLE_MAX_COLS, TABLE_MAX_ROWS } from "./config"

function cellToString(v: unknown): string {
  if (typeof v === "string") return v
  if (v === null || v === undefined) return ""
  if (typeof v === "object") {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/** Normalize a parsed /tmp/*.table.json value into a string table, or
 *  null if it isn't a recognizable table. Accepts `{columns, rows}` and
 *  pandas `orient="split"` `{columns, data, index?}`. Pure. */
export function normalizeTable(parsed: unknown): { columns: string[]; rows: string[][] } | null {
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.columns)) return null
  const rowsRaw = Array.isArray(obj.rows) ? obj.rows : Array.isArray(obj.data) ? obj.data : null
  if (!rowsRaw) return null
  const columns = obj.columns.map(cellToString)
  const rows = rowsRaw.map((row) =>
    Array.isArray(row) ? row.map(cellToString) : [cellToString(row)],
  )
  return { columns, rows }
}

/** Apply the col/row/cell caps; returns the (possibly clipped) table and
 *  whether anything was truncated. */
function capTable(t: { columns: string[]; rows: string[][] }): {
  table: { columns: string[]; rows: string[][] }
  truncated: boolean
} {
  let truncated = false
  let columns = t.columns
  if (columns.length > TABLE_MAX_COLS) {
    columns = columns.slice(0, TABLE_MAX_COLS)
    truncated = true
  }
  let rows = t.rows
  if (rows.length > TABLE_MAX_ROWS) {
    rows = rows.slice(0, TABLE_MAX_ROWS)
    truncated = true
  }
  rows = rows.map((row) => {
    const clipped = row.slice(0, columns.length).map((c) => {
      if (c.length > TABLE_CELL_MAX) {
        truncated = true
        return `${c.slice(0, TABLE_CELL_MAX)}…`
      }
      return c
    })
    return clipped
  })
  return { table: { columns, rows }, truncated }
}
```
Then, in `toCodeRunResult`, after the image loop and before the error-code returns, append table cells:
```ts
  let tablesTruncated = false
  for (const raw of raw.tables ?? []) {
    const norm = normalizeTable(raw)
    if (!norm) continue
    const { table, truncated } = capTable(norm)
    if (truncated) tablesTruncated = true
    results.push({ type: "table", columns: table.columns, rows: table.rows })
  }
  if (tablesTruncated) {
    results.push({ type: "text", value: "⚠ A returned table was truncated to fit display limits." })
  }
```
(Keep the existing `upstreamError`/`timedOut`/`exitCode`/ok returns below — they already spread `results`.)

- [ ] **Step 4: Run → PASS; typecheck; commit**

```bash
bun test lib/server/code-sandbox/marshal.test.ts && bun run typecheck
git add lib/server/code-sandbox/marshal.ts lib/server/code-sandbox/marshal.test.ts
git commit -m "feat(code-sandbox): normalize + cap rich tables in the marshaller

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Client — read `/tmp/*.table.json`

**Files:** Modify `lib/server/code-sandbox/microsandbox-client.ts`

- [ ] **Step 1: Read + parse table files alongside charts**

In the `/tmp` read-back block (after the image loop, before `return toCodeRunResult({ stdout, stderr, exitCode, images, timedOut })` ~line 105), collect table JSON. Add a regex constant near `IMG_RE` (top of file):
```ts
const TABLE_RE = /\.table\.json$/i
```
Then collect (reuse the same `entries` listing — restructure so one `fs().list(IMG_DIR)` pass feeds both images and tables, OR a second best-effort pass):
```ts
        // Read back any table files the run wrote to /tmp.
        const tables: unknown[] = []
        try {
          const entries = await sb.fs().list(IMG_DIR)
          for (const entry of entries) {
            const path = entry.path.startsWith("/") ? entry.path : `${IMG_DIR}/${entry.path}`
            if (entry.kind !== "file" || !TABLE_RE.test(path)) continue
            const bytes = await sb.fs().read(path)
            try {
              tables.push(JSON.parse(Buffer.from(bytes).toString("utf8")))
            } catch {
              // skip a malformed table file
            }
          }
        } catch {
          // fs listing best-effort
        }
```
Pass `tables` in the success-path call:
```ts
        return toCodeRunResult({ stdout, stderr, exitCode, images, timedOut, tables })
```
(The early-return and catch-path `toCodeRunResult` calls don't set `tables` — fine, it's optional.)

> The `IMG_RE` chart regex is `/\.(png|svg)$/i`; a `.table.json` file won't match it, and `.table.json` is matched by `TABLE_RE` — no overlap. If you prefer, do both collections in a single `entries` loop to avoid listing `/tmp` twice.

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add lib/server/code-sandbox/microsandbox-client.ts
git commit -m "feat(code-sandbox): read /tmp/*.table.json table files from the sandbox

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Prompt — how to return a table

**Files:** Modify `lib/server/skills/code-interpreter.ts`

- [ ] **Step 1: Extend the PROMPT**

Add to the `PROMPT` array (after the `files`/mount line):
```ts
  "To return a table, write JSON to a /tmp/<name>.table.json file as",
  '`{"columns": [...], "rows": [[...], ...]}` — or with pandas',
  "`df.to_json('/tmp/out.table.json', orient='split')`. It renders as a grid.",
```

- [ ] **Step 2: Update the prompt test** (`code-interpreter.test.ts`)

The existing test asserts prompt content; add:
```ts
test("promptFragment documents the table file convention", () => {
  const p = codeInterpreterSkill.promptFragment(undefined) ?? ""
  expect(p).toContain(".table.json")
})
```

- [ ] **Step 3: Run test + typecheck + commit**

```bash
bun test lib/server/skills/code-interpreter.test.ts && bun run typecheck
git add lib/server/skills/code-interpreter.ts lib/server/skills/code-interpreter.test.ts
git commit -m "feat(skills): document the runCode table-file convention in the prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Render — table data-grid

**Files:** Modify `components/panels/code-result.tsx`

- [ ] **Step 1: Add a `table` branch**

In `code-result.tsx`, after the `texts` filter, also pull table cells and render a grid. Add inside the open `<div className="space-y-1 …">` block (after the `texts.map(...)`):
```tsx
          {part.results
            .filter(
              (r): r is { type: "table"; columns: string[]; rows: string[][] } =>
                r.type === "table",
            )
            .map((t, ti) => (
              <div key={`t-${ti}`} className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr>
                      {t.columns.map((c, ci) => (
                        <th
                          key={ci}
                          className="border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 text-left font-medium"
                          title={c}
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            className="max-w-[24ch] truncate border border-[var(--border)] px-1.5 py-0.5 align-top"
                            title={cell}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
```
> `CodeResultPart.results` is `CodeResultCell[]` and `CodeResultCell` already includes `{ type:"table"; columns; rows }` (reserved in PR-1) — the narrow above compiles. If TS complains the predicate type doesn't match the exact `CodeResultCell` table member, narrow with `r.type === "table"` and reference the existing type instead of an inline literal.

- [ ] **Step 2: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add components/panels/code-result.tsx
git commit -m "feat(ui): render code-interpreter table results as a data-grid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verification + PR

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → 0 errors (pre-existing warnings in `app/api/summarize/route.ts` + `services/agent-ts/*` unrelated).
- [ ] **Step 3:** `bun run test` → all pass (new marshal table tests + existing).
- [ ] **Step 4:** `bun run build` → succeeds.
- [ ] **Step 5:** `bun run audit:bundle` → no server-only paths/secrets in client chunks.
- [ ] **Step 6: Manual smoke** (needs the local microsandbox runtime): ask the model to compute a small DataFrame and return it as a table → a data-grid renders with the right columns/rows; an oversized table is clipped with the truncation note. A chart in the same run still appears in the gallery (no regression).
- [ ] **Step 7: Open the PR into `dev`.** Body: summary (runCode rich tables, file-based JSON, data-grid), spec + plan links, note that JS is split to a later PR, automated-test list, manual-smoke results. Push `feat/code-interpreter-tables`; commit trailer as above.

---

## Out of scope

JavaScript (separate later PR, pending a node-image spike); grid sort/export/pagination; table editing; mounting tables back to files. Charts continue via the PR-1 image path.

## Risks

- **Pandas `orient="split"` includes `index`** — `normalizeTable` takes `columns` + `data`, ignores `index` (tested).
- **Non-scalar cells** — JSON-encoded so the grid never shows `[object Object]` (tested).
- **Double `/tmp` listing** — charts + tables can share one `fs().list` pass; the plan lists twice for clarity but a single pass is fine (and cheaper).
- **`CodeResultCell` table member** — already in `@/shared/types` from PR-1; the render narrow relies on it.
