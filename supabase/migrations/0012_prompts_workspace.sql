-- Add workspace_id to the prompts table (0011 created it without).
-- Prompts are now workspace-scoped like conversations and documents;
-- switching workspaces in the sidebar shows only that workspace's prompts.
alter table prompts add column if not exists workspace_id uuid references workspaces(id) on delete cascade;

-- Best-effort backfill: assign existing prompts to the user's first
-- workspace. New prompts are always created with workspace_id by the
-- client, so this only covers rows from before this migration.
update prompts set workspace_id = sub.ws_id
from (
  select distinct on (p.user_id)
    p.id as prompt_id,
    w.id as ws_id
  from prompts p
  join workspaces w on w.user_id = p.user_id
  order by p.user_id, w.created_at
) sub
where prompts.id = sub.prompt_id
  and prompts.workspace_id is null;

alter table prompts alter column workspace_id set not null;

create index if not exists prompts_workspace_updated_idx
  on prompts (workspace_id, updated_at desc);
