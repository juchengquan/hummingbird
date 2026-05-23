-- Cross-device sync of `Message.generatedImages`.
--
-- PR #29 landed Supabase Storage uploads + signed URLs for images the
-- assistant produces via the `generateImage` skill, but the metadata
-- (URLs, dimensions, prompt, mode, storagePath) still lived only in
-- localStorage. A user who generated an image on one device couldn't
-- see it on another. The bytes were already durable in Storage; only
-- the message-row metadata needed catching up.
--
-- A single nullable JSONB column carries the `GeneratedImage[]` shape
-- defined in `lib/shared/types.ts`. Keeping it nullable + defaulting
-- to NULL (rather than `'[]'::jsonb`) preserves the existing posture
-- where the field is absent on regular messages — the diff in
-- `lib/client/sync/handlers.ts` only writes a value when the message
-- actually has generated images.
--
-- Idempotent: the column is added only if missing, so re-running the
-- migration after a partial apply is safe.

alter table messages
  add column if not exists generated_images jsonb;
