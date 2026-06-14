# "Extract to table" (Citation-table Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-click "Extract to table" action on a Deep Research message that uses structured extraction to produce a quote-cited `kind:'table'` artifact (rendered by Slice 1).

**Architecture:** A pure module owns the model-facing `ExtractionSchema`, the prompt builder, and `extractionToCitationTable` (number→sourceId mapping) — the real logic + tests. A `/api/extract-table` route runs `generateStructured` (mirroring the summarize route's structured+fallback pattern) and returns a storage `CitationTable`. The chat-message action button calls it via `apiClient.extractTable` and saves the result with `createArtifact`.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK (`generateStructured`), React 19, `bun:test`.

Design spec: `docs/superpowers/specs/2026-06-14-extract-to-table-design.md`. Reuses Slice 1: `lib/shared/artifacts/citation-table.ts` (`CitationTable`, `CitationTableSchema`).

---

### Task 1: Pure extraction module — schema, transform, prompt

**Files:**
- Create: `lib/shared/artifacts/extract-table.ts`
- Create: `lib/shared/artifacts/extract-table.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/shared/artifacts/extract-table.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import {
  ExtractionSchema,
  buildExtractTablePrompt,
  extractionToCitationTable,
} from "./extract-table"

const sources = [
  { id: "s1", title: "Trial A", url: "https://a.test", snippet: "snip a" },
  { id: "s2", title: "Trial B" },
]

const extraction = {
  columns: [
    { id: "drug", label: "Drug" },
    { id: "n", label: "Sample size" },
  ],
  rows: [
    {
      cells: [
        { columnId: "drug", value: "Aspirin", citations: [{ source: 1, quote: "Aspirin used" }] },
        { columnId: "n", value: "200", citations: [] },
      ],
    },
  ],
}

describe("ExtractionSchema", () => {
  test("accepts a valid extraction", () => {
    expect(ExtractionSchema.safeParse(extraction).success).toBe(true)
  })
  test("rejects a non-integer source", () => {
    const bad = {
      columns: [{ id: "c", label: "C" }],
      rows: [{ cells: [{ columnId: "c", value: "x", citations: [{ source: "1", quote: "q" }] }] }],
    }
    expect(ExtractionSchema.safeParse(bad).success).toBe(false)
  })
  test("rejects a row without cells", () => {
    expect(
      ExtractionSchema.safeParse({ columns: [{ id: "c", label: "C" }], rows: [{}] }).success,
    ).toBe(false)
  })
})

describe("extractionToCitationTable", () => {
  test("maps cells → record and source numbers → sourceIds", () => {
    const out = extractionToCitationTable(ExtractionSchema.parse(extraction), sources)
    expect(out.columns.length).toBe(2)
    expect(out.rows[0].drug.value).toBe("Aspirin")
    expect(out.rows[0].drug.citations).toEqual([{ sourceId: "s1", quote: "Aspirin used" }])
    expect(out.rows[0].n.citations).toEqual([])
    expect(out.sources).toBe(sources)
  })
  test("drops a citation whose source number is out of range", () => {
    const ex = ExtractionSchema.parse({
      columns: [{ id: "c", label: "C" }],
      rows: [{ cells: [{ columnId: "c", value: "x", citations: [{ source: 9, quote: "q" }] }] }],
    })
    expect(extractionToCitationTable(ex, sources).rows[0].c.citations).toEqual([])
  })
  test("ignores a cell tagged with an undeclared column", () => {
    const ex = ExtractionSchema.parse({
      columns: [{ id: "c", label: "C" }],
      rows: [{ cells: [{ columnId: "ghost", value: "x", citations: [] }] }],
    })
    expect(extractionToCitationTable(ex, sources).rows[0]).toEqual({})
  })
})

describe("buildExtractTablePrompt", () => {
  test("includes numbered sources and the report text", () => {
    const p = buildExtractTablePrompt("THE REPORT BODY", sources)
    expect(p).toContain("THE REPORT BODY")
    expect(p).toContain("[1] Trial A")
    expect(p).toContain("[2] Trial B")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/shared/artifacts/extract-table.test.ts`
Expected: FAIL — module/exports don't exist.

- [ ] **Step 3: Implement `extract-table.ts`**

Create `lib/shared/artifacts/extract-table.ts`:

```ts
import { z } from "zod"

import type { CitationTable } from "./citation-table"

export const ExtractionCitationSchema = z.object({
  /** 1-based index into the sources list the prompt presented. */
  source: z.number().int().min(1),
  quote: z.string().max(2000),
})

export const ExtractionCellSchema = z.object({
  /** Which column this cell fills — must match a `columns[].id`. */
  columnId: z.string().min(1).max(60),
  value: z.string().max(4000),
  citations: z.array(ExtractionCitationSchema).max(8).default([]),
})

export const ExtractionColumnSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
})

export const ExtractionRowSchema = z.object({
  cells: z.array(ExtractionCellSchema).max(12),
})

/** What the model fills in. Rows are a CLOSED array of column-tagged cells
 *  (NOT an open `Record<colId, …>` — JSON-Schema `additionalProperties`
 *  isn't reliable under strict structured output). No `sources` (the
 *  prompt supplies them); cells cite by source NUMBER. */
export const ExtractionSchema = z.object({
  columns: z.array(ExtractionColumnSchema).min(1).max(12),
  rows: z.array(ExtractionRowSchema).max(200),
})
export type Extraction = z.infer<typeof ExtractionSchema>

type NumberedSource = { id: string; title: string; url?: string; snippet?: string }

/** Build the storage CitationTable from the model's extraction + the
 *  numbered sources (with stable ids). Maps each citation's 1-based
 *  `source` → `sources[source-1].id`; an out-of-range number drops that
 *  citation. Ignores a cell tagged with an undeclared column. Embeds
 *  `sources` so the artifact is self-contained. Never throws. */
export function extractionToCitationTable(
  extraction: Extraction,
  sources: NumberedSource[],
): CitationTable {
  const colIds = new Set(extraction.columns.map((c) => c.id))
  const rows = extraction.rows.map((row) => {
    const out: CitationTable["rows"][number] = {}
    for (const cell of row.cells) {
      if (!colIds.has(cell.columnId)) continue
      const citations = cell.citations
        .filter((c) => c.source >= 1 && c.source <= sources.length)
        .map((c) => ({ sourceId: sources[c.source - 1].id, quote: c.quote }))
      out[cell.columnId] = { value: cell.value, citations }
    }
    return out
  })
  return { columns: extraction.columns, rows, sources }
}

/** Pure prompt: the report body + a numbered sources list + extraction
 *  instructions. The model cites cells by the source NUMBER shown here. */
export function buildExtractTablePrompt(
  reportText: string,
  sources: NumberedSource[],
): string {
  const sourceLines = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}${s.url ? ` — ${s.url}` : ""}${s.snippet ? `\n    ${s.snippet}` : ""}`,
    )
    .join("\n")
  return [
    "You extract a structured comparison table from a research report.",
    "",
    "REPORT:",
    reportText,
    "",
    "SOURCES (cite by number):",
    sourceLines,
    "",
    "Build a table capturing the key comparable attributes across the entities the report discusses:",
    "- Choose 3–6 columns (the comparable attributes). Each column has a short slug `id` and a human `label`.",
    "- One row per entity/item the report compares. Each row is a list of `cells`; each cell has the column's `columnId`, the extracted `value`, and `citations`.",
    "- Back each value with `citations` referencing the SOURCE NUMBER above plus the exact supporting quote. Only cite what the report/sources actually state; leave `citations` empty when a value isn't directly supported.",
    "- Keep values concise.",
  ].join("\n")
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/shared/artifacts/extract-table.test.ts`
Expected: PASS. Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/shared/artifacts/extract-table.ts lib/shared/artifacts/extract-table.test.ts
git commit -m "feat(artifacts): extraction schema + transform + prompt for extract-to-table"
```

