# Plan: Multimodal document understanding

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(fourth research round, 2026-06-09) to **Next**. Scope: **M–L** (one PR
series; vision-gated). Origin: 2026 vision-language document models —
see [Sources](#sources).

## Why

Hummingbird's extraction is **text-only**: `lib/server/extraction.ts`
runs pdf-parse / mammoth / xlsx and stores plain text for FTS +
`searchFiles`. That silently drops tables, charts, figures, and layout —
often exactly where the answer lives in technical docs, reports, and
papers. 2026 vision-language models (GLM-4.5V, Qwen2.5-VL, vision-guided
chunking) parse documents *visually*, preserving structure. Since
Hummingbird already supports vision input, a vision-aware extraction
path would materially improve retrieval quality + file Q&A with no new
model vendor.

## Non-goals — what this is NOT

- **Not replacing text extraction.** Text extraction stays the fast
  default; vision extraction is an *enhancement* for layout-rich files
  (or a fallback when text extraction returns little).
- **Not OCR-from-scratch.** Uses a vision-capable chat model on rendered
  pages, not a bespoke OCR engine.
- **Not for every file.** Gated to PDFs/images with real layout, and to
  vision-capable models; plain text/markdown skip it.
- **Not a new storage model.** Richer chunks flow into the *existing*
  full-text / `searchFiles` index (+ optionally the future vector
  index).

## Decisions to pin before code

1. **When vision extraction runs.** A heuristic: text extraction first;
   if the doc is layout-rich (many tables/figures, low text yield, or a
   scanned PDF) **and** a vision-capable model is configured, run the
   vision pass. Also user-triggerable ("re-extract with vision").
2. **Method.** Render PDF pages → images; send page images to a
   vision-capable model with a structured prompt ("transcribe layout:
   tables → markdown, figures → captions, preserve reading order").
   Vision-guided chunking keeps a table/section intact as one chunk.
3. **Output.** Structured per-page blocks (`text`, `table` (markdown),
   `figure` (caption)) merged into the document's `full_text` + section
   index — so `searchFiles` retrieves *structured* chunks, and file Q&A
   sees tables as tables.
4. **Cost/perf.** Vision passes are expensive → gated + capped (page
   limit per doc), budget-gated, and cached (pairs with semantic
   caching's exact-key cache on the file hash).
5. **Backend.** Lands in the extraction path
   (`app/api/extract` + `lib/server/extraction.ts`) with the agent-py /
   agent-ts `extract` twins following.

## Shape — code surface

### Extraction — vision path

- `lib/server/extraction/vision.ts` —
  `extractWithVision(file, model): Promise<StructuredDoc>`: render pages
  (a PDF→image step) → per-page vision calls → merge into
  `{ blocks: DocBlock[], fullText, sections }`.
- `lib/server/extraction.ts` — after the text pass, a
  `shouldUseVision(result, file)` heuristic gates the vision path;
  merge structured blocks into the existing extraction result shape
  (`{ status, kind, text, summary, keyTopics }` gains optional
  `blocks` / structured sections).

### Storage / index

- The structured sections feed the existing `file_sections` FTS index
  (`0009_search_file_sections`) so `searchFiles` returns
  layout-preserving chunks; a small migration if a `block_kind` column
  helps ranking. (Vector index later, when the embedding pipeline lands.)

### Route + UI

- `app/api/extract/route.ts` — honour a `vision?: boolean` flag (auto
  by heuristic, or forced by the user); per-IP budget + page cap.
- A "Re-extract with vision" affordance on the file row; tables render
  as tables in the file preview.

## Sequencing — PR series

1. **PR 1 — vision extraction path (auto-gated).** `extractWithVision`
   + the PDF→image render + the `shouldUseVision` heuristic + merge into
   the result; budget + page caps; vision-capable-model gate. Falls back
   cleanly to text-only when unavailable.
2. **PR 2 — structured index + retrieval.** Feed structured sections
   into `file_sections`; `searchFiles` returns layout-aware chunks;
   table rendering in the file preview.
3. **PR 3 — agent-service parity + caching.** Python/TS `extract` twins;
   cache vision results on the file hash (pairs with semantic caching).

## Tests

- **`shouldUseVision` heuristic (PR 1)** — layout-rich/low-text-yield/
  scanned → true; clean text PDF / markdown → false. Pure.
- **Merge (PR 1)** — structured blocks merge into the result shape
  without breaking existing text-only consumers (regression guard).
- **Gate (PR 1)** — no vision-capable model → text-only path (no
  vision calls).
- **Manual smoke** — a table-heavy PDF yields markdown tables + better
  `searchFiles` hits on table contents; a plain-text doc skips vision
  (no extra cost).

## Open questions before PR 1

1. **PDF→image renderer.** Needs a render step (pdfium/pdf.js/poppler).
   **Default: a server-side renderer in the extraction container; cap
   pages (e.g. 30) to bound cost.**
2. **Which vision model.** **Default: the workspace's vision-capable
   chat model (reuse the existing vision path); a dedicated doc-VLM
   (GLM-4.5V/Qwen2.5-VL) as a configurable option.**
3. **When to auto-trigger vs ask.** **Default: auto for clearly
   layout-rich/scanned docs; offer "re-extract with vision" everywhere
   else (cost transparency).**

## Reopen / future work

- **Multimodal retrieval (ColPali-style)** — index page images directly
  + retrieve by visual similarity (needs the vector pipeline).
- **Charts → data** — extract chart underlying data, not just captions
  (pairs with the code interpreter for re-plotting).
- **Video/audio understanding** — extend beyond documents once there's
  demand.

## Sources

- [Best multimodal models for document analysis 2026](https://www.siliconflow.com/articles/en/best-multimodal-models-for-document-analysis)
- [Vision-guided chunking for RAG](https://arxiv.org/pdf/2506.16035)
- [PDF retrieval with vision-language models (ColPali)](https://blog.vespa.ai/retrieval-with-vision-language-models-colpali/)
