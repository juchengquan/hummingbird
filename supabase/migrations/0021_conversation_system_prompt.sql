-- 0021_conversation_system_prompt.sql
--
-- Adds the missing **conversation** tier to the chat-send cascade.
-- `lib/shared/agents/resolve.ts` documents the layering as:
--
--   workspace
--     → conversation       <- this column closes the gap
--     → active persona
--     → per-turn forced
--     → per-turn muted
--
-- Both workspace.system_prompt (workspaces table) and agents.system_prompt
-- (agents table, migration 0020) already exist. This adds the
-- per-conversation slot. See docs/PLAN-conversation-system-prompt.md.
--
-- Idempotent: `if not exists` on the column.
-- No backfill — the empty default reproduces today's behaviour
-- (composeSystemPrompts trims empties out).

alter table conversations
  add column if not exists system_prompt text not null default '';

-- No new RLS policy — the existing per-user policies on `conversations`
-- already gate read/write access.
