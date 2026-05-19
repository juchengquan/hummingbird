-- Hummingbird schema.
--
-- This file represents the entire current shape — there are no other
-- migrations to apply. To reset a project: drop schema public cascade;
-- create schema public; then run this file, 0002_rls_policies.sql, and
-- 0003_storage.sql in order.
--
-- All tables are owned by a Supabase Auth user via `user_id`. RLS lives
-- in 0002; the user-files Storage bucket lives in 0003.

-- ---------------------------------------------------------------------------
-- profiles — one row per auth.users row, auto-created via the trigger in
-- 0002. Holds anything you'd want to display in the UI that doesn't
-- belong on auth.users.
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- workspaces — top-level container. Carries the per-workspace defaults
-- the chat panel reads on workspace switch: system prompt, skill prefs,
-- pinned default model. `position` backs the drag-to-reorder UI.
-- ---------------------------------------------------------------------------
create table workspaces (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  -- Optional persona/style instructions prepended to every chat.
  system_prompt text,
  -- { skillId: boolean } overrides for the Skills cascade.
  skill_prefs jsonb not null default '{}'::jsonb,
  -- Pinned chat model id (e.g. 'anthropic/claude-sonnet-4-5'). Null =
  -- fall through to the app's DEFAULT_CHAT_MODEL.
  default_model text,
  -- User-defined ordering for the workspaces list. Integers, set by the
  -- drag-and-drop UI. Reconciled to sort on cloud read.
  position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- conversations — chats within a workspace. Each has its own editor
-- document, its own skill overrides on top of the workspace defaults,
-- and optional fork lineage pointing at the parent it was branched from.
-- ---------------------------------------------------------------------------
create table conversations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  pinned boolean not null default false,
  -- Workspace file IDs attached as context for the next message.
  selected_file_ids uuid[] not null default '{}',
  -- Per-conversation editor document (rich-text scratchpad).
  document_content text not null default '',
  document_updated_at timestamptz not null default now(),
  -- { skillId: boolean } overrides on top of workspace defaults.
  skill_prefs jsonb not null default '{}'::jsonb,
  -- Branch lineage for the Branches dialog. Both nullable: top-of-tree
  -- conversations leave them empty. `on delete set null` so a deleted
  -- ancestor doesn't cascade away the child.
  parent_id uuid references conversations(id) on delete set null,
  forked_from_message_id uuid, -- FK added after `messages` exists below
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- messages — chat turns. Carries the runtime metadata the sync layer
-- needs to round-trip: reasoning blob + duration, attached-file
-- snapshot, suggestion chips, error envelope, tool-call records.
-- ---------------------------------------------------------------------------
create table messages (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- Stable ordering within a conversation; the client computes it from
  -- array index at upsert time.
  position int not null,
  -- Reasoning tokens for models that emit them (DeepSeek R1, Claude
  -- thinking variants). Null when not applicable.
  reasoning text,
  -- Elapsed ms between the first and last reasoning chunk. Drives the
  -- "Thought for X.X s" badge in the collapsed ReasoningBlock.
  reasoning_duration_ms integer,
  -- Structured error envelope ({ code, status, model, detail }) when
  -- the assistant turn failed. Drives the inline ErrorBubble UI.
  error jsonb,
  -- Snapshot of which workspace files were attached when the message
  -- was sent. Lives on the message (not the conversation) so the
  -- visual record survives later selection changes.
  attached_file_ids uuid[] not null default '{}',
  -- Model-generated follow-up question chips.
  suggestions text[] not null default '{}',
  -- Durable record of tool invocations (web search, image gen, etc.).
  -- Replaces the markdown footer used pre-0008. Array of small records.
  tool_calls jsonb,
  created_at timestamptz not null default now()
);

-- Add the deferred FK from conversations.forked_from_message_id now
-- that messages exists.
alter table conversations
  add constraint conversations_forked_from_message_id_fkey
    foreign key (forked_from_message_id) references messages(id) on delete set null;

-- ---------------------------------------------------------------------------
-- files — uploaded blobs. Two storage paths: Supabase Storage
-- (storage_path) or an external URL (external_url, currently unused but
-- retained for legacy UploadThing rows). Extraction columns hold the
-- text the chat route injects into the system prompt.
-- ---------------------------------------------------------------------------
create table files (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  size bigint not null,
  type text not null,
  -- Path inside the `user-files` Storage bucket (see 0003) — e.g.
  -- `{user_id}/{file_id}.pdf`. Null when the file lives only in
  -- IndexedDB (local-files mode) or in UploadThing (legacy).
  storage_path text,
  external_url text,
  -- Lifecycle of the /api/extract pipeline.
  extraction_status text
    check (extraction_status in ('pending', 'done', 'failed', 'unsupported')),
  extracted_text text,
  extraction_truncated boolean not null default false,
  extracted_kind text,
  -- For image uploads: base64 data URL read client-side at upload time.
  -- Sent to vision-capable models as a multimodal content part. Can be
  -- multi-megabyte; budgeted by the client.
  image_data_url text,
  -- Auto-generated 2-3 sentence summary; populated when extraction
  -- yields enough content to summarise.
  summary text,
  key_topics text[] not null default '{}',
  uploaded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- resources — workspace ↔ file join. Lets a single file row be
-- attached to multiple workspaces without duplicating the blob.
-- ---------------------------------------------------------------------------
create table resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- artifacts — assistant-generated outputs the user chose to save.
-- Workspace-scoped: an artifact survives the conversation it was saved
-- from. `conversation_id` records provenance and clears via `on delete
-- set null` when the source goes away.
-- ---------------------------------------------------------------------------
create table artifacts (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  kind text not null check (kind in ('code', 'markdown', 'image', 'table', 'json', 'other')),
  language text,
  title text,
  content text,
  storage_path text,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- notes — user-authored snippets. Two flavours:
--   - free-form (message_id null): a workspace-level scratchpad
--   - bookmark (message_id set): points at a specific assistant message
-- Both survive conversation deletion at the workspace level; bookmarks
-- whose anchor message is gone are cleaned up app-side in
-- `deleteConversation` because the anchor no longer exists.
-- ---------------------------------------------------------------------------
create table notes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- shares — public read-only links for conversations or per-conversation
-- documents. The token is the capability: anyone with it can read the
-- pointed-to row. Anonymous reads happen via the service-role admin
-- client (see lib/supabase/admin.ts), so RLS on this table covers only
-- the owner CRUD path.
-- ---------------------------------------------------------------------------
create table shares (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('conversation', 'document')),
  conversation_id uuid not null references conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes — sized for the common read patterns the app issues.
-- ---------------------------------------------------------------------------
create index workspaces_user_position
  on workspaces (user_id, position);

create index conversations_user_workspace_updated
  on conversations (user_id, workspace_id, updated_at desc);

create index conversations_parent
  on conversations (parent_id);

create index messages_conversation_position
  on messages (conversation_id, position);

create index resources_workspace
  on resources (workspace_id);

create index artifacts_workspace_created
  on artifacts (workspace_id, created_at desc);

create index notes_workspace_created
  on notes (workspace_id, created_at desc);

create index shares_user_created
  on shares (user_id, created_at desc);

create index shares_conversation
  on shares (conversation_id);
