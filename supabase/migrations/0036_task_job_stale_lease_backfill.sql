-- verify-supabase-types: skip (data fix only; no schema change)
-- 0036_task_job_stale_lease_backfill.sql — undo 0032's over-eager backfill.
--
-- The first version of 0032 gave EVERY job stranded `running` a lease of
-- `coalesce(started_at, updated_at) + 10 minutes`, so jobs dead for days
-- or weeks became reclaimable the moment a lease-aware worker started,
-- and re-ran on the operator's model / tool budget for results nobody
-- was waiting on. 0032 has since been edited so a fresh apply only
-- resumes jobs touched within the last hour; this migration brings
-- databases that already ran the old backfill to the same place.
--
-- Which rows: still `running`, still carrying the backfill's exact lease
-- (`coalesce(started_at, updated_at) + 10 minutes` — the old backfill
-- touched no other column), and started more than a day ago. Such a
-- lease expired more than 23 hours ago, so no live worker holds the job:
-- a worker heartbeats the lease forward (to `now() + lease`, which is no
-- longer `started_at + 10 min`), and a fresh claim resets `started_at`
-- to the claim time. Even with `JOB_LEASE_SECONDS = 600`, where a claim
-- would produce the same shape, the one-day age rule only matches a
-- claim whose lease lapsed a day ago — a dead worker either way.
--
-- What: `attempts = max_attempts`. With the lease already expired, the
-- workers' reaper (`reap_expired_jobs`: running, lease < now(),
-- attempts >= max_attempts) fails the job and settles its task as
-- failed on its next pass instead of the claim re-running it.
--
-- Not covered: a backfilled job a worker already reclaimed (its
-- `started_at` / lease moved on — it is running or finished by now,
-- nothing to undo).
--
-- Idempotent: `attempts < max_attempts` makes a re-run a no-op.

update public.task_jobs
set attempts = max_attempts
where status = 'running'
  and attempts < max_attempts
  and lease_expires_at = coalesce(started_at, updated_at) + interval '10 minutes'
  and coalesce(started_at, updated_at) < now() - interval '1 day';
