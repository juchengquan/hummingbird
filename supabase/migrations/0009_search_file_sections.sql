-- ---------------------------------------------------------------------------
-- search_file_sections(p_file_id, p_query, …) — Postgres-side FTS over the
-- `files.full_text` column added in 0007. Phase 3 of the file full-text
-- retrieval plan (docs/PLAN-file-full-text-retrieval.md): the
-- `searchFiles` ServerSkill RPCs into this function so the model can
-- pull paragraph-sized excerpts from a specific attached file when its
-- inline view was truncated.
--
-- Why an RPC instead of building the query client-side via the supabase
-- query builder:
--
--   - `ts_headline` is the right primitive for "give me readable
--     fragments around the matches" — it counts words, handles
--     paragraph-ish chunking, and brackets matched terms with our
--     chosen markers. None of that is expressible via PostgREST select
--     filters.
--
--   - Doing it Postgres-side avoids streaming up-to-1 MB of full_text
--     across the network per tool call only to chunk it in JS.
--
--   - SECURITY INVOKER (the default) means RLS on `files` (0002) still
--     evaluates against the caller's `auth.uid()`, so the function
--     can't be used to read another user's files. No SECURITY DEFINER
--     escape hatch needed.
--
-- The function returns one row per matching file (in practice always
-- zero or one row, since the caller filters by id). `excerpt` is a
-- single string with up to `p_max_fragments` fragments joined by ‖;
-- the calling code splits on that delimiter. `rank` is the standard
-- `ts_rank` score over the file's tsvector, useful for the "no hits"
-- check (rank > 0 → at least one match).
--
-- Markers chosen for visibility to the model without colliding with
-- typical document content: « / » for match boundaries (rare in code
-- and prose), ‖ for fragment separator (also rare).
-- ---------------------------------------------------------------------------

create or replace function public.search_file_sections(
  p_file_id uuid,
  p_query text,
  p_max_fragments int default 3,
  p_max_words int default 120,
  p_min_words int default 30
)
returns table (
  excerpt text,
  rank real
)
language sql
stable
security invoker
as $$
  select
    ts_headline(
      'english',
      full_text,
      plainto_tsquery('english', p_query),
      'StartSel=«, StopSel=», MaxFragments=' || p_max_fragments
        || ', MaxWords=' || p_max_words
        || ', MinWords=' || p_min_words
        || ', FragmentDelimiter=‖'
    ) as excerpt,
    ts_rank(full_text_tsv, plainto_tsquery('english', p_query)) as rank
  from public.files
  where id = p_file_id
    and full_text is not null
    and deleted_at is null;
$$;

grant execute on function public.search_file_sections(uuid, text, int, int, int) to authenticated;
