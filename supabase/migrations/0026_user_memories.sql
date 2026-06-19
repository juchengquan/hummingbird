-- Cross-conversation memory: distilled, user-editable facts (embedding-free).
create table user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact text not null,
  category text,
  source_conversation_id uuid references conversations(id) on delete set null,
  source_message_id uuid references messages(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_memories enable row level security;
create policy "own memories" on user_memories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index user_memories_user_status_idx on user_memories (user_id, status);

alter table profiles
  add column if not exists memory_enabled boolean not null default false;
