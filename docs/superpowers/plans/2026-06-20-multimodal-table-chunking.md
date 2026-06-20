# Multimodal Docs PR-2 — Table-Aware Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `chunkText` must split a markdown table larger than `maxChars`, split it at row boundaries with the header repeated on each piece, instead of arbitrary character windows — so each index chunk is a valid, self-describing table fragment.

**Architecture:** A pure, single-file change to `lib/server/embeddings/chunk.ts`: two private helpers (`isMarkdownTable`, `splitTableByRows`) plus a one-line branch in `chunkText`'s existing oversized-paragraph path. No migration, wire, store, or UI change; `indexFileSections` consumes the improved `chunkText` automatically. The helpers stay private (like the existing `splitLong`) and are tested through the public `chunkText` API.

**Tech Stack:** TypeScript, Bun test (`bun:test`). Pure functions, no I/O.

**Spec:** [`docs/superpowers/specs/2026-06-20-multimodal-table-chunking-design.md`](../specs/2026-06-20-multimodal-table-chunking-design.md)

**Current `chunk.ts` shape (for reference):** `chunkText(text, opts)` splits on blank-line paragraphs, packs them into `maxChars` (default 1500) windows with `overlapChars` (default 200) carryover, and hard-splits an oversized paragraph via the private `splitLong(text, maxChars, overlap)`. The oversized-paragraph branch is:

```ts
    if (para.length > maxChars) {
      if (buf && !seededOnly) chunks.push(buf)
      buf = ""
      seededOnly = false
      for (const piece of splitLong(para, maxChars, overlap)) chunks.push(piece)
      continue
    }
```

---

### Task 1: Table-aware chunking

**Files:**
- Modify: `lib/server/embeddings/chunk.ts`
- Test: `lib/server/embeddings/chunk.test.ts`

The helpers are private (consistent with `splitLong`), so tests drive them through the public `chunkText` using a small `maxChars` to force the oversized path.

- [ ] **Step 1: Write the failing tests** — append a new `describe` block to `lib/server/embeddings/chunk.test.ts` (the file already imports `{ describe, expect, test }` and `chunkText` at the top — do NOT re-import):

```ts
describe("chunkText — markdown tables", () => {
  const HEADER = "| Name | Score |"
  const SEP = "|------|-------|"
  function table(rows: string[]): string {
    return [HEADER, SEP, ...rows].join("\n")
  }
  const ROWS = [
    "| Alice | 100 |",
    "| Bob | 95 |",
    "| Carol | 88 |",
    "| Dave | 77 |",
    "| Eve | 66 |",
    "| Frank | 55 |",
  ]

  test("oversized table splits at row boundaries, header repeated, each ≤ maxChars", () => {
    const chunks = chunkText(table(ROWS), { maxChars: 60, overlapChars: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // Header + separator repeated on every piece.
      expect(c.startsWith(HEADER + "\n" + SEP)).toBe(true)
      expect(c.length).toBeLessThanOrEqual(60)
      // No truncated rows: every non-empty line is a complete `| ... |` row.
      for (const line of c.split("\n")) {
        if (line.trim() === "") continue
        expect(line.startsWith("|") && line.endsWith("|")).toBe(true)
      }
    }
    // Every original row survives somewhere.
    const joined = chunks.join("\n")
    for (const r of ROWS) expect(joined).toContain(r)
  })

  test("table that fits → single unmodified chunk", () => {
    const t = table(["| Alice | 100 |", "| Bob | 95 |"])
    expect(chunkText(t, { maxChars: 1000 })).toEqual([t])
  })

  test("prose with pipes but no separator row is NOT treated as a table", () => {
    // One paragraph, pipes present, but line 2 is not a `|---|` separator.
    const prose =
      "Intro | with | pipes that goes on.\n" +
      "Second | line | also has pipes but no separator.\n" +
      "x".repeat(200)
    const chunks = chunkText(prose, { maxChars: 80, overlapChars: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    // splitLong path: a continuation chunk does NOT start with line 1.
    expect(chunks[1].startsWith("Intro | with | pipes")).toBe(false)
  })

  test("degenerate: header+first row wider than maxChars → splitLong fallback, no hang", () => {
    const wide = ["| AAAAAAAAAA | BBBBBBBBBB |", "|------------|------------|", "| 1 | 2 |"].join(
      "\n"
    )
    const chunks = chunkText(wide, { maxChars: 20, overlapChars: 5 })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // Fallback char-split: a continuation chunk does NOT re-repeat the header line.
    if (chunks.length > 1) {
      expect(chunks[1].startsWith("| AAAAAAAAAA | BBBBBBBBBB |")).toBe(false)
    }
  })

  test("non-table oversized paragraph unchanged (regression: splitLong)", () => {
    const prose = "word ".repeat(100).trim() // ~499 chars, no pipes, one paragraph
    const chunks = chunkText(prose, { maxChars: 100, overlapChars: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    // splitLong emits raw character windows: chunk 0 is a prefix of the text.
    expect(prose.startsWith(chunks[0])).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/blackmount8/_repository/hummingbird-chunk && bun test lib/server/embeddings/chunk.test.ts`
