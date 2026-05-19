-- Per-workspace and per-conversation skill preferences.
--
-- A "skill" is a model capability the user opts into per chat — e.g. web
-- search, image generation, code execution. Each skill has a stable
-- string id; this column stores a flat JSONB map of those ids to on/off.
--
-- Cascade (resolved in app code):
--   conversation.skill_prefs[id] ?? workspace.skill_prefs[id] ?? skill.default
--
-- JSONB instead of a join table because the skill list is short, evolves
-- frequently, and we want to add a new skill without a migration.

alter table workspaces
  add column if not exists skill_prefs jsonb not null default '{}'::jsonb;

alter table conversations
  add column if not exists skill_prefs jsonb not null default '{}'::jsonb;
