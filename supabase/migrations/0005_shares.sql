-- Public share links for conversations and per-conversation documents.
--
-- Two share kinds:
--   conversation  → renders the message history read-only.
--   document      → renders conversations.document_content read-only.
--
-- Both kinds live in one row pointing at a conversation_id; readers
-- dereference the message list or the document column based on `kind`.
-- Tokens are URL-safe base64url (set client-side so we don't need a
-- service-role roundtrip to mint them).
--
-- Anonymous reads happen via a server-side route that uses the service
-- role key (bypasses RLS, but reads only the row matched by token). The
-- RLS policies on this table therefore cover only the owner CRUD path.

create table if not exists shares (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('conversation', 'document')),
  conversation_id uuid not null references conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists shares_user_created on shares (user_id, created_at desc);
create index if not exists shares_conversation on shares (conversation_id);

alter table shares enable row level security;

drop policy if exists "own shares" on shares;
create policy "own shares" on shares
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
