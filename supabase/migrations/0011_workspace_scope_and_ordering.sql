-- Promotes notes + artifacts from conversation-scope to workspace-scope,
-- and adds an explicit ordering column on workspaces to back the
-- drag-to-reorder feature.
--
-- Schema changes
--
-- 1. `notes.workspace_id` + `artifacts.workspace_id`
--    Required (not null). The previous schema rooted these at a
--    conversation; orphaning meant the row was destroyed. Now they
--    survive conversation deletion at the workspace level.
--
-- 2. `notes.conversation_id` + `artifacts.conversation_id` become
--    nullable. When the source conversation is deleted, the cascade
--    no longer kills the row — it sets the column to null
--    (handled at the FK level). For notes carrying a `message_id`
--    (bookmarks) the row IS deleted because the anchor message is
--    gone; this is enforced in app code (`deleteConversation` keeps
--    bookmarks-with-message_id out of the surviving set).
--
-- 3. `workspaces.position` — integer ordering set client-side via the
--    drag-to-reorder UI. Reconciled to sort the workspaces list on
--    cross-device load. Backfill is `row_number() over (created_at)`
--    per user so existing rows pick a stable initial order.
--
-- All adds are idempotent.

-- workspaces.position
alter table workspaces
  add column if not exists position integer;

-- Backfill: row_number per user over created_at. Only runs for rows
-- where position is still null so re-running is a no-op.
with ordered as (
  select id, row_number() over (partition by user_id order by created_at) - 1 as idx
  from workspaces
)
update workspaces w
  set position = ordered.idx
  from ordered
  where w.id = ordered.id and w.position is null;

-- notes.workspace_id
alter table notes
  add column if not exists workspace_id uuid references workspaces(id) on delete cascade;

-- artifacts.workspace_id
alter table artifacts
  add column if not exists workspace_id uuid references workspaces(id) on delete cascade;

-- Backfill workspace_id from the parent conversation. Only for rows
-- where workspace_id is still null; re-runs are a no-op.
update notes n
  set workspace_id = c.workspace_id
  from conversations c
  where n.conversation_id = c.id and n.workspace_id is null;

update artifacts a
  set workspace_id = c.workspace_id
  from conversations c
  where a.conversation_id = c.id and a.workspace_id is null;

-- Switch conversation_id from `not null + on delete cascade` to
-- `nullable + on delete set null`. Bookmarks (notes with a non-null
-- message_id) still get cleaned up app-side because the anchor
-- message is gone; free-form notes and all artifacts become orphans
-- that surface at the workspace level via the new workspace_id.
--
-- ALTER TABLE doesn't expose a "change FK action" shortcut — drop and
-- re-add. Constraint names follow the postgres default
-- `{table}_{column}_fkey`.
alter table notes
  drop constraint if exists notes_conversation_id_fkey,
  alter column conversation_id drop not null,
  add constraint notes_conversation_id_fkey
    foreign key (conversation_id) references conversations(id) on delete set null;

alter table artifacts
  drop constraint if exists artifacts_conversation_id_fkey,
  alter column conversation_id drop not null,
  add constraint artifacts_conversation_id_fkey
    foreign key (conversation_id) references conversations(id) on delete set null;

-- Indexes for the new workspace-scope reads.
create index if not exists notes_workspace_created
  on notes (workspace_id, created_at desc);

create index if not exists artifacts_workspace_created
  on artifacts (workspace_id, created_at desc);

create index if not exists workspaces_user_position
  on workspaces (user_id, position);
