-- ---------------------------------------------------------------------------
-- File embeddings — the vector substrate for hybrid retrieval
-- (docs/PLAN-local-rag.md). Today `searchFiles` does FTS over the single
-- `files.full_text` column (0007 / 0009). This adds a chunked + embedded
-- companion table so retrieval can blend lexical (FTS) with semantic
-- (vector) matches.
--
-- Foundation only: this migration creates the table + index + a
-- nearest-neighbour RPC. Populating it (chunk → embed on extraction) and
-- consuming it (a hybrid `searchFiles`) land in follow-up PRs. Until an
-- embedding provider is configured server-side (EMBEDDINGS_BASE_URL /
-- OLLAMA_BASE_URL) nothing writes here, so this is inert on existing
-- deployments.
--
-- Dimension: 768, matching `nomic-embed-text` (the default embedder in
-- `lib/server/embeddings/provider.ts`, `EMBEDDING_DIM`). A different model
-- with a different dimension needs a matching column change.
-- ---------------------------------------------------------------------------

-- pgvector. On hosted Supabase the extension lives in the `extensions`
-- schema (already on the API search_path); locally this installs it in
-- place. Idempotent.
create extension if not exists vector;

create table if not exists public.file_sections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_id uuid not null references public.files(id) on delete cascade,
  -- 0-based order of this chunk within the file.
  section_index int not null,
  content text not null,
  -- Null until embedded (the write path embeds asynchronously / lazily).
  embedding vector(768),
  created_at timestamptz not null default now(),
  unique (file_id, section_index)
);

create index if not exists file_sections_file_idx
  on public.file_sections (file_id);

-- ivfflat cosine index. `lists` is a coarse tuning knob; 100 suits the
-- modest per-user corpus expected here. (An empty table builds instantly;
-- ANALYZE after the first bulk load improves planning.)
create index if not exists file_sections_embedding_idx
  on public.file_sections using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table public.file_sections enable row level security;

-- Own-rows RLS, mirroring the `agents` table (0020). A user only ever
-- sees / writes embeddings for their own files.
drop policy if exists "file_sections: select own" on public.file_sections;
create policy "file_sections: select own"
  on public.file_sections for select using (auth.uid() = user_id);
drop policy if exists "file_sections: insert own" on public.file_sections;
create policy "file_sections: insert own"
  on public.file_sections for insert with check (auth.uid() = user_id);
drop policy if exists "file_sections: update own" on public.file_sections;
create policy "file_sections: update own"
  on public.file_sections for update using (auth.uid() = user_id);
drop policy if exists "file_sections: delete own" on public.file_sections;
create policy "file_sections: delete own"
  on public.file_sections for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- match_file_sections — cosine nearest-neighbour over one file's chunks.
-- SECURITY INVOKER so the caller's RLS on file_sections still applies (a
-- user can't read another user's chunks). Returns the top
-- `p_match_count` chunks by similarity (1 - cosine distance). The caller
-- supplies the already-embedded query vector — embedding the query is the
-- app's job (`embedText`), keeping this function pure SQL.
-- ---------------------------------------------------------------------------
create or replace function public.match_file_sections(
  p_file_id uuid,
  p_query_embedding vector(768),
  p_match_count int default 5
)
returns table (
  content text,
  similarity real
)
language sql
stable
security invoker
as $$
  select
    content,
    (1 - (embedding <=> p_query_embedding))::real as similarity
  from public.file_sections
  where file_id = p_file_id
    and embedding is not null
  order by embedding <=> p_query_embedding
  limit greatest(p_match_count, 1);
$$;

grant execute on function public.match_file_sections(uuid, vector, int) to authenticated;
