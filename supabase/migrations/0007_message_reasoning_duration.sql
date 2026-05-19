-- Per-message reasoning duration.
--
-- Captures elapsed wall-clock between the first and last reasoning chunk
-- so the "Thought for X.Xs" badge in the collapsed ReasoningBlock header
-- survives reload. Component-local state alone disappears on refresh.
--
-- nullable: messages without reasoning don't get a value; messages from
-- before this migration land null and the UI hides the badge.

alter table messages
  add column if not exists reasoning_duration_ms integer;
