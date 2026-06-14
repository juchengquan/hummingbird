# "Extract to table" action — citation-table Slice 2 — Design

Status: **approved design — ready for implementation plan.**
Origin: sub-project 2 of 3 of the Elicit-style extraction tables (`docs/PLAN-cross-product-inspirations.md` §9). Slice 1 (the citation-table artifact data model + renderer) shipped in PR #212; this slice adds the generation action that creates those artifacts from a Deep Research message.

## Why

Slice 1 can render a quote-cited grid but nothing creates one. Slice 2 is where the value lands: one click on a research message turns its prose report into a structured, quote-cited table artifact.

## Scope

- **In:** an "Extract to table" action on a research assistant message; a `/api/extract-table` route that runs structured extraction; the model↔storage citation mapping; the client wiring to create a `kind:'table'` artifact.
- **Out (Slice 3 / later):** a column hint/picker (v1 is one-click, model-proposed columns), in-cell editing, column sorting, "regenerate", choosing which sources to include, Plate-embed.

## Flow

1. User clicks **Extract to table** on an assistant message that has web-search sources.
2. Client POSTs `{ reportText: message.content, sources: webSearchResults }` to `/api/extract-table`.
3. Route numbers the sources, prompts the model to extract a 3–6 column grid (one row per entity, each cell value backed by citations referencing a **source number** + the exact supporting quote), via `generateStructured`.
4. Route maps source numbers → stable `sourceId`s, embeds the sources, returns a storage `CitationTable`.
5. Client `createArtifact({ kind:'table', content: JSON.stringify(table) })` → it appears in the Artifacts tab, rendered by Slice 1's `CitationTableView`.

## The model↔storage split (citation safety)

The model must never invent source ids. The route assigns ids (`s1…sN`) to the incoming sources and passes them **numbered** to the model; the model cites by 1-based **number**. Two shapes:

### Extraction schema (model-facing) — `lib/shared/artifacts/extract-table.ts` (new, pure)

```ts
import { z } from "zod"

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
 *  prompt supplies them); cells cite by source NUMBER. The route converts
 *  this to the storage `CitationTable` via `extractionToCitationTable`. */
export const ExtractionSchema = z.object({
  columns: z.array(ExtractionColumnSchema).min(1).max(12),
  rows: z.array(ExtractionRowSchema).max(200),
})
export type Extraction = z.infer<typeof ExtractionSchema>
```

