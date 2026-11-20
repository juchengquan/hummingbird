-- verify-supabase-types: skip (policies + a function body only; no column, table or public signature changes)
-- ---------------------------------------------------------------------------
-- RLS: foreign keys must point at the caller's own rows.
--
-- Every user-data policy so far checks only the row's OWN `user_id =
-- auth.uid()`. Foreign keys guarantee the referenced row exists, but not
-- whose it is, so a signed-in user talking straight to PostgREST (anon
-- key + own JWT) could write rows that hang off another user's data:
--
--   * shares.conversation_id / document_id → the service-role share
--     resolver published the victim's conversation/document at
--     /share/<kind>/<token> (the /api/share ownership check is bypassed by
--     going direct to PostgREST).
--   * messages.conversation_id → messages injected into the victim's
--     conversation, rendered on the victim's share page.
--   * file_sections.file_id → occupies unique(file_id, section_index),
--     breaking the victim's indexing; task_events.task_id likewise
--     squats unique(task_id, seq).
--   * agents.workspace_id → squats the victim's
--     unique(workspace_id, slug); tasks / task_jobs / task_schedules
--     reference the victim's conversation / task / workspace and are read
--     back by the service-role worker.
--
-- Fix: one RESTRICTIVE policy per (table, insert|update) whose WITH CHECK
-- requires every non-null FK to a user-owned table to resolve to a row
-- with `user_id = auth.uid()`. Restrictive policies AND with the existing
-- permissive "own ..." policies, which are left untouched — their names,
-- USING clauses and SELECT/DELETE behaviour do not change.
--
-- Why restrictive per-command policies instead of rewriting the existing
-- `for all` policies' WITH CHECK: a policy whose expression contains a
-- sub-select is flagged `hassublinks`, and a `for all` policy is also
-- applied to SELECTs — so `conversations.parent_id` (a self-reference)
-- would make the planner see the same relation recursively and raise
-- "infinite recursion detected in policy". Insert/update-only policies are
-- never applied to the SELECT inside the sub-select, so there is no cycle.
--
-- SELECT policies are not tightened: they already key on the row's own
-- `user_id`, so cross-user rows were only ever visible to their writer.
-- The leak was service-role readers that filter by FK alone (share
-- resolver, workers) — fixed here at write time and, for shares, also in
-- lib/server/share/resolve.ts (owner filter), which covers rows written
-- before this migration.
--
-- Not covered (not FKs): uuid[]/text[] id lists such as
-- conversations.selected_file_ids, messages.attached_file_ids,
-- agents.allowed_mcp_server_ids. Readers of those must keep resolving
-- them through RLS (user-scoped client) or an explicit owner filter.
--
-- Service-role / postgres-role writers (agent-py, agent-ts, admin client)
-- bypass RLS and are unaffected.
--
-- Idempotent: every policy is `drop policy if exists` + `create policy`;
-- functions use `create or replace`.
--
-- Pre-existing cross-user rows are NOT deleted. To audit, e.g.:
--   select s.token from shares s
--     left join conversations c on c.id = s.conversation_id
--     left join documents d on d.id = s.document_id
--    where coalesce(c.user_id, d.user_id) is distinct from s.user_id;
--   select m.id from messages m join conversations c on c.id = m.conversation_id
--    where m.user_id <> c.user_id;
-- ---------------------------------------------------------------------------

-- `(select auth.uid())` instead of bare `auth.uid()` lets Postgres
-- evaluate it once per statement (initPlan) instead of once per row.
--
-- Inside each sub-select the new row's column is written table-qualified
-- (`documents.workspace_id`, `tasks.parent_task_id`): an unqualified name
-- resolves to the INNER relation first when it has a same-named column
-- (e.g. tasks.parent_task_id inside `from public.tasks t`), silently
-- turning the check into a self-comparison.

-- ---------------------------------------------------------------------------
-- Helper for the one self-referencing FK written in multi-row batches.
--
-- `lib/client/sync/reconcile.ts` bulk-upserts all conversations in a
-- single INSERT, so a fork and its parent can arrive together. A WITH
-- CHECK sub-select runs under the statement's snapshot and cannot see
-- rows inserted earlier in the same statement, whereas the FK trigger
-- (end of statement) can. A plain "exists and is mine" check would
-- therefore reject a legitimate first upload. Instead we assert the
-- referenced row is NOT owned by someone else; the FK still guarantees
-- it exists, and a row inserted by this same statement already passed
-- the `user_id = auth.uid()` check itself.
--
-- SECURITY DEFINER so it can see other users' rows (RLS hides them from
-- the caller). Lives in a non-exposed schema so PostgREST does not
-- publish it as an RPC; it reveals no more than the FK error already
-- does (whether an id exists).
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.conversation_owned_by_other(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_id
      and c.user_id is distinct from auth.uid()
  );
$$;

revoke all on function private.conversation_owned_by_other(uuid) from public;
grant execute on function private.conversation_owned_by_other(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- documents.workspace_id
-- ---------------------------------------------------------------------------
drop policy if exists "documents: fk ownership (insert)" on public.documents;
create policy "documents: fk ownership (insert)" on public.documents
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = documents.workspace_id and w.user_id = (select auth.uid()))
  );
drop policy if exists "documents: fk ownership (update)" on public.documents;
create policy "documents: fk ownership (update)" on public.documents
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = documents.workspace_id and w.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- conversations.workspace_id, parent_id (self-ref, see helper above),
-- forked_from_message_id
-- ---------------------------------------------------------------------------
drop policy if exists "conversations: fk ownership (insert)" on public.conversations;
create policy "conversations: fk ownership (insert)" on public.conversations
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = conversations.workspace_id and w.user_id = (select auth.uid()))
    and (parent_id is null
         or not private.conversation_owned_by_other(parent_id))
    and (forked_from_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = conversations.forked_from_message_id
                      and m.user_id = (select auth.uid())))
  );
drop policy if exists "conversations: fk ownership (update)" on public.conversations;
create policy "conversations: fk ownership (update)" on public.conversations
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = conversations.workspace_id and w.user_id = (select auth.uid()))
    and (parent_id is null
         or not private.conversation_owned_by_other(parent_id))
    and (forked_from_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = conversations.forked_from_message_id
                      and m.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- messages.conversation_id
-- ---------------------------------------------------------------------------
drop policy if exists "messages: fk ownership (insert)" on public.messages;
create policy "messages: fk ownership (insert)" on public.messages
  as restrictive for insert to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
  );
drop policy if exists "messages: fk ownership (update)" on public.messages;
create policy "messages: fk ownership (update)" on public.messages
  as restrictive for update to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- resources.workspace_id, file_id
-- ---------------------------------------------------------------------------
drop policy if exists "resources: fk ownership (insert)" on public.resources;
create policy "resources: fk ownership (insert)" on public.resources
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = resources.workspace_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.files f
                where f.id = resources.file_id and f.user_id = (select auth.uid()))
  );
drop policy if exists "resources: fk ownership (update)" on public.resources;
create policy "resources: fk ownership (update)" on public.resources
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = resources.workspace_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.files f
                where f.id = resources.file_id and f.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- artifacts.workspace_id, conversation_id?, message_id?
-- ---------------------------------------------------------------------------
drop policy if exists "artifacts: fk ownership (insert)" on public.artifacts;
create policy "artifacts: fk ownership (insert)" on public.artifacts
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = artifacts.workspace_id and w.user_id = (select auth.uid()))
    and (conversation_id is null
         or exists (select 1 from public.conversations c
                    where c.id = artifacts.conversation_id and c.user_id = (select auth.uid())))
    and (message_id is null
         or exists (select 1 from public.messages m
                    where m.id = artifacts.message_id and m.user_id = (select auth.uid())))
  );
drop policy if exists "artifacts: fk ownership (update)" on public.artifacts;
create policy "artifacts: fk ownership (update)" on public.artifacts
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = artifacts.workspace_id and w.user_id = (select auth.uid()))
    and (conversation_id is null
         or exists (select 1 from public.conversations c
                    where c.id = artifacts.conversation_id and c.user_id = (select auth.uid())))
    and (message_id is null
         or exists (select 1 from public.messages m
                    where m.id = artifacts.message_id and m.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- notes.workspace_id, conversation_id?, message_id?
-- ---------------------------------------------------------------------------
drop policy if exists "notes: fk ownership (insert)" on public.notes;
create policy "notes: fk ownership (insert)" on public.notes
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = notes.workspace_id and w.user_id = (select auth.uid()))
    and (conversation_id is null
         or exists (select 1 from public.conversations c
                    where c.id = notes.conversation_id and c.user_id = (select auth.uid())))
    and (message_id is null
         or exists (select 1 from public.messages m
                    where m.id = notes.message_id and m.user_id = (select auth.uid())))
  );
drop policy if exists "notes: fk ownership (update)" on public.notes;
create policy "notes: fk ownership (update)" on public.notes
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = notes.workspace_id and w.user_id = (select auth.uid()))
    and (conversation_id is null
         or exists (select 1 from public.conversations c
                    where c.id = notes.conversation_id and c.user_id = (select auth.uid())))
    and (message_id is null
         or exists (select 1 from public.messages m
                    where m.id = notes.message_id and m.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- shares.conversation_id?, document_id?  (the publicly-resolved table)
-- ---------------------------------------------------------------------------
drop policy if exists "shares: fk ownership (insert)" on public.shares;
create policy "shares: fk ownership (insert)" on public.shares
  as restrictive for insert to public
  with check (
    (conversation_id is null
     or exists (select 1 from public.conversations c
                where c.id = shares.conversation_id and c.user_id = (select auth.uid())))
    and (document_id is null
         or exists (select 1 from public.documents d
                    where d.id = shares.document_id and d.user_id = (select auth.uid())))
  );
drop policy if exists "shares: fk ownership (update)" on public.shares;
create policy "shares: fk ownership (update)" on public.shares
  as restrictive for update to public
  with check (
    (conversation_id is null
     or exists (select 1 from public.conversations c
                where c.id = shares.conversation_id and c.user_id = (select auth.uid())))
    and (document_id is null
         or exists (select 1 from public.documents d
                    where d.id = shares.document_id and d.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- conversation_files.conversation_id, file_id
-- ---------------------------------------------------------------------------
drop policy if exists "conversation_files: fk ownership (insert)" on public.conversation_files;
create policy "conversation_files: fk ownership (insert)" on public.conversation_files
  as restrictive for insert to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_files.conversation_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.files f
                where f.id = conversation_files.file_id and f.user_id = (select auth.uid()))
  );
drop policy if exists "conversation_files: fk ownership (update)" on public.conversation_files;
create policy "conversation_files: fk ownership (update)" on public.conversation_files
  as restrictive for update to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_files.conversation_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.files f
                where f.id = conversation_files.file_id and f.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- mcp_servers.workspace_id
-- ---------------------------------------------------------------------------
drop policy if exists "mcp_servers: fk ownership (insert)" on public.mcp_servers;
create policy "mcp_servers: fk ownership (insert)" on public.mcp_servers
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = mcp_servers.workspace_id and w.user_id = (select auth.uid()))
  );
drop policy if exists "mcp_servers: fk ownership (update)" on public.mcp_servers;
create policy "mcp_servers: fk ownership (update)" on public.mcp_servers
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = mcp_servers.workspace_id and w.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- mcp_resources.workspace_id, server_id
-- ---------------------------------------------------------------------------
drop policy if exists "mcp_resources: fk ownership (insert)" on public.mcp_resources;
create policy "mcp_resources: fk ownership (insert)" on public.mcp_resources
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = mcp_resources.workspace_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.mcp_servers s
                where s.id = mcp_resources.server_id and s.user_id = (select auth.uid()))
  );
drop policy if exists "mcp_resources: fk ownership (update)" on public.mcp_resources;
create policy "mcp_resources: fk ownership (update)" on public.mcp_resources
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = mcp_resources.workspace_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.mcp_servers s
                where s.id = mcp_resources.server_id and s.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- mcp_resource_bindings.workspace_id, resource_id
-- ---------------------------------------------------------------------------
drop policy if exists "mcp_resource_bindings: fk ownership (insert)" on public.mcp_resource_bindings;
create policy "mcp_resource_bindings: fk ownership (insert)" on public.mcp_resource_bindings
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = mcp_resource_bindings.workspace_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.mcp_resources r
                where r.id = mcp_resource_bindings.resource_id and r.user_id = (select auth.uid()))
  );
drop policy if exists "mcp_resource_bindings: fk ownership (update)" on public.mcp_resource_bindings;
create policy "mcp_resource_bindings: fk ownership (update)" on public.mcp_resource_bindings
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = mcp_resource_bindings.workspace_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.mcp_resources r
                where r.id = mcp_resource_bindings.resource_id and r.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- conversation_mcp_resources.conversation_id, resource_id
-- ---------------------------------------------------------------------------
drop policy if exists "conversation_mcp_resources: fk ownership (insert)" on public.conversation_mcp_resources;
create policy "conversation_mcp_resources: fk ownership (insert)" on public.conversation_mcp_resources
  as restrictive for insert to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_mcp_resources.conversation_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.mcp_resources r
                where r.id = conversation_mcp_resources.resource_id and r.user_id = (select auth.uid()))
  );
drop policy if exists "conversation_mcp_resources: fk ownership (update)" on public.conversation_mcp_resources;
create policy "conversation_mcp_resources: fk ownership (update)" on public.conversation_mcp_resources
  as restrictive for update to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_mcp_resources.conversation_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.mcp_resources r
                where r.id = conversation_mcp_resources.resource_id and r.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- url_bookmarks.workspace_id
-- ---------------------------------------------------------------------------
drop policy if exists "url_bookmarks: fk ownership (insert)" on public.url_bookmarks;
create policy "url_bookmarks: fk ownership (insert)" on public.url_bookmarks
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = url_bookmarks.workspace_id and w.user_id = (select auth.uid()))
  );
drop policy if exists "url_bookmarks: fk ownership (update)" on public.url_bookmarks;
create policy "url_bookmarks: fk ownership (update)" on public.url_bookmarks
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = url_bookmarks.workspace_id and w.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- conversation_url_bookmarks.conversation_id, bookmark_id
-- ---------------------------------------------------------------------------
drop policy if exists "conversation_url_bookmarks: fk ownership (insert)" on public.conversation_url_bookmarks;
create policy "conversation_url_bookmarks: fk ownership (insert)" on public.conversation_url_bookmarks
  as restrictive for insert to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_url_bookmarks.conversation_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.url_bookmarks b
                where b.id = conversation_url_bookmarks.bookmark_id and b.user_id = (select auth.uid()))
  );
drop policy if exists "conversation_url_bookmarks: fk ownership (update)" on public.conversation_url_bookmarks;
create policy "conversation_url_bookmarks: fk ownership (update)" on public.conversation_url_bookmarks
  as restrictive for update to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = conversation_url_bookmarks.conversation_id and c.user_id = (select auth.uid()))
    and exists (select 1 from public.url_bookmarks b
                where b.id = conversation_url_bookmarks.bookmark_id and b.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- prompts.workspace_id? (0017 — null = account-global prompt)
-- ---------------------------------------------------------------------------
drop policy if exists "prompts: fk ownership (insert)" on public.prompts;
create policy "prompts: fk ownership (insert)" on public.prompts
  as restrictive for insert to public
  with check (
    workspace_id is null
    or exists (select 1 from public.workspaces w
               where w.id = prompts.workspace_id and w.user_id = (select auth.uid()))
  );
drop policy if exists "prompts: fk ownership (update)" on public.prompts;
create policy "prompts: fk ownership (update)" on public.prompts
  as restrictive for update to public
  with check (
    workspace_id is null
    or exists (select 1 from public.workspaces w
               where w.id = prompts.workspace_id and w.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- tasks.conversation_id, result_message_id?, parent_task_id? (0028)
--
-- parent_task_id is self-referencing, but tasks are inserted one row per
-- statement (lib/server/agent/store.ts) and child tasks are created after
-- their parent, so a plain "exists and is mine" check is safe here.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks: fk ownership (insert)" on public.tasks;
create policy "tasks: fk ownership (insert)" on public.tasks
  as restrictive for insert to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = tasks.conversation_id and c.user_id = (select auth.uid()))
    and (result_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = tasks.result_message_id and m.user_id = (select auth.uid())))
    and (parent_task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = tasks.parent_task_id and t.user_id = (select auth.uid())))
  );
drop policy if exists "tasks: fk ownership (update)" on public.tasks;
create policy "tasks: fk ownership (update)" on public.tasks
  as restrictive for update to public
  with check (
    exists (select 1 from public.conversations c
            where c.id = tasks.conversation_id and c.user_id = (select auth.uid()))
    and (result_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = tasks.result_message_id and m.user_id = (select auth.uid())))
    and (parent_task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = tasks.parent_task_id and t.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- task_events.task_id (insert-only table for users)
-- ---------------------------------------------------------------------------
drop policy if exists "task_events: fk ownership (insert)" on public.task_events;
create policy "task_events: fk ownership (insert)" on public.task_events
  as restrictive for insert to public
  with check (
    exists (select 1 from public.tasks t
            where t.id = task_events.task_id and t.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- task_jobs.task_id (insert-only table for users; enqueued by the Next
-- route with the caller's JWT client)
-- ---------------------------------------------------------------------------
drop policy if exists "task_jobs: fk ownership (insert)" on public.task_jobs;
create policy "task_jobs: fk ownership (insert)" on public.task_jobs
  as restrictive for insert to public
  with check (
    exists (select 1 from public.tasks t
            where t.id = task_jobs.task_id and t.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- project_tasks.workspace_id, task_id?, artifact_id?
-- ---------------------------------------------------------------------------
drop policy if exists "project_tasks: fk ownership (insert)" on public.project_tasks;
create policy "project_tasks: fk ownership (insert)" on public.project_tasks
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = project_tasks.workspace_id and w.user_id = (select auth.uid()))
    and (task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = project_tasks.task_id and t.user_id = (select auth.uid())))
    and (artifact_id is null
         or exists (select 1 from public.artifacts a
                    where a.id = project_tasks.artifact_id and a.user_id = (select auth.uid())))
  );
drop policy if exists "project_tasks: fk ownership (update)" on public.project_tasks;
create policy "project_tasks: fk ownership (update)" on public.project_tasks
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = project_tasks.workspace_id and w.user_id = (select auth.uid()))
    and (task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = project_tasks.task_id and t.user_id = (select auth.uid())))
    and (artifact_id is null
         or exists (select 1 from public.artifacts a
                    where a.id = project_tasks.artifact_id and a.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- task_schedules.workspace_id, last_run_task_id?
-- ---------------------------------------------------------------------------
drop policy if exists "task_schedules: fk ownership (insert)" on public.task_schedules;
create policy "task_schedules: fk ownership (insert)" on public.task_schedules
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = task_schedules.workspace_id and w.user_id = (select auth.uid()))
    and (last_run_task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = task_schedules.last_run_task_id and t.user_id = (select auth.uid())))
  );
drop policy if exists "task_schedules: fk ownership (update)" on public.task_schedules;
create policy "task_schedules: fk ownership (update)" on public.task_schedules
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = task_schedules.workspace_id and w.user_id = (select auth.uid()))
    and (last_run_task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = task_schedules.last_run_task_id and t.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- agents.workspace_id
-- ---------------------------------------------------------------------------
drop policy if exists "agents: fk ownership (insert)" on public.agents;
create policy "agents: fk ownership (insert)" on public.agents
  as restrictive for insert to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = agents.workspace_id and w.user_id = (select auth.uid()))
  );
drop policy if exists "agents: fk ownership (update)" on public.agents;
create policy "agents: fk ownership (update)" on public.agents
  as restrictive for update to public
  with check (
    exists (select 1 from public.workspaces w
            where w.id = agents.workspace_id and w.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- file_sections.file_id
-- ---------------------------------------------------------------------------
drop policy if exists "file_sections: fk ownership (insert)" on public.file_sections;
create policy "file_sections: fk ownership (insert)" on public.file_sections
  as restrictive for insert to public
  with check (
    exists (select 1 from public.files f
            where f.id = file_sections.file_id and f.user_id = (select auth.uid()))
  );
drop policy if exists "file_sections: fk ownership (update)" on public.file_sections;
create policy "file_sections: fk ownership (update)" on public.file_sections
  as restrictive for update to public
  with check (
    exists (select 1 from public.files f
            where f.id = file_sections.file_id and f.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- user_memories.source_conversation_id?, source_message_id?
-- ---------------------------------------------------------------------------
drop policy if exists "user_memories: fk ownership (insert)" on public.user_memories;
create policy "user_memories: fk ownership (insert)" on public.user_memories
  as restrictive for insert to public
  with check (
    (source_conversation_id is null
     or exists (select 1 from public.conversations c
                where c.id = user_memories.source_conversation_id and c.user_id = (select auth.uid())))
    and (source_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = user_memories.source_message_id and m.user_id = (select auth.uid())))
  );
drop policy if exists "user_memories: fk ownership (update)" on public.user_memories;
create policy "user_memories: fk ownership (update)" on public.user_memories
  as restrictive for update to public
  with check (
    (source_conversation_id is null
     or exists (select 1 from public.conversations c
                where c.id = user_memories.source_conversation_id and c.user_id = (select auth.uid())))
    and (source_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = user_memories.source_message_id and m.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- mcp_upsert_server_with_credentials (0024) — two fixes, same signature,
-- same grants:
--
--   1. The function is SECURITY DEFINER (runs as the table owner, so RLS
--      and the policies above do not apply). It never checked that
--      p_workspace_id belongs to the caller, letting a user attach a
--      server row to someone else's workspace. Now refused up front.
--   2. ON CONFLICT never set credential_mode='cloud' nor cleared
--      credential_fingerprint, so promoting an existing 'local' row
--      (lib/server/mcp/credentials.ts upsertServerWithCredential) wrote
--      credentials_encrypted onto a local-mode row and violated
--      `mcp_servers_cred_shape`. The update branch now flips the row to
--      cloud shape atomically.
-- ---------------------------------------------------------------------------
create or replace function public.mcp_upsert_server_with_credentials(
  p_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_url text,
  p_credentials jsonb,
  p_key text,
  p_capabilities jsonb default null,
  p_enabled boolean default true,
  p_requires_approval boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.workspaces w
    where w.id = p_workspace_id and w.user_id = auth.uid()
  ) then
    raise exception 'workspace not found' using errcode = '42501';
  end if;

  insert into public.mcp_servers (
    id, user_id, workspace_id, name, url, transport,
    credential_mode, credentials_encrypted,
    capabilities, capabilities_fetched_at, enabled, requires_approval,
    created_at, updated_at
  )
  values (
    p_id, auth.uid(), p_workspace_id, p_name, p_url, 'http',
    'cloud', pgp_sym_encrypt(p_credentials::text, p_key),
    p_capabilities,
    case when p_capabilities is null then null else now() end,
    p_enabled, p_requires_approval,
    now(), now()
  )
  on conflict (id) do update set
    workspace_id = excluded.workspace_id,
    name = excluded.name,
    url = excluded.url,
    credential_mode = 'cloud',
    credential_fingerprint = null,
    credentials_encrypted = pgp_sym_encrypt(p_credentials::text, p_key),
    capabilities = coalesce(excluded.capabilities, public.mcp_servers.capabilities),
    capabilities_fetched_at = case
      when excluded.capabilities is null then public.mcp_servers.capabilities_fetched_at
      else now()
    end,
    enabled = excluded.enabled,
    requires_approval = excluded.requires_approval,
    updated_at = now()
  where public.mcp_servers.user_id = auth.uid();
end;
$$;

revoke all on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) from public;
grant execute on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) to authenticated;
