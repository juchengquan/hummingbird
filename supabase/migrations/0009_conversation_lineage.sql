-- Conversation lineage for the branch tree view.
--
-- When the user clicks "Branch from here" on an assistant message, the
-- fork operation today creates a copy of the conversation but throws
-- away the parent-child relationship. These columns record it so the
-- branches dialog can render a tree.
--
-- Both columns are nullable: top-of-tree conversations (not forked from
-- anything) leave them empty. The `on delete set null` on parent_id
-- keeps the child reachable as its own root if the parent is deleted —
-- the tree breaks rather than the child cascading away.

alter table conversations
  add column if not exists parent_id uuid references conversations(id) on delete set null,
  add column if not exists forked_from_message_id uuid references messages(id) on delete set null;

create index if not exists conversations_parent on conversations (parent_id);
