-- 0044_message_turn_persona.sql — the persona a user message was sent as.
--
-- docs/PLAN-frontend-backend-split.md Q52: Regenerate, Edit, Retry and a
-- UI card's answer send a turn again as its persona, with the MCP
-- allow-list recorded here as the ceiling. This column syncs that record
-- across devices: {"agentId": "...", "allowedMcpServerIds": ["..."]},
-- null for a turn without a persona.
--
-- No FK: personas aren't synced (the id may exist on one device only),
-- and the list must outlive a deleted persona. The table's RLS covers
-- the column. Idempotent.

alter table public.messages
  add column if not exists turn_persona jsonb;

comment on column public.messages.turn_persona is
  'The persona a user message was sent as: {agentId, allowedMcpServerIds}. Null = none.';

-- PostgREST refuses an upsert naming a column its schema cache lacks.
notify pgrst, 'reload schema';
