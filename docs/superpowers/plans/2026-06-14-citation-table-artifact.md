# Citation-table Artifact (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing-but-unrendered `'table'` ArtifactKind render a read-only, quote-cited grid (rows × columns, each cell value backed by `[N]` chips that open a Popover with the source + supporting quote).

**Architecture:** A pure shared module (`citation-table.ts`) owns the Zod schema + `parseCitationTable` + `sourceIndex` (the real logic + tests). A read-only renderer (`CitationTableView`) draws the grid + citation chips. The Artifacts-tab preview gains a `'table'` dispatch branch that parses content and renders the view (falling back to `<pre>` on invalid JSON).

**Tech Stack:** TypeScript, Zod, React 19, `bun:test`, the repo's `Popover` (`components/ui/popover.tsx`), lucide icons.

Design spec: `docs/superpowers/specs/2026-06-14-citation-table-artifact-design.md`.

> **Naming note:** the spec used `CitationTable` for both the TS *type* and the *component*. To avoid a collision, the **type** is `CitationTable` (from the shared module) and the **component** is `CitationTableView`.

---

### Task 1: Data model — schema, `parseCitationTable`, `sourceIndex`

**Files:**
- Create: `lib/shared/artifacts/citation-table.ts`
- Create: `lib/shared/artifacts/citation-table.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/shared/artifacts/citation-table.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/shared/artifacts/citation-table.test.ts`
Expected: FAIL — module/exports don't exist.

- [ ] **Step 3: Implement `citation-table.ts`**

Create `lib/shared/artifacts/citation-table.ts`:

```ts
import { z } from "zod"

export const CitationSchema = z.object({
  sourceId: z.string().min(1),
  quote: z.string().max(2000),
})

export const CellSchema = z.object({
  value: z.string().max(4000),
  /** Quote-cited support for this cell's value. May be empty (an
   *  un-cited cell is allowed; the renderer just shows no chip). */
  citations: z.array(CitationSchema).max(8).default([]),
})

export const CitationTableSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300),
  url: z.string().max(2000).optional(),
  snippet: z.string().max(1000).optional(),
})

export const CitationTableColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
})

export const CitationTableSchema = z.object({
  columns: z.array(CitationTableColumnSchema).min(1).max(12),
  /** One row = a map of columnId → cell. A column with no entry in a
   *  row renders as an empty cell. */
  rows: z.array(z.record(z.string(), CellSchema)).max(200),
  sources: z.array(CitationTableSourceSchema).max(100),
})

export type CitationTable = z.infer<typeof CitationTableSchema>
export type CitationTableCell = z.infer<typeof CellSchema>

/** Parse an artifact's `content` string into a CitationTable, or null
 *  when it isn't valid citation-table JSON (bad JSON or shape). The
 *  Artifacts-tab dispatch falls back to the plain `<pre>` view on null.
 *  Never throws. A citation whose `sourceId` isn't in `sources` is
 *  tolerated — the renderer resolves leniently. */
export function parseCitationTable(content: string): CitationTable | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const result = CitationTableSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** 1-based index of `sourceId` in `data.sources`, or null when absent.
 *  Used by the renderer to number citation chips. */
export function sourceIndex(data: CitationTable, sourceId: string): number | null {
  const i = data.sources.findIndex((s) => s.id === sourceId)
  return i === -1 ? null : i + 1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/shared/artifacts/citation-table.test.ts`
Expected: PASS (7 tests). Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/citation-table.ts lib/shared/artifacts/citation-table.test.ts
git commit -m "feat(artifacts): citation-table schema + parse + sourceIndex"
```

---

### Task 2: The renderer — `CitationTableView`

**Files:**
- Create: `components/panels/citation-table.tsx`

No component test (the repo has no `.test.tsx`; the logic lives in Task 1's pure module). Verified by `bun run typecheck && bun run lint`.

- [ ] **Step 1: Create the component**

Create `components/panels/citation-table.tsx`:

```tsx
"use client"
import "client-only"

/**
 * Read-only renderer for a citation-table artifact (Slice 1 of the
 * Elicit-style extraction tables). Draws a grid; each cell value is
 * followed by `[N]` chips (one per citation) that open a Popover with
 * the source title/url + the supporting quote. Self-contained from the
 * artifact's embedded `sources`. Editing / sorting / generation are
 * later slices.
 */

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  type CitationTable,
  type CitationTableCell,
  sourceIndex,
} from "@/shared/artifacts/citation-table"

function Cell({ data, cell }: { data: CitationTable; cell?: CitationTableCell }) {
  if (!cell) {
    return <span className="text-[var(--muted-foreground)]">—</span>
  }
  return (
    <span>
      {cell.value}
      {cell.citations.map((c, i) => {
        const idx = sourceIndex(data, c.sourceId)
        if (idx === null) return null
        const source = data.sources[idx - 1]
        return (
          <Popover key={i}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ml-0.5 align-super text-[10px] text-[var(--primary)] hover:underline"
                aria-label={`Source ${idx}: ${source.title}`}
              >
                [{idx}]
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80 text-xs">
              <div className="font-medium">
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {source.title}
                  </a>
                ) : (
                  source.title
                )}
              </div>
              <blockquote className="mt-1 border-l-2 border-[var(--border)] pl-2 text-[var(--muted-foreground)]">
                {c.quote}
              </blockquote>
            </PopoverContent>
          </Popover>
        )
      })}
    </span>
  )
}

