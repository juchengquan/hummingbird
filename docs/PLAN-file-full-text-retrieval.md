# Plan: File full-text retrieval (A + C)

Status: **Drafted, not yet started.**

## Why

Today, files attached to a conversation are truncated to 32 KB at
extraction time and capped at 96 KB across all attachments per turn.
A 100-page PDF is ~95% truncated before it reaches the model. There
is no chunking, no embeddings, and no retrieval — files are attached
in full (within the cap) on every turn, regardless of what the user
is actually asking about.

This plan unlocks the full text of attached files in two complementary
moves: raise the inline caps (Phase 1), and add a `readFileSection`
tool the model can call when it needs more (Phase 3+). The two pieces
share a single storage decision; together they handle the common
"chat about this 50-page doc" case automatically *and* the long-tail
"this 200-page manual has the answer somewhere" case via tool calls.

## Current state

| Constraint | Value | Where |
|---|---|---|
| Per-file extraction cap | 32 KB (64 KB for code) | `app/api/extract/route.ts:6, :33` |
| Cross-attachment prompt budget | 96 KB | `app/api/chat/route.ts:33` |
| Wire-level per-file text cap | 220 KB | `lib/shared/api-schemas.ts:41` |
| Allocation across files | Greedy / sequential | `lib/server/attachments/render.ts:205-271` |
| Chunking / embeddings / vector search | None | — |

Greedy allocation means later attachments are dropped entirely when
earlier ones fill the budget — no fairness, no relevance.

## Approach — two complementary moves

**A — raise the caps.** Bump per-file and cross-attachment limits so
small/medium files arrive in full automatically, no model effort
needed.

**C — tool-based retrieval.** Add a `readFileSection({ fileId, query })`
skill so the model can fetch additional sections from any attached
file that has its full text stored. Driven by Postgres full-text
search over a `tsvector` index — sidesteps the embeddings
infrastructure entirely.

A handles the common case (chat about a 10-50 page doc). C handles
the long tail (huge files, narrow queries). They share storage:
extracted full text in a single column, used both as the source for
the inline truncated view AND for tool-call retrieval.

### What this plan deliberately does NOT do

- **No embeddings / vector search.** Postgres FTS handles "find the
  section about X" well enough for chat. Revisit if users start
  attaching libraries of hundreds of documents.
- **No multilingual stemming out of the gate.** `to_tsvector('english',
  …)` only. Switching to `'simple'` or per-document language is a
  later concern.
- **No client-side full text for anonymous users.** Phase 3+ requires
  sign-in. Anonymous users get Phase 1 only (larger inline caps);
  sign-in becomes the upgrade story.

## Phases

Each phase is a standalone PR. Earlier phases deliver value alone — the
plan can stop after any one.

### Phase 1 — Raise the caps (≈ 1 hour, standalone)

**Goal:** immediate win for medium files with zero new infrastructure.

| Change | File | From → To |
|---|---|---|
| `EXTRACTION_BUDGET` | `app/api/extract/route.ts:6` | 32 KB → **100 KB** |
| `CODE_BUDGET` | `app/api/extract/route.ts:33` | 64 KB → **128 KB** |
| `TOTAL_ATTACHMENT_BUDGET` | `app/api/chat/route.ts:33` | 96 KB → **300 KB** |
| `FileSummary.text.max(...)` | `lib/shared/api-schemas.ts:41` | 220 KB → **120 KB** (slightly above per-file cap) |

**Smoke test:** drop a 50-page PDF, confirm extraction + chat both
work end-to-end, watch token usage in the model response.

**Risk:** token cost goes up proportionally. Worth being explicit with
users that bigger files mean bigger prompts.

### Phase 2 — Storage for full extracted text (≈ half day)

**Goal:** full text must be reachable at chat time. Gating decision
for Phase 3+.

**Migration** — `supabase/migrations/0007_file_full_text.sql`:
```sql
alter table files add column full_text text;
alter table files add column full_text_tsv tsvector
  generated always as (to_tsvector('english', coalesce(full_text, ''))) stored;
create index files_full_text_tsv_idx on files using gin (full_text_tsv);
```

Postgres FTS over a generated `tsvector` is the right call — text up
to ~1 MB stays well inside row-size comfort, and the GIN index makes
ranked retrieval cheap. No separate object-storage round-trip on
every tool call.