---

### Task 2: The `/api/extract-table` route

**Files:**
- Create: `app/api/extract-table/route.ts`

No route test (no harness; the extraction logic is covered by Task 1). Verified by `bun run typecheck && bun run lint`.

- [ ] **Step 1: Create the route** (mirrors `app/api/summarize/route.ts`'s structured+fallback+error shape)

Create `app/api/extract-table/route.ts`:

```ts
import type { NextRequest } from "next/server"

import { generateText } from "ai"
import { NextResponse } from "next/server"

import { categorizeError } from "@/shared/api-errors"
import {
  ExtractionSchema,
  buildExtractTablePrompt,
  extractionToCitationTable,
} from "@/shared/artifacts/extract-table"
import { ExtractTableRequestSchema } from "@/shared/api-schemas"
import { modelSupportsStructuredOutput } from "@/shared/models"
import { generateStructured } from "@/server/ai/structured"
import { ProviderUnavailableError, selectModel } from "@/server/model-provider"

export const runtime = "nodejs"

const DEFAULT_EXTRACT_TABLE_MODEL = "google/gemini-2.5-flash"

function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim()
}

export async function POST(req: NextRequest) {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json(
      { code: "invalid_request", message: "Body must be JSON." },
      { status: 400 },
    )
  }
  const parsed = ExtractTableRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        code: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body.",
      },
      { status: 400 },
    )
  }

  const { reportText, sources, model } = parsed.data
  const modelId = model ?? DEFAULT_EXTRACT_TABLE_MODEL
  // Stable ids; source number N (what the model cites) ↔ numbered[N-1].id.
  const numbered = sources.map((s, i) => ({ id: `s${i + 1}`, ...s }))
  const prompt = buildExtractTablePrompt(reportText, numbered)

  try {
    let extraction: import("@/shared/artifacts/extract-table").Extraction | null = null

    if (modelSupportsStructuredOutput(modelId)) {
      try {
        extraction = await generateStructured({
          modelId,
          schema: ExtractionSchema,
          prompt,
          abortSignal: req.signal,
          maxOutputTokens: 4000,
          temperature: 0.2,
        })
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error
        // fall through to the lenient text path
      }
    }

    if (!extraction) {
      const result = await generateText({
        abortSignal: req.signal,
        model: selectModel(modelId),
        prompt: `${prompt}\n\nReturn ONLY JSON matching the schema.`,
        maxOutputTokens: 4000,
        temperature: 0.2,
      })
      const cleaned = stripJsonFences(result.text)
      let json: unknown
      try {
        json = JSON.parse(cleaned)
      } catch {
        return NextResponse.json(
          { code: "provider", message: "Extraction model did not return valid JSON." },
          { status: 502 },
        )
      }
      const reparsed = ExtractionSchema.safeParse(json)
      if (!reparsed.success) {
        return NextResponse.json(
          { code: "provider", message: "Extraction model output did not match the schema." },
          { status: 502 },
        )
      }
      extraction = reparsed.data
    }

    const table = extractionToCitationTable(extraction, numbered)
    return NextResponse.json(table)
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return NextResponse.json({ code: "auth", message: error.message }, { status: 401 })
    }
    const { status, code, message } = categorizeError(error)
    return NextResponse.json({ code, message }, { status })
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. (`ExtractTableRequestSchema` lands in Task 3 — if typecheck errors on that import, do Task 3 first; the tasks are otherwise independent. If executing in order, expect a missing-export error here until Task 3; in that case implement Task 3's schema, then return. To keep tasks runnable in order, **do Task 3 before this Step 2's typecheck** — see note at the bottom.)

- [ ] **Step 3: Commit**

```bash
git add app/api/extract-table/route.ts
git commit -m "feat(api): /api/extract-table route (structured extraction → CitationTable)"
```

---

### Task 3: API contract — schema + client method

**Files:**
- Modify: `lib/shared/api-schemas.ts`
- Modify: `lib/client/api-client.ts`

- [ ] **Step 1: Add the request schema**

In `lib/shared/api-schemas.ts`, add (near the other request schemas; `z` is already imported):

```ts
export const ExtractTableRequestSchema = z.object({
  reportText: z.string().min(1).max(100_000),
  sources: z
    .array(
      z.object({
        title: z.string().max(300),
        url: z.string().max(2000),
        snippet: z.string().max(2000),
      }),
    )
    .min(1)
    .max(100),
  model: z.string().max(100).optional(),
})
export type ExtractTableRequestInput = z.infer<typeof ExtractTableRequestSchema>
```

- [ ] **Step 2: Add the URL + client method**

In `lib/client/api-client.ts`:
(a) add to `apiUrls`: `extractTable: () => url("/api/extract-table"),`.
(b) add the method (mirror `summarizePost` — fetch, parse with `CitationTableSchema`, null on error). Add the imports `import { CitationTableSchema, type CitationTable } from "@/shared/artifacts/citation-table"` and `import { type ExtractTableRequestInput } from "@/shared/api-schemas"` (or extend existing imports from those modules), then:

```ts
async function extractTable(
  body: ExtractTableRequestInput,
  options?: { signal?: AbortSignal } & DispatchOption,
): Promise<CitationTable | null> {
  try {
    const remote = await resolveDispatch(options)
    const target = remote ? `${remote.baseUrl}/v1/extract-table` : apiUrls.extractTable()
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (remote) headers.Authorization = `Bearer ${remote.authToken}`
    const res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) return null
    return CitationTableSchema.parse(await res.json())
  } catch {
    return null
  }
}
```

(c) Register it on the exported `apiClient` object. Find where `apiClient` is assembled (e.g. a `summarize: { ... }` or flat methods object) and add `extractTable` following the existing shape — if methods are grouped, place it at the top level as `extractTable`; mirror exactly how `summarize`/`mcp` are exposed. Read the `export const apiClient = { … }` block and match its structure.

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (this also resolves Task 2's import). If the remote dispatch path (`/v1/extract-table`) isn't wired in any remote backend, that's fine — the in-Next path (`apiUrls.extractTable()`) is what runs; remote is best-effort and falls back.

- [ ] **Step 4: Commit**

```bash
git add lib/shared/api-schemas.ts lib/client/api-client.ts
git commit -m "feat(api): extract-table request schema + apiClient.extractTable"
```

---

### Task 4: The "Extract to table" button

**Files:**
- Modify: `components/panels/chat-message.tsx`

- [ ] **Step 1: Add imports + state**

In `components/panels/chat-message.tsx`:
(a) add `Sheet` to the `lucide-react` import (the row `import { Copy, Pencil, RotateCcw, Check, X, Bookmark, Archive, Send, GitBranch } from "lucide-react"`).
(b) add `import { apiClient } from "@/client/api-client"` (near the other `@/client` imports).
(c) inside the component, add an extracting state near the other `useState`s: `const [extracting, setExtracting] = useState(false)`.

- [ ] **Step 2: Add the handler**

Add near the existing `saveWholeAsMarkdown` handler (which reads `activeConversationId` + `createArtifact`):

```tsx
  const handleExtractTable = async () => {
    if (!activeConversationId || !webSearchResults || extracting) return
    setExtracting(true)
    try {
      const table = await apiClient.extractTable({
        reportText: message.content,
        sources: webSearchResults.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        })),
      })
      if (!table) {
        toast.error("Couldn't extract a table")
        return
      }
      createArtifact({
        conversationId: activeConversationId,
        messageId: message.id,
        kind: "table",
        title: "Extracted table",
        content: JSON.stringify(table),
      })
      toast.success("Saved table to Artifacts")
    } finally {
      setExtracting(false)
    }
  }
