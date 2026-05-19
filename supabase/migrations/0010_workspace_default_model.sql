-- Pinned default chat model per workspace.
--
-- When set, switching into a workspace auto-applies this model id (the
-- string form, e.g. 'anthropic/claude-sonnet-4-5'). NULL = no preference,
-- the user-global default applies.
--
-- Nullable; no backfill needed (existing rows just stay null).

alter table workspaces
  add column if not exists default_model text;
