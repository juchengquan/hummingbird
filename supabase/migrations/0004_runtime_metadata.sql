-- Runtime metadata fields that the local TS types carried but 0001/0002
-- didn't have columns for. Without these the sync layer drops the fields
-- on write, so refresh / cross-device loses reasoning blobs, file
-- extraction state, per-message attachment snapshots, and per-workspace
-- system prompts.
--
-- All adds are idempotent (`if not exists`) and back-compatible (existing
-- rows pick up the defaults). No data backfill is needed; values populate
-- on the next mutation.

-- messages: assistant reasoning, error envelope, attached-file snapshot,
-- suggestion chips.
alter table messages
  add column if not exists reasoning text,
  add column if not exists error jsonb,
  add column if not exists attached_file_ids uuid[] not null default '{}',
  add column if not exists suggestions text[] not null default '{}';

-- files: extraction pipeline state + image data URL + auto-summary.
-- Note: `image_data_url` can be a multi-megabyte base64 string. This is
-- a deliberate intermediate step; Phase 2 of the sync plan moves binary
-- blobs to Supabase Storage and references them by `storage_path`.
alter table files
  add column if not exists extraction_status text
    check (extraction_status in ('pending', 'done', 'failed', 'unsupported')),
  add column if not exists extracted_text text,
  add column if not exists extraction_truncated boolean not null default false,
  add column if not exists extracted_kind text,
  add column if not exists image_data_url text,
  add column if not exists summary text,
  add column if not exists key_topics text[] not null default '{}';

-- workspaces: optional per-workspace system prompt prepended to every
-- chat in the workspace.
alter table workspaces
  add column if not exists system_prompt text;
