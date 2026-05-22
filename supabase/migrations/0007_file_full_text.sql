-- ---------------------------------------------------------------------------
-- files.full_text + Postgres full-text-search index
--
-- Phase 2 of the file full-text retrieval plan
-- (docs/PLAN-file-full-text-retrieval.md). Adds a second extraction
-- column alongside the existing `extracted_text` (from 0001):
--
--   - `extracted_text` stays the truncated head (currently 100 KB per
--     file, see EXTRACTION_BUDGET in app/api/extract/route.ts). This
--     is what flows into the system prompt on every chat turn.
--
--   - `full_text` is the complete extraction up to FULL_EXTRACTION_BUDGET
--     (1 MB), kept for the `readFileSection` tool added in Phase 3 so
--     the model can pull sections that didn't fit the inline budget.
--
-- The `full_text_tsv` generated column + GIN index back the FTS query
-- in Phase 3 — `where full_text_tsv @@ plainto_tsquery('english', ?)`
-- with `ts_rank` ordering. English-only for v1; switching to per-doc
-- language is a later concern (see Open questions in the plan doc).
--
-- Storage cost: rows grow by up to ~1 MB each when a file extracts to
-- full text. Tolerable for individual users; revisit if libraries of
-- hundreds of large files become common.
-- ---------------------------------------------------------------------------

alter table public.files add column full_text text;

alter table public.files add column full_text_tsv tsvector
  generated always as (to_tsvector('english', coalesce(full_text, ''))) stored;

create index files_full_text_tsv_idx on public.files using gin (full_text_tsv);
