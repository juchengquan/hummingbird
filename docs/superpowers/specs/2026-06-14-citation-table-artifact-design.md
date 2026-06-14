# Citation-table artifact — Slice 1 (data model + renderer) — Design

Status: **approved design — ready for implementation plan.**
Origin: `docs/PLAN-cross-product-inspirations.md` §9 ("Elicit-style structured extraction tables"). This is **sub-project 1 of 3**:
1. **(this spec)** the citation-table artifact data model + renderer.
2. generation-from-research (an "Extract to table" action via `generateStructured`).
3. Plate-embed + in-cell editing + column sorting.

## Why

Deep Research output is prose. The killer artifact is a **sortable, quote-cited grid** (rows = items, columns = attributes, each cell backed by the exact supporting quote from a source). Slice 1 makes the data model real and renders it: the `'table'` `ArtifactKind` already exists in the union (`lib/shared/types.ts`) but is unrendered — a `kind:'table'` artifact currently falls through to a plain `<pre>`. Slice 1 makes a `'table'` artifact whose `content` is a valid citation-table JSON render as a grid with quote-cited cells. Generation (how such an artifact gets created) is Slice 2.

## Scope

- **In:** the data model (Zod schema + a pure `parseCitationTable`), a read-only renderer, and wiring it into the Artifacts-tab preview.
- **Out (later slices):** any creation/generation trigger (Slice 2), in-cell editing, column sorting, Plate-document embedding, "send to editor as markdown" (Slice 3). Read-only, self-contained.
- No migration, no new dependency — the `'table'` kind + artifact persistence (Supabase + localStorage sync) + `radix Popover` (`components/ui/popover.tsx`) all already exist.

## Data model — `lib/shared/artifacts/citation-table.ts` (new, pure)

The artifact's `content` string holds JSON of this shape. Sources are **embedded** so the table is self-contained (a standalone artifact is decoupled from the message it was generated from, so it can't rely on `Message.toolCalls`).

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
 *  Artifacts-tab dispatch falls back to the plain `<pre>` view on null,
 *  so a non-citation `'table'` artifact still shows. Never throws. A
 *  citation whose `sourceId` isn't in `sources` is tolerated here — the
 *  renderer resolves leniently. */
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
```

Validation is lenient on dangling `sourceId`s (the renderer handles them) but strict on the structural shape — consistent with the generative-UI `parsePersistedUiPart` "parse-or-null, never throw" precedent.

## Renderer — `components/panels/citation-table.tsx` (new, client)

`"use client"` + `import "client-only"`. Props: `{ data: CitationTable }`.

- Renders a `<table>` (reuse the column-layout styling from `components/chat/generative-ui/info-table.tsx`): a header row from `columns` (label), then one `<tr>` per `rows[]`. Each cell renders `cell.value` followed by small superscript chips — one per `cell.citations[]`, labelled `[N]` where N is the cited source's 1-based index in `data.sources` (resolve `citation.sourceId` → index; a citation whose source isn't found renders no chip).
- A chip is a `Popover` trigger; the `PopoverContent` shows the source **title** (a link to `source.url` when present, `target=_blank rel=noreferrer`) and the **quote** rendered as a blockquote. Self-contained from `data.sources`.
- Read-only — no inputs, no sort handlers, no edit affordances (those are later slices).
- The per-chip popover is the sole citation interaction (no separate sources legend in Slice 1 — YAGNI; the popover carries title/url/quote).

Chip numbering uses a pure helper **`sourceIndex(data: CitationTable, sourceId: string): number | null`** (1-based index of the source in `data.sources`, or `null` if not found). It lives in the **shared module** (`citation-table.ts`) so it's pure and unit-tested.

## Wiring — `components/panels/artifacts-tab.tsx`

In the preview dispatch ternary (the `artifact?.kind === "code" ? … : …` chain ending in the `<pre>` fallback), add a `'table'` branch before the final `<pre>`:

```tsx
) : artifact?.kind === "table" ? (
  (() => {
    const table = parseCitationTable(artifact.content)
    return table ? (
      <CitationTable data={table} />
    ) : (
      <pre className="text-xs p-3 whitespace-pre-wrap break-words font-mono">
        {artifact.content}
      </pre>
    )
  })()
) : (
```

Also add a table icon to `artifactKindIcon` for `kind === "table"` (e.g. a `Table` lucide icon, matching the existing icon style).

## Error handling

- Malformed `content` → `parseCitationTable` returns `null` → the `<pre>` fallback shows the raw content (no crash, no blank).
- A citation `sourceId` not present in `sources` → chip is omitted for that citation (the value still renders).
- Empty `citations` on a cell → the value renders with no chips (allowed).

## Testing

- **`lib/shared/artifacts/citation-table.test.ts`** (`bun:test`, pure): a valid table round-trips through `parseCitationTable`; malformed JSON → `null`; missing required field (e.g. no `columns`) → `null`; `citations` defaults to `[]` when omitted; a cell value with a dangling `sourceId` still parses (lenient); the `sourceIndex` helper returns the right 1-based index and `null` for unknown ids.
- **Renderer:** verified by `bun run typecheck && bun run lint` (the repo has no `.test.tsx` for components — same convention as the generative-UI cards; the data-shaping logic that matters is the pure schema/helper, fully covered above).

## Touch-point summary

| File | Change |
|---|---|
| `lib/shared/artifacts/citation-table.ts` | **new** — Zod schema + `parseCitationTable` + `sourceIndex` |
| `lib/shared/artifacts/citation-table.test.ts` | **new** — pure tests |
| `components/panels/citation-table.tsx` | **new** — the renderer (table + citation chips + popover) |
| `components/panels/artifacts-tab.tsx` | `'table'` dispatch branch + kind icon |

## Scope estimate

S–M. One pure shared module + tests, one renderer, a dispatch branch + an icon. The `'table'` kind, artifact persistence/sync, and `Popover` all pre-exist. Slice 1 is independently shippable (it makes the half-built `'table'` kind render); Slice 2 adds the generation trigger that creates these artifacts from research output.
