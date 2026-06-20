# Multimodal docs PR-2 — table-aware chunking design

Status: **approved design**, ready for implementation plan.
Date: 2026-06-20. Parent plan:
[`docs/PLAN-multimodal-docs.md`](../../PLAN-multimodal-docs.md) (this is
the re-scoped PR-2 of that series).

## Background — why PR-2 shrank

PR-1 (#252) made the vision extraction pass merge GitHub-flavoured
markdown (tables → markdown tables, figures → captions) into
`ExtractionResult.text` / `fullText`. That text already flows into the
retrieval index (`searchFiles`: FTS over `files.full_text_tsv` + vector
chunks of `file_sections.content`) and into chat.

The originally-planned PR-2 (structured `blocks[]` + a `block_kind`
column + table rendering in the file preview) turned out to add little:

- **No UI surface displays the extraction output.** PDFs preview via the
  real PDF viewer (`components/pdf-viewer/`) — the user already sees the
  real tables; the text viewer decodes the raw blob, not the extraction
  result. So "render tables in preview" is redundant.
- **Retrieval already indexes the markdown text**, so structured blocks
  add marginal value for a large schema/wire/store cost.

The one genuine, non-redundant retrieval improvement left is **how an
oversized table is chunked for the index**.

## Problem

`lib/server/embeddings/chunk.ts` `chunkText()` splits on blank-line
paragraph boundaries. A GFM markdown table is a single blank-line-free
block, so a table that fits in `maxChars` (default 1500) already stays
intact. But a table **larger** than `maxChars` falls into `splitLong()`,
which hard-splits at arbitrary character offsets — mid-row, mid-cell —
and **only the first piece keeps the header row**. A retrieval hit on a
later row returns a headerless, broken-row fragment: poor context for
both FTS snippets and the model.

## Goal

When `chunkText` must split an oversized markdown table, split it at
**row boundaries with the header repeated** on each piece, so every
chunk is a valid, self-describing table fragment. Everything else is
unchanged.

## Design

All changes are in `lib/server/embeddings/chunk.ts` (pure, no I/O) +
its test. No migration, wire, store, or UI change. `indexFileSections`
consumes the improved `chunkText` automatically.

### New pure helpers

```ts
/** True when `block` is a GFM pipe table: ≥2 lines, most lines are
 *  `| ... |` rows, and line 2 is a separator (only |, -, :, spaces;
 *  at least one -). Strict enough that prose containing pipes is not
 *  misdetected. */
function isMarkdownTable(block: string): boolean

/** Split an oversized markdown table into pieces that each fit
 *  `maxChars`, each = header line + separator line + as many body rows
 *  as fit. If header+separator+first row already exceeds `maxChars`, fall
 *  back to splitLong on the whole block (degenerate; no infinite loop).
 *  Takes `overlap` only to forward to that splitLong fallback. */
function splitTableByRows(table: string, maxChars: number, overlap: number): string[]
```

### Detection rules (`isMarkdownTable`)

- Split the block into lines (it has no blank lines — it's one paragraph
  unit).
- Require ≥ 2 lines.
- Line 2 (index 1) must be a **separator row**: after trimming, it
  matches `^\|?[\s:|-]+\|?$` AND contains at least one `-`.
- The header line (index 0) and the separator line must each contain at
  least one `|`.
- At least, say, half of all lines must look like table rows
  (`^\s*\|?.*\|.*$` — contain an interior `|`). This tolerates a trailing
  caption line but rejects prose.

### Split rules (`splitTableByRows`)

- `header = lines[0]`, `separator = lines[1]`, `body = lines.slice(2)`.
- `prefix = header + "\n" + separator + "\n"`.
- **Fallback:** if `prefix.length + body[0].length > maxChars` (even the
  header + first row won't fit) → `return splitLong(table, maxChars, overlap)`.
- Otherwise greedily pack rows: start each piece at `prefix`; append
  `"\n" + row` while it keeps the piece `<= maxChars`. **Progress guard:**
  always include at least one body row per piece even if that single row
  makes the piece exceed `maxChars` (the chunker's own docs call `maxChars`
  a *soft* target, not a hard limit) — this guarantees forward progress
  and no infinite loop. When the next row would overflow, push the current
  piece and begin a new one at `prefix`. Push the final piece.
- Each emitted piece is `prefix + rows.join("\n")` and (for normal,
  short-rowed tables) is `<= maxChars`.

### Wiring in `chunkText`

In the existing oversized-paragraph branch (`if (para.length > maxChars)`):

```ts
if (para.length > maxChars) {
  if (buf && !seededOnly) chunks.push(buf)
  buf = ""
  seededOnly = false
  const pieces = isMarkdownTable(para)
    ? splitTableByRows(para, maxChars, overlap)
    : splitLong(para, maxChars, overlap)
  for (const piece of pieces) chunks.push(piece)
  continue
}
```

Nothing else in `chunkText` changes. Tables that fit are still never
split; non-table text is byte-for-byte unaffected.

## Edge cases

- **Header itself ≥ maxChars** (very wide table) → `splitTableByRows`
  detects one-row-won't-fit and falls back to `splitLong` (no header
  repetition possible; avoids an infinite loop).
- **Table with no separator line** (just pipe-prose) → `isMarkdownTable`
  returns false → existing `splitLong` path (unchanged behaviour).
- **Repeated headers across pieces** are intentional and harmless: a few
  extra tokens per chunk in exchange for self-describing fragments;
  better FTS snippets and embeddings.

## Testing (`chunk.test.ts`)

Pure unit tests, no I/O:

1. **Oversized table splits at row boundaries** — a table with many rows
   exceeding `maxChars` yields ≥ 2 chunks; every chunk starts with the
   same header + separator; no chunk contains a truncated `| ... ` row
   (each line is a complete `| ... |`); every chunk ≤ maxChars.
2. **Header repeated** — assert the header text appears in each piece.
3. **Table that fits → one chunk** — a small table under maxChars is a
   single chunk, unmodified.
4. **Prose with pipes is not a table** — an oversized paragraph
   containing `|` characters but no separator line goes through
   `splitLong` (char-split), not row-split.
5. **Degenerate wide table** — header line alone wider than maxChars
   falls back to `splitLong` (does not hang, returns ≥ 1 chunk).
6. **Non-table oversized paragraph unchanged** — existing `splitLong`
   behaviour preserved (regression guard).

## Out of scope

- Structured `blocks[]`, `block_kind` column, per-block indexing — not
  worth the schema/wire cost (see Background).
- Any UI / preview rendering — no surface shows extraction output.
- These close out the multimodal series; PR-3 (agent-service `extract`
  twins) remains optional/deferred per the parent plan.
