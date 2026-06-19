-- verify-supabase-types: skip
-- (FK on-delete change only — alters no table/column shape, so the
--  generated `lib/shared/supabase/types.ts` is unaffected. Opt-out per
--  scripts/verify-supabase-types.sh, same class as an index/RLS/grant change.)
-- Memory decay: when a conversation is deleted, purge the facts extracted
-- from it. (source_message_id stays SET NULL — editing/regenerating one
-- message must not drop a still-valid fact.)
alter table user_memories
  drop constraint user_memories_source_conversation_id_fkey;
alter table user_memories
  add constraint user_memories_source_conversation_id_fkey
  foreign key (source_conversation_id) references conversations(id) on delete cascade;
