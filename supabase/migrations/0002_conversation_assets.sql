-- Conversation-scoped assets: per-conversation file uploads, assistant
-- artifacts, and user notes/bookmarks. The per-conversation editor
-- document lives on the conversations table (added in 0001).

create table if not exists conversation_files (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table if not exists artifacts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  kind text not null check (kind in ('code', 'markdown', 'image', 'table', 'json', 'other')),
  language text,
  title text,
  content text,
  storage_path text,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists notes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversation_files_conversation
  on conversation_files (conversation_id);

create index if not exists artifacts_conversation_created
  on artifacts (conversation_id, created_at desc);

create index if not exists notes_conversation_created
  on notes (conversation_id, created_at desc);