**Extraction route** — after extraction, write the **full** text to
`files.full_text` for the signed-in path. Still return the truncated
head to the client (preserves Phase 1's flow). Anonymous mode skips
this write.

**Cleanup** — existing file-delete flow already cascades to the row;
no extra work needed.

**Decision:** anonymous users get Phase 1 only. Phase 3+ is sign-in
gated. The right boundary — full-text storage is real cost and ties
to an account.

### Phase 3 — The `readFileSection` tool (≈ 1 day)

**Goal:** a `ServerSkill` matching the existing pattern (`web-search`,
`web-fetch`, `image-gen`).

**New file** `lib/server/skills/file-search.ts`:

- `buildFileSearchTool(log, opts)` returning an AI-SDK tool:
  ```ts
  inputSchema: z.object({
    fileId: z.string().min(1).max(64),
    query: z.string().min(1).max(400),
    maxChars: z.number().int().min(500).max(16_000).optional(),
  })
  ```
- `execute`:
  1. Authorize `fileId` against the caller's workspace (RLS on `files`
     should already handle this; if SECURITY DEFINER is needed,
     reference the MCP credentials pattern).
  2. Postgres FTS query: `where full_text_tsv @@ plainto_tsquery('english', $query)`
     ranked by `ts_rank(full_text_tsv, plainto_tsquery(...))`.
  3. Return top-3 paragraph windows (each ~1-2 KB with surrounding
     context), capped at `maxChars` (default 8 KB).
- `fileSearchSkill: ServerSkill` registry entry, returning null when
  no attached file has stored full text.

**Wiring:**
- `lib/server/skills/registry.ts` — push `fileSearchSkill` to
  `SERVER_SKILLS`.
- `lib/shared/skills/registry.ts` — client-visible metadata;
  default-on for signed-in users with attached files.

**Per-IP budget:** share `chatWebToolLimit` — same cost profile as
webFetch.

**Tests:**
- Ranking: paragraph A more relevant than B for query X → A returned first.
- Authorization: can't read another workspace's file.
- Graceful "no full text stored": anonymous-mode files return a
  helpful error directing the user to sign in.
- Cap: a query that would match many sections respects `maxChars`.

### Phase 4 — Prompt wiring (≈ 1 hour)

**Goal:** tell the model when and how to use the new tool.

`fileSearchSkill.promptFragment` — only when at least one attached
file has `full_text` stored AND was truncated in the inline view:

> One or more attached files were truncated to fit the prompt. You
> can call `readFileSection({ fileId, query })` to fetch additional
> relevant sections from any of them. Use this when the user's
> question references content that isn't in the inline excerpt. HARD
> LIMIT: 3 calls per turn.

Cap of 3 per turn (matches webSearch's vibe). Tunable.

### Phase 5 — UI polish (≈ half day, optional)

- File-row indicator: "100 KB extracted • 32 KB attached" so users
  understand the difference and that the tool will be used.
- Tool-call strip surfaces `readFileSection` calls like webSearch is
  surfaced today (`isWebSearchToolName` pattern → add an analogous
  `isFileSearchToolName`).
- Can be deferred indefinitely; the feature works without it.

## Tuning knob: the per-file cap

The per-file cap (Phase 1's `EXTRACTION_BUDGET`) decides how often the
model falls back to the tool:

| Cap | Tool-call rate | Trade-off |
|---|---|---|
| 64 KB | Higher — most files need tool calls | Cheaper per turn; more model latency |
| **100 KB** (proposed) | Medium — only large files | Reasonable default |
| 200 KB+ | Low — tool rarely used | Higher per-turn cost; more wasted tokens for narrow queries |

Start at 100 KB. Tune by watching the rate of `readFileSection`
tool calls in practice.

## Open questions

1. **English-only FTS.** Acceptable for v1; users uploading
   non-English PDFs get inferior ranking. Worth a `language` column
   on the `files` table later, detected at extraction time.
2. **Section windowing strategy.** Top-3 paragraphs is a starting
   point. Could rank larger windows (sections / pages) for PDFs with
   semantic structure, but paragraph-level keeps the implementation
   simple and works for plain-text-extracted PDFs.
3. **Storage cost.** Full text in Postgres adds ~100 KB per file on
   average. Tolerable for individual users; revisit if the app
   hosts many large libraries.
4. **Should `image` attachments expose `readFileSection`?** No — they
   have no extracted text. Skill is scoped to files with non-empty
   `full_text`.

## Sequencing

- Phase 1 ships first — it's the minimum-cost upgrade and unblocks
  immediate user value.
- Phase 2 + 3 + 4 go together (Phase 2 alone has no user-visible
  effect; Phase 3 needs Phase 2; Phase 4 is the model-facing
  unlock).
- Phase 5 is optional and can ship any time after Phase 4.
