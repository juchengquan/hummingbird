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

alter table messages
  add column if not exists generated_files jsonb;

alter table artifacts
  drop constraint if exists artifacts_kind_check;

alter table artifacts
  add constraint artifacts_kind_check
  check (kind in ('code', 'markdown', 'image', 'table', 'json', 'file', 'other'));
