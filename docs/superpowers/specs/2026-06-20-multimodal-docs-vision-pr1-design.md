# Multimodal document understanding — PR-1 design (vision extraction path)

Status: **approved design**, ready for implementation plan.
Date: 2026-06-20. Parent plan: [`docs/PLAN-multimodal-docs.md`](../../PLAN-multimodal-docs.md)
(this spec is PR-1 of that plan's 3-PR series).

## Goal

Add an **auto-gated vision extraction path** to the document pipeline.
When a PDF is layout-rich **and** a vision-capable model is configured,
render its pages to images, have a vision model transcribe the layout
(tables → markdown, figures → captions, preserving reading order), and
**merge that richer text into the existing `ExtractionResult.text` /
`fullText` fields**. Fall back cleanly to the text-only result on any
failure.

## Why this shape

Extraction is **stateless**: `app/api/extract/route.ts` calls
`extractFile()` (`lib/server/extraction.ts`), returns an
`ExtractionResult` as JSON, and the **caller** persists `extracted_text`
/ `full_text`. So if the vision pass folds its output into `text` /
`fullText`, **every** downstream consumer — Postgres FTS, `searchFiles`,
inline file Q&A — benefits immediately with **no migration, no wire
change, no store change, no UI change**. Structured `blocks[]` + the
`file_sections` index + table rendering are deliberately deferred to
PR-2, where something actually consumes them (YAGNI).

## Renderer decision (validated by spike, 2026-06-20)

Server-side PDF→image rendering does not exist in the repo today. A
throwaway spike tested two approaches against a generated A4 PDF:

- `pdfjs-dist@5.7.284` (repo's transitive version) + a hand-rolled
  `@napi-rs/canvas@1.0.0` factory → **fails**: pdfjs calls
  `ctx.fill(Path2D)` during text rendering and that canvas version
  rejects the `Path2D` arg. Rolling our own factory couples pdfjs's
  internal canvas API to a specific canvas version — fragile.
- **`pdf-to-img`** (wraps pdfjs `~5.6.205` + a version-matched bundled
  `@napi-rs/canvas`) → **works**: A4 → valid 1190×1683 PNG with real
  content.

**Decision:** use **`pdf-to-img`** as the renderer. It pins a known-good
pdfjs+canvas pairing. It pulls `@napi-rs/canvas` (native NAPI binding)
transitively, so — exactly like `microsandbox` — it must be added to
`serverExternalPackages` in `next.config.ts`; the first plan task
verifies the production build bundles it.

## Components

| File | Responsibility |
|---|---|
| `config/models.json` + `lib/shared/models.ts` | Add `supportsVision?: boolean` to the chat-model schema + a `modelSupportsVision(id)` helper; flag the vision-capable models. |
| `lib/server/extraction/render-pdf.ts` (new) | `renderPdfPages(data: Uint8Array, opts?: { maxPages?: number; scale?: number }): Promise<Buffer[]>` via `pdf-to-img`. Default `maxPages = 30`, `scale = 2.0`. Pure-ish I/O wrapper. |
| `lib/server/extraction/vision.ts` (new) | `extractWithVision({ data, model, signal }): Promise<{ text: string; pageCount: number }>` — render pages, one vision call per page with a structured "transcribe layout" prompt, concatenate per-page markdown (with `\n\n--- page N ---\n\n` separators). |
| `lib/server/ai/structured.ts` | Extend `generateStructured` to accept `messages` (image + text content parts) as an alternative to `prompt`, so page images can be sent. Existing `prompt` callers unchanged. |
| `lib/server/extraction.ts` | Pure `shouldUseVision(result, file)` heuristic + the model gate; when both pass, run the vision pass and merge its markdown into `text` / `fullText`; fall back to the text-only result on any vision error. |
| `lib/server/extraction/vision-model.ts` (new) | `resolveVisionModel(): string \| null` — resolves the vision model **server-side** (no change to the extract contract): `process.env.VISION_MODEL` if set and flagged `supportsVision`, else the first `supportsVision` model in `config/models.json`, else `null`. `null` → vision path is skipped entirely. |
| `app/api/extract/route.ts` | Honour optional `vision?: boolean` (auto via heuristic, or forced by the caller); include the vision flag in the exact-key cache key so vision/non-vision results don't collide; add a `createSlidingWindow` budget gate around the vision pass. |
| `next.config.ts` | Add `pdf-to-img` (and `@napi-rs/canvas` if the build requires it) to `serverExternalPackages`. |

### `shouldUseVision(result, file)` heuristic (pure)

Returns `true` only when the document is plausibly layout-rich:

- File is a PDF (`result.kind === "pdf"`); non-PDF → `false`.
- AND one of:
  - **Low text yield** — extracted text length is small relative to file
    size (a scanned/image PDF yields little text per KB): e.g.
    `text.length / fileSizeBytes < LOW_YIELD_RATIO`.
  - **Table-dense** — the text shows many short, columnar lines
    (heuristic: a high ratio of lines with ≥2 runs of whitespace),
    suggesting tables the text pass flattened.

Markdown / text / docx / csv / json / code / spreadsheet / image kinds →
`false`. The thresholds (`LOW_YIELD_RATIO`, table-line ratio, min lines)
are named constants at the top of the file.

### Vision prompt + per-page call

For each rendered page image, call the extended `generateStructured`
with a small schema `{ markdown: string }` and a message containing the
page PNG + an instruction: transcribe the page to markdown, render
tables as GitHub-flavoured markdown tables, describe figures/charts as
`*Figure: …*` captions, preserve reading order, omit page furniture
(headers/footers/page numbers). Concatenate pages.

### Merge

`mergeVisionText(textResult, visionText)` → returns an `ExtractionResult`
where `text` / `fullText` carry the vision markdown (respecting the
existing `EXTRACTION_BUDGET` / `FULL_EXTRACTION_BUDGET` truncation). The
`kind` stays `"pdf"`. No new fields.

## Data flow

```
POST /api/extract (file [, vision?])
  → extractFile()
    → text pass (pdf-parse)                         [unchanged]
    → model = resolveVisionModel()  (null → skip vision)
    → shouldUseVision(result, file) && model?
        → budget gate (createSlidingWindow)
        → renderPdfPages(data) → Buffer[]
        → per page: generateStructured(image + prompt) → markdown
        → mergeVisionText(textResult, visionMarkdown)
        → on ANY error/timeout/budget-exhausted → return text-only result
  → ExtractionResult JSON (same shape)              [caller persists]
```

## Error handling

The vision path is **best-effort and never fatal**. Render failure,
model error, abort/timeout, or budget exhaustion → log a structured
warning and return the text-only `ExtractionResult`. The page cap and
the per-window budget gate bound cost. Cache key includes the vision
flag so a forced-vision result and an auto result are stored distinctly.

## Testing

- **`shouldUseVision` (pure)** — ~6 cases: scanned/low-yield PDF → true;
  table-dense PDF → true; clean prose PDF → false; markdown/csv/image
  kinds → false.
- **`mergeVisionText` (pure)** — vision markdown lands in `text` /
  `fullText`, respects truncation budgets, doesn't break the
  text-only-consumer contract (shape unchanged).
- **Gate** — `resolveVisionModel()` returns `null` (no `supportsVision`
  model configured) → no render / no vision calls (assert the renderer +
  `generateStructured` are not invoked). Also `modelSupportsVision`
  helper: flagged id → true, unflagged/unknown → false.
- **Renderer smoke** — render a tiny committed fixture PDF → ≥1 PNG
  buffer with a valid PNG signature. Resilient-skip if the native
  `@napi-rs/canvas` binding is unavailable in the test environment
  (don't fail CI on a missing optional native binary).
- **Manual smoke (PR checklist)** — a table-heavy PDF yields markdown
  tables in the extracted text and better `searchFiles` hits on table
  contents; a plain-text PDF skips the vision pass (no extra cost / no
  vision call in logs).

## Scope boundary

- **PR-1 (this spec):** richer extracted *text* via vision; gate +
  heuristic + renderer + merge + budget; build verified with the native
  binding. No schema / wire / store / UI changes.
- **PR-2 (future):** structured `blocks[]`, feed structured sections
  into `file_sections`, layout-aware `searchFiles` chunks, table
  rendering in the file preview, a "re-extract with vision" affordance.
- **PR-3 (future):** agent-py / agent-ts `extract` twins; cache vision
  results on the file hash (pairs with semantic caching).

## Open questions — resolved

1. **Renderer** — `pdf-to-img` (spike-validated). Resolved.
2. **PR-1 output** — markdown merged into existing `text` / `fullText`;
   no `blocks[]` yet. Resolved (user-approved).
3. **Vision model** — resolved server-side by `resolveVisionModel()`
   (`VISION_MODEL` env override → first `supportsVision` model in config
   → `null`), so the extract route's contract stays file-only (plus the
   optional `vision?` flag). `null` → vision skipped. A dedicated doc-VLM
   stays a later, configurable option (out of PR-1 scope).

## Data-flow note — model resolution

`extractFile()` calls `resolveVisionModel()` internally; the extract
route does **not** gain a model parameter. This keeps the stateless,
model-agnostic route contract intact and means the vision path is a pure
server-side enhancement gated on configuration.
