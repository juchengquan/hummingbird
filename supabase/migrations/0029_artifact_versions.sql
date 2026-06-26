-- Artifact version history (capped, inline).
--
-- `updateArtifactContent` now snapshots the prior content into
-- `Artifact.versions` (capped at MAX_ARTIFACT_VERSIONS). A single nullable
-- JSONB column carries the `ArtifactVersion[]` shape from
-- `lib/shared/types.ts`. Nullable + default NULL (not '[]') so pre-existing
-- rows stay absent until first edited — the sync diff only writes a value
-- when the artifact actually has versions. Mirrors
-- `0018_message_generated_files.sql`.
--
-- Idempotent: column added only if missing.

alter table artifacts
  add column if not exists versions jsonb;