Expected: the new "markdown tables" tests FAIL (current behaviour char-splits oversized tables via `splitLong`, so header isn't repeated and rows get truncated). The pre-existing `chunkText` tests still pass.

- [ ] **Step 3: Add the two private helpers** to `lib/server/embeddings/chunk.ts`, placed right after the existing `splitLong` function (before `chunkText`):

```ts
/** True when `block` is a GFM pipe table: ≥2 lines, line 1 has a pipe,
 *  line 2 is a separator (only `|`, `-`, `:`, spaces; ≥1 `-` and a `|`),
 *  and at least half the lines contain a pipe. Strict enough that prose
 *  containing pipes is not misdetected. */
function isMarkdownTable(block: string): boolean {
  const lines = block.split("\n")
  if (lines.length < 2) return false
  const header = lines[0]
  const separator = lines[1].trim()
  if (!header.includes("|")) return false
  if (!separator.includes("|") || !separator.includes("-")) return false
  if (!/^[|\s:-]+$/.test(separator)) return false
  const rowish = lines.filter((l) => l.includes("|")).length
  return rowish >= Math.ceil(lines.length / 2)
}

/** Split an oversized markdown table into pieces that each fit `maxChars`,
 *  every piece = header + separator + as many body rows as fit. If even
 *  header+separator+the first row won't fit, fall back to `splitLong` on
 *  the whole block. Always keeps ≥1 row per piece (so a single huge row
 *  still makes progress — `maxChars` is a soft target, per this module). */
function splitTableByRows(table: string, maxChars: number, overlap: number): string[] {
  const lines = table.split("\n")
  const prefix = `${lines[0]}\n${lines[1]}`
  const body = lines.slice(2)
  if (body.length === 0 || prefix.length + 1 + body[0].length > maxChars) {
    return splitLong(table, maxChars, overlap)
  }
  const pieces: string[] = []
  let rows: string[] = []
  const pieceLength = () =>
    prefix.length + rows.reduce((n, r) => n + 1 + r.length, 0)
  for (const row of body) {
    if (rows.length > 0 && pieceLength() + 1 + row.length > maxChars) {
      pieces.push(`${prefix}\n${rows.join("\n")}`)
      rows = []
    }
    rows.push(row)
  }
  if (rows.length > 0) pieces.push(`${prefix}\n${rows.join("\n")}`)
  return pieces
}
```

- [ ] **Step 4: Wire the table branch into `chunkText`.** Replace the oversized-paragraph branch's split call so a markdown table uses row-splitting. The branch becomes:

```ts
    if (para.length > maxChars) {
      // Oversized paragraph: emit any real accumulated buffer, then split.
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

(Only the `const pieces = …` line + the loop over `pieces` change; the rest of the branch is identical to the original.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/blackmount8/_repository/hummingbird-chunk && bun test lib/server/embeddings/chunk.test.ts`
Expected: PASS — all new "markdown tables" tests + all pre-existing `chunkText` tests.

- [ ] **Step 6: Update the module doc comment.** The file's top comment describes the strategy; add a sentence so it stays accurate. Change the strategy paragraph (lines ~9-14) to append:

```
 * A single paragraph longer than `maxChars` is hard-split into
 * overlapping character windows — except a markdown table, which is
 * split at row boundaries with its header repeated on each piece so
 * every fragment stays a valid, self-describing table.
```

(Integrate that into the existing comment prose; don't duplicate the existing sentence about hard-splitting — replace it with the expanded version.)

- [ ] **Step 7: Commit**

```bash
cd /Users/blackmount8/_repository/hummingbird-chunk
git add lib/server/embeddings/chunk.ts lib/server/embeddings/chunk.test.ts
git commit -m "feat(embeddings): split oversized markdown tables at row boundaries"
```

---

### Task 2: Full gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint + tests**

Run: `cd /Users/blackmount8/_repository/hummingbird-chunk && bun run check`
Expected: typecheck clean; lint 0 errors (pre-existing warnings in unrelated files are fine); all tests pass (the full suite, including the new table tests).

- [ ] **Step 2: Commit** (only if lint auto-fixes or any incidental change was needed; otherwise skip — Task 1 already committed the work).

```bash
cd /Users/blackmount8/_repository/hummingbird-chunk
git add -A && git commit -m "chore: gate fixes for table-aware chunking" || echo "nothing to commit"
```

---

## Notes for the PR description

- PR-2 (re-scoped) of `docs/PLAN-multimodal-docs.md`. Pure chunker improvement: oversized markdown tables (produced by the PR-1 vision pass) are split at row boundaries with the header repeated, so index fragments stay self-describing instead of being char-split mid-row.
- No migration, wire-schema, store, or UI change. `indexFileSections` consumes it automatically; tables that fit are unaffected; non-table text is byte-for-byte unchanged.
- The originally-planned PR-2 (structured `blocks[]` + `block_kind` column + preview table rendering) was dropped: no UI surface displays extraction output (PDFs preview as the real document), and retrieval already indexes the vision markdown — so it added schema/wire cost for marginal value. This effectively completes the multimodal series (PR-3 agent-service `extract` twins remains optional/deferred).
- No build/migration impact; standard `bun run check` gate.
