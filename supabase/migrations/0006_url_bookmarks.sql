-- ---------------------------------------------------------------------------
-- URL bookmarks — saved web pages, third source type after files (0001 +
-- 0004) and MCP resources (0005). Same workspace-library +
-- conversation-private lane model. Content is fetched server-side by
-- `/api/url/fetch` at save time (and on manual refresh) and cached in
-- the row.
--
-- See `docs/PLAN-url-bookmarks.md` for the design rationale.
-- ---------------------------------------------------------------------------

create table public.url_bookmarks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  url text not null,
  title text not null,
  -- Extracted plain text, capped at 200 KB server-side. Empty string
  -- on tombstoned rows (content gets freed; metadata stub stays for
  -- historical message references).
  content text not null default '',
  content_truncated boolean not null default false,
  -- Short SHA-256 prefix; lets the UI detect "no changes since last
  -- fetch" without a full content comparison.
  content_hash text not null,
  description text,
  favicon_url text,
  fetched_at timestamptz not null default now(),
  -- Soft-delete marker (same pattern as files.deleted_at).
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Conversation-private lane (parallel to conversation_files and
-- conversation_mcp_resources).
create table public.conversation_url_bookmarks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  bookmark_id uuid not null references public.url_bookmarks(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (conversation_id, bookmark_id)
);

-- Mirror of `selected_file_ids` / `selected_mcp_resource_ids` — which
-- workspace bookmarks are ticked for this conversation.
alter table public.conversations
  add column selected_url_bookmark_ids uuid[] not null default '{}';

-- RLS — own your rows, same pattern as every other table.
alter table public.url_bookmarks enable row level security;
create policy "own url_bookmarks" on public.url_bookmarks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.conversation_url_bookmarks enable row level security;
create policy "own conversation_url_bookmarks" on public.conversation_url_bookmarks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Partial index — common query is "give me live (non-tombstoned)
-- bookmarks for this workspace, newest fetch first" for the Links tab.
create index url_bookmarks_workspace_live
  on public.url_bookmarks (workspace_id, fetched_at desc)
  where deleted_at is null;
create index conversation_url_bookmarks_conversation
  on public.conversation_url_bookmarks (conversation_id);
