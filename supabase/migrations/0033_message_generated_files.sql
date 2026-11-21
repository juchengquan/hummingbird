-- Cross-device sync of `Message.generatedFiles` + the `file` artifact kind.
--
-- The `runCode` code interpreter can now write deliverable files to
-- `/tmp/outputs/`; the server persists the bytes to Storage (mirroring
-- generated images) and the metadata rides on the message row. A single
-- nullable JSONB column carries the `GeneratedFile[]` shape from
-- `lib/shared/types.ts`. Kept nullable + defaulting to NULL (not
-- '[]'::jsonb) to match `0010_message_generated_images.sql` — the sync
-- diff only writes a value when the message actually has files.
--
-- Also widens the `artifacts.kind` check to admit the new 'file' kind so
-- a generated file can be auto-saved as a workspace artifact.
--
-- Idempotent: column add is guarded; the constraint is dropped-if-exists
-- before recreate.
--
-- Renamed from `0018_message_generated_files.sql`, which collided with
-- `0018_realtime_task_events.sql` (the Supabase CLI keys
-- `supabase_migrations.schema_migrations` by the numeric prefix, so two
-- `0018`s abort `supabase db reset` / `start` with a duplicate-key error
-- and make `migration up` treat this file as already applied). It has no
-- ordering dependency on 0019-0031 and is fully idempotent, so moving it
-- to the end is safe and re-running it on a DB that already has it is a
-- no-op. See docs/SUPABASE_SETUP.md "Migration 0018 collision".

alter table messages
  add column if not exists generated_files jsonb;

alter table artifacts
  drop constraint if exists artifacts_kind_check;

-- NOT VALID: the add only records the constraint (new/updated rows are
-- checked from here on) instead of scanning every artifact while holding
-- the ACCESS EXCLUSIVE lock the ALTER takes. The scan of existing rows
-- happens in 0037 (`VALIDATE CONSTRAINT`, SHARE UPDATE EXCLUSIVE —
-- reads and writes keep flowing). It has to be a separate file: each
-- migration runs in one transaction, so a VALIDATE here would still run
-- under this file's ACCESS EXCLUSIVE lock. Every existing kind is in the
-- new (wider) list, so validation cannot fail.
alter table artifacts
  add constraint artifacts_kind_check
  check (kind in ('code', 'markdown', 'image', 'table', 'json', 'file', 'other'))
  not valid;
