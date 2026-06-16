-- Account-level custom instructions — cross-device cloud sync.
--
-- Two singleton free-text settings stored on the user's own profile row.
-- profiles already has own-row RLS ("own profile": id = auth.uid()), so
-- the existing policy covers select/update of these columns — no new
-- policy needed. Additive + idempotent so re-running is safe.

alter table profiles
  add column if not exists custom_instructions_about text not null default '',
  add column if not exists custom_instructions_style text not null default '';
