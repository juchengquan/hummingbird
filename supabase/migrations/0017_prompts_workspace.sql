-- verify-supabase-types: skip
-- (Backfill-only fix to an existing migration — the final schema shape,
-- and therefore the generated types, is unchanged.)
--
-- Add workspace_id to the prompts table (0011 created it without).
-- Prompts are now workspace-scoped like conversations and documents;
-- switching workspaces in the sidebar shows only that workspace's prompts.
alter table prompts add column if not exists workspace_id uuid references workspaces(id) on delete cascade;

-- Backfill existing prompts (rows from before this migration — new
-- prompts are always created with workspace_id by the client) so the
-- `set not null` below can't fail on a replay over existing data.
--
-- Step 1: a user who owns workspace-less prompts but has NO workspace at
-- all gets one new workspace named 'Prompts' to hold them. We create
-- rather than delete: a migration should never silently destroy user
-- data, and an extra (renamable, deletable) workspace is the least
-- surprising outcome. Normal accounts always have a workspace, so this
-- branch only catches edge cases (e.g. every workspace deleted while
-- prompts were still user-scoped). No-op once every prompt is assigned,
-- so re-running is harmless.
insert into workspaces (id, user_id, name)
select gen_random_uuid(), orphan.user_id, 'Prompts'
from (
  select distinct p.user_id
  from prompts p
  where p.workspace_id is null
    and not exists (select 1 from workspaces w where w.user_id = p.user_id)
) orphan;

-- Step 2: assign EVERY unassigned prompt to its owner's earliest
-- workspace (ties broken by id so the choice is deterministic). The
-- original version used `distinct on (p.user_id)`, which backfilled only
-- one prompt per user and made the `set not null` fail for anyone with
-- two or more prompts. Only touches rows still null → idempotent.
update prompts p
set workspace_id = (
  select w.id
  from workspaces w
  where w.user_id = p.user_id
  order by w.created_at, w.id
  limit 1
)
where p.workspace_id is null;

alter table prompts alter column workspace_id set not null;

create index if not exists prompts_workspace_updated_idx
  on prompts (workspace_id, updated_at desc);
