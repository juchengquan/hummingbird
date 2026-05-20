-- ---------------------------------------------------------------------------
-- Conversation-private file attachments + file soft-delete (tombstone)
--
-- Two related concerns shipped together:
--
-- 1. `conversation_files` join — parallel to `resources` but scoped to a
--    single conversation. Lets a file be attached privately to one chat
--    without polluting the workspace library. The client merges the two
--    lanes (resources ticked via `conversations.selected_file_ids` +
--    conversation_files) and de-dupes by file_id when sending to the
--    chat API.
--
-- 2. `files.deleted_at` — soft-delete column. Removing a file flips this
--    timestamp instead of dropping the row, so durable references
--    (message.attached_file_ids today; future structured citations,
--    notes anchored to a specific attachment) can resolve to a "removed"
--    label instead of dangling. The content-ish columns
--    (extracted_text, image_data_url, storage_path) are nulled at
--    tombstone time and the metadata stub (id/name/size/type) is kept.
-- ---------------------------------------------------------------------------

create table conversation_files (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  added_at timestamptz not null default now()
);

create index conversation_files_conversation
  on conversation_files (conversation_id);

create index conversation_files_user
  on conversation_files (user_id);

-- Same RLS pattern as every other table in this schema — own your rows.
alter table conversation_files enable row level security;

create policy "own conversation_files" on conversation_files
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Soft-delete column on files. Null = live; non-null = tombstoned.
-- Render code on the client filters `deleted_at IS NULL` for any
-- listing surface (workspace library, conversation panel, chat-route
-- payload); historical references render a "removed" label.
alter table files
  add column deleted_at timestamptz;

-- Partial index makes "give me live files" cheap without slowing the
-- common path.
create index files_live
  on files (user_id, uploaded_at desc)
  where deleted_at is null;