export function CitationTableView({ data }: { data: CitationTable }) {
  return (
    <div className="overflow-x-auto p-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {data.columns.map((col) => (
              <th
                key={col.id}
                scope="col"
                className="border border-[var(--border)] bg-[var(--muted)] px-2 py-1 text-left font-medium"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              {data.columns.map((col) => (
                <td
                  key={col.id}
                  className="border border-[var(--border)] px-2 py-1 align-top"
                >
                  <Cell data={data} cell={row[col.id]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors). If lint flags the `key={i}` array-index keys, they're acceptable here (rows/citations are render-only with no reordering in Slice 1); if the rule is an error (not warning), switch to a stable composite key like `key={`${col.id}-${i}`}`.

- [ ] **Step 3: Commit**

```bash
git add components/panels/citation-table.tsx
git commit -m "feat(artifacts): CitationTableView renderer with quote-cited cells"
```

---

### Task 3: Wire the `'table'` kind into the Artifacts tab

**Files:**
- Modify: `components/panels/artifacts-tab.tsx`

- [ ] **Step 1: Add imports**

In `components/panels/artifacts-tab.tsx`: (a) add `Table` to the existing `lucide-react` import block (alongside `Code2`, `Braces`, etc.); (b) add two imports near the other `@/components` / `@/shared` imports:

```ts
import { CitationTableView } from "@/components/panels/citation-table"
import { parseCitationTable } from "@/shared/artifacts/citation-table"
```

- [ ] **Step 2: Add the kind icon**

Replace `artifactKindIcon`:

```tsx
function artifactKindIcon(artifact: Artifact) {
  if (artifact.kind === "code") return <Code2 size={12} />
  if (artifact.kind === "json") return <Braces size={12} />
  if (artifact.kind === "image") return <ImageIcon size={12} />
  if (artifact.kind === "table") return <Table size={12} />
  return <FileText size={12} />
}
```

- [ ] **Step 3: Add the `'table'` dispatch branch**

In the preview dialog's renderer ternary, insert a `'table'` branch before the final `<pre>` fallback (i.e. right after the `image` branch's closing `)`):

```tsx
          ) : artifact?.kind === "table" ? (
            (() => {
              const table = parseCitationTable(artifact.content)
              return table ? (
                <CitationTableView data={table} />
              ) : (
                <pre className="text-xs p-3 whitespace-pre-wrap break-words font-mono">
                  {artifact.content}
                </pre>
              )
            })()
          ) : (
```

(The existing final `) : (` … `<pre>…</pre>` … `)}` fallback stays — it now only catches `'other'`.)

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors).

- [ ] **Step 5: Commit**

```bash
git add components/panels/artifacts-tab.tsx
git commit -m "feat(artifacts): render table-kind artifacts as citation tables"
```

---

### Task 4: Full gate + PR

**Files:** none (verification only).

- [ ] **Step 1: TS gate**

Run: `bun run check`
Expected: typecheck + lint clean; `bun test` — confirm `bun test lib/shared/artifacts/citation-table.test.ts` passes and no NEW failures (the whole-suite `bun test` has pre-existing env failures: `app/api/tasks` needs live Postgres, `lib/server/.../minimax` needs network, `services/agent-ts` missing its `postgres` dep — unrelated).

- [ ] **Step 2: user-manual drift check**

Run: `bun run docs:user-manual:check`
Expected: up to date (no env vars / panels added — the citation table is a renderer for an existing artifact kind, not a new panel).

- [ ] **Step 3: Push + open the PR**

```bash
git push -u origin feat/citation-table-artifact
gh pr create --base dev --title "feat(artifacts): citation-table artifact renderer (slice 1)" --body "Implements docs/superpowers/specs/2026-06-14-citation-table-artifact-design.md (slice 1 of the Elicit-style extraction tables)."
```

(Per the repo's PR rules, auto-subscribe if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **Slice 1 ships no creation trigger** — it's verified by Task 1's pure tests + the dispatch wiring; any `kind:'table'` artifact whose `content` is valid citation-table JSON now renders. Slice 2 adds the "Extract to table" action that generates these from a research message; Slice 3 adds Plate-embed + editing + sorting.
- **`CitationTableView`** (component) vs **`CitationTable`** (type) — distinct names on purpose; don't merge them.
- **Self-contained:** the renderer reads everything (incl. sources) from `data`; no message/`toolCalls` dependency, so a standalone artifact renders correctly.
- **No new deps / migration:** `'table'` ArtifactKind, artifact persistence/sync, and `Popover` all already exist.