The storage `CitationTable` keeps its `rows: Record<colId, Cell>[]` shape (it's only stored as JSON in the artifact, never sent to a model) — the transform bridges the two.

### The transform (pure, tested) — same module

```ts
import type { CitationTable } from "./citation-table"

/** Build the storage CitationTable from the model's extraction + the
 *  numbered sources (with stable ids). Maps each citation's 1-based
 *  `source` number → `sources[source-1].id`; a number out of range drops
 *  that citation (never throws). Embeds `sources` so the artifact is
 *  self-contained. Columns/rows pass through (cells become
 *  { value, citations:[{ sourceId, quote }] }). */
export function extractionToCitationTable(
  extraction: Extraction,
  sources: { id: string; title: string; url?: string; snippet?: string }[],
): CitationTable {
  const colIds = new Set(extraction.columns.map((c) => c.id))
  const rows = extraction.rows.map((row) => {
    const out: CitationTable["rows"][number] = {}
    for (const cell of row.cells) {
      // Ignore a cell tagged with a column the model didn't declare.
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
```

The route assigns ids before both the prompt and the transform:
```ts
const numberedSources = sources.map((s, i) => ({ id: `s${i + 1}`, ...s }))
```
so source number `N` (what the model cites) ↔ `numberedSources[N-1].id`.

## Route — `app/api/extract-table/route.ts` (new)

Mirrors `app/api/summarize/route.ts` (structured-first + lenient-JSON fallback + error mapping):
- Validate the body (Zod, below).
- `numberedSources` as above.
- `prompt = buildExtractTablePrompt(reportText, numberedSources)` — a pure server helper: presents the report text, then a numbered sources list (`[1] Title — url\n    snippet`, …), and instructs the model to extract the key **comparable attributes** as 3–6 columns, one row per entity/item the report compares, each cell value supported by `citations` referencing the **source number** + the exact supporting quote; cite only what the report/sources support; leave a cell's citations empty if unsupported.
- If `modelSupportsStructuredOutput(modelId)`: `generateStructured({ modelId, schema: ExtractionSchema, prompt, maxOutputTokens: 4000, temperature: 0.2 })`; on non-`ProviderUnavailableError` failure fall through.
- Lenient fallback: `generateText` → strip JSON fences → `ExtractionSchema.safeParse`; on failure → 502.
- `extractionToCitationTable(extraction, numberedSources)` → return as JSON (validated shape = `CitationTableSchema`).
- Errors: `ProviderUnavailableError` → 401; bad body → 400; bad model output → 502 (mirror summarize's `categorizeError`).
- `DEFAULT_EXTRACT_TABLE_MODEL = "google/gemini-2.5-flash"` (structured-output capable, long context, cheap).

## Contract — `lib/shared/api-schemas.ts` + `lib/client/api-client.ts`

```ts
// api-schemas.ts
export const ExtractTableRequestSchema = z.object({
  reportText: z.string().min(1).max(100_000),
  sources: z
    .array(z.object({
      title: z.string().max(300),
      url: z.string().max(2000),
      snippet: z.string().max(2000),
    }))
    .min(1)
    .max(100),
  model: z.string().max(100).optional(),
})
export type ExtractTableRequestInput = z.infer<typeof ExtractTableRequestSchema>
// Response = CitationTableSchema (imported from the artifacts module).
```

- `apiUrls.extractTable = () => url("/api/extract-table")`.
- `apiClient.extractTable(body: ExtractTableRequestInput, options?) : Promise<CitationTable | null>` — mirror `summarizePost`: fetch, `CitationTableSchema.parse(await res.json())`, `null` on any error (network / non-OK / parse).

## Trigger — `components/panels/chat-message.tsx`

- An "Extract to table" icon button (lucide `Table2` or `Sheet`) in the assistant action row, rendered **only when `webSearchResults` is non-null** (the existing computed value at ~line 114 — the message has web-search sources to cite).
- Handler: set a local `extracting` state (spinner + disabled), call `apiClient.extractTable({ reportText: message.content, sources: webSearchResults.map(r => ({ title:r.title, url:r.url, snippet:r.snippet })) })`. On a non-null result: `createArtifact({ conversationId: activeConversationId, messageId: message.id, kind:'table', title:'Extracted table', content: JSON.stringify(table) })` + `toast.success("Saved table to Artifacts")`. On null: `toast.error("Couldn't extract a table")`. Always clear `extracting`.
- Guard on `activeConversationId` (like the existing `saveWholeAsMarkdown`).

## Error handling

- No `webSearchResults` → button not shown (nothing to cite).
- Extraction fails / model returns junk → route returns an error status → `apiClient.extractTable` returns `null` → toast error, no artifact created.
- A citation referencing an out-of-range source number → dropped by `extractionToCitationTable` (cell value still kept).
- The returned `CitationTable` is validated client-side by `CitationTableSchema.parse` in the api-client; a malformed response → `null` → toast error.

## Testing

- **Pure** (`lib/shared/artifacts/extract-table.test.ts`, `bun:test`): `extractionToCitationTable` — a row's `cells[]` become a `Record<colId, Cell>`; number→sourceId mapping; an out-of-range `source` citation is dropped (cell value kept); a cell tagged with a `columnId` not in `columns` is ignored; `sources` embedded; columns pass through; an empty-citations cell stays empty. `ExtractionSchema` accepts a valid extraction and rejects a malformed one (e.g. `source` as a string, or a row without `cells`). The prompt builder (`buildExtractTablePrompt`) is a pure string — one smoke test that the output contains the numbered sources (`[1] …`, `[2] …`) and the report text.
- **Route + client + button:** `bun run typecheck && bun run lint` (no route test harness; the extraction→storage logic — the only real logic — is fully covered by the pure tests).

## Touch-point summary

| File | Change |
|---|---|
| `lib/shared/artifacts/extract-table.ts` | **new** — `ExtractionSchema` + `extractionToCitationTable` + `buildExtractTablePrompt` |
| `lib/shared/artifacts/extract-table.test.ts` | **new** — pure tests |
| `app/api/extract-table/route.ts` | **new** — the route (structured + fallback, like summarize) |
| `lib/shared/api-schemas.ts` | `ExtractTableRequestSchema` + type |
| `lib/client/api-client.ts` | `apiUrls.extractTable` + `apiClient.extractTable` |
| `components/panels/chat-message.tsx` | the action button + handler |

## Scope

**M.** The pure transform + schema + prompt builder (with tests) carry the logic; the route mirrors the existing summarize structured-output pattern; the rest is the contract + one button. Reuses Slice 1's `CitationTable`/`CitationTableSchema` and the existing `generateStructured` + `createArtifact` infrastructure. No new deps, no migration.
