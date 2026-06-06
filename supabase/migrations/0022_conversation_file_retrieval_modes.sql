-- 0022_conversation_file_retrieval_modes.sql
--
-- Per-attached-file retrieval mode for the conversation. Today every
-- attached file's extracted text is inlined into the chat system
-- prompt (subject to a per-file + total budget). For large files
-- that's wasteful — the file ends up at the front of every turn even
-- when the model only needs a small slice. The `searchFiles` skill
-- already retrieves from the same files; this column lets a user
-- mark specific attachments as "retrieve via searchFiles only, don't
-- inline."
--
-- Shape: `jsonb` map keyed by file id, values are the literal string
-- "rag" (only non-default mode worth storing). Absence of a key means
-- the file is inlined as today — preserves backward behaviour without
-- a backfill.
--
-- See docs/PLAN-cross-product-inspirations.md item #6 (the per-attach
-- toggle half).

alter table conversations
  add column if not exists file_retrieval_modes jsonb not null default '{}'::jsonb;

-- Defensive: a malformed override gets stripped at the client/sync
-- boundary, but pin the column to objects so a non-object literal
-- (`'null'`, `'[1,2,3]'`) can't slip in.
alter table conversations
  add constraint conversations_file_retrieval_modes_object
    check (jsonb_typeof(file_retrieval_modes) = 'object');

-- No new RLS policy — the existing per-user policies on `conversations`
-- already gate read/write access.
