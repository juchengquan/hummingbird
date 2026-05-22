-- Compressed older messages — a context-window relief valve.
--
-- When a chat approaches the model's context window, the user can
-- click "Compress older messages" in the chat header. The app runs
-- a one-shot summarize call against the oldest ~60% of the
-- conversation, inserts a synthetic recap message in their place,
-- and marks the originals as `compressed`. The chat request builder
-- skips compressed messages — they stay on disk + visible in the UI
-- (collapsed) but don't replay to the model. Fully reversible: clicking
-- "Undo" on the recap card flips both flags back.
--
-- Three new columns are added to `messages` to support this:
--
--   - `compressed` — when true, the message is excluded from the next
--     chat API call. Defaults to false; legacy rows stay un-compressed.
--   - `kind` — null for regular messages; 'recap' for the synthetic
--     summary inserted in their place. Other values are reserved.
--   - `recap_message_ids` — only meaningful for `kind = 'recap'`
--     rows; lists the original message ids the recap replaced so
--     Undo knows which messages to un-flag. Empty array otherwise.
--
-- Idempotent: each column is added only if missing.

alter table messages
  add column if not exists compressed boolean not null default false;

alter table messages
  add column if not exists kind text;

alter table messages
  add column if not exists recap_message_ids uuid[] not null default '{}';
