-- verify-supabase-types: skip (constraint validation only; no schema change)
-- 0037_validate_artifacts_kind_check.sql — second half of 0033's check.
--
-- 0033 now adds `artifacts_kind_check` as NOT VALID so the ALTER that
-- holds ACCESS EXCLUSIVE on `artifacts` doesn't also scan the table.
-- This validates the existing rows under SHARE UPDATE EXCLUSIVE, which
-- doesn't block reads or writes. It lives in its own file because each
-- migration runs in a single transaction: validating inside 0033 would
-- still scan under 0033's ACCESS EXCLUSIVE lock.
--
-- Databases that applied the earlier 0033 (plain ADD CONSTRAINT, already
-- validated) are unaffected — validating a valid constraint is a no-op.
-- Idempotent for the same reason.

alter table public.artifacts
  validate constraint artifacts_kind_check;