```

- [ ] **Step 3: Add the button**

In the assistant action row (next to the "Save as artifact" `Archive` button), render — **only when `webSearchResults` is present** — a button mirroring the existing pattern:

```tsx
                  {webSearchResults && webSearchResults.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleExtractTable}
                          disabled={extracting}
                          className={actionBtnClass}
                          aria-label="Extract to table"
                        >
                          <Sheet size={14} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {extracting ? "Extracting…" : "Extract to table"}
                      </TooltipContent>
                    </Tooltip>
                  )}
```

Place it inside the same assistant-actions block that holds the `Archive`/`Save as artifact` button (the `{!isUser && ( … )}` cluster). Read the surrounding JSX to position it cleanly next to the Archive button.

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. `webSearchResults` is the existing computed value (a `ToolCallResult[] | null`); `r.title/url/snippet` are its fields.

- [ ] **Step 5: Commit**

```bash
git add components/panels/chat-message.tsx
git commit -m "feat(chat): Extract to table action on research messages"
```

---

### Task 5: Full gate + PR

**Files:** none (verification only).

- [ ] **Step 1: TS gate**

Run: `bun run check`
Expected: typecheck + lint clean; `bun test` — confirm `bun test lib/shared/artifacts/extract-table.test.ts` passes and no NEW failures (pre-existing env failures in `app/api/tasks` / `minimax` / `services/agent-ts` are unrelated).

- [ ] **Step 2: user-manual drift check**

Run: `bun run docs:user-manual:check`
Expected: up to date. If it flags drift (a new route/panel can register), run `bun run docs:user-manual:build` and commit the regenerated `docs/user-manual/.feature-inventory.json` + `index.md`.

- [ ] **Step 3: Push + open the PR**

```bash
git push -u origin feat/extract-to-table
gh pr create --base dev --title "feat: Extract to table action (citation-table slice 2)" --body "Implements docs/superpowers/specs/2026-06-14-extract-to-table-design.md (slice 2 of the Elicit-style extraction tables)."
```

(Per the repo's PR rules, auto-subscribe if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **Task ordering for typecheck:** Task 2's route imports `ExtractTableRequestSchema` (defined in Task 3). If executing strictly in order, the route file's typecheck won't pass until Task 3 lands. Two clean options: (a) do Task 3 before running Task 2's Step-2 typecheck, or (b) commit Task 2's file and run the combined typecheck after Task 3. The per-task commits are still independent; just defer the green-typecheck assertion for Task 2 until Task 3's schema exists.
- **The real logic is Task 1** (pure, fully tested): the number→sourceId mapping, the closed-array row shape (structured-output-safe), and the prompt. Tasks 2–4 are the route + contract + button, verified by typecheck/lint.
- **Reuses Slice 1** entirely for storage + rendering — no change to `citation-table.ts` or the renderer.
- **Self-contained artifact:** the route embeds `numbered` sources into the returned table, so the saved artifact renders without its source message.
