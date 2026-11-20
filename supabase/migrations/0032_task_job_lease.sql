-- 0032_task_job_lease.sql — worker lease on claimed task_jobs.
--
-- Before this, a claimed job was flipped to `running` and nothing ever
-- reclaimed it. A worker killed mid-run (deploy, OOM, a shutdown cancel
-- that bypassed settlement, a failing `mark_job_done`) stranded both the
-- job and its task in `running` forever.
--
-- `lease_expires_at` is the claim's lease:
--   * the claim sets it to `now() + lease` (agent-py `JOB_LEASE_SECONDS`,
--     default 120 s; agent-ts mirrors the same SQL);
--   * the executing worker heartbeats while the job runs, pushing it
--     forward (agent-py `JOB_HEARTBEAT_SECONDS`, default 30 s);
--   * settle (done / failed) and release clear it;
--   * a `running` row whose lease has passed is reclaimable by the next
--     claim while `attempts < max_attempts`, and reaped (job + task
--     settled failed) once the attempt budget is spent;
--   * the TS stale-run reconciler (`reconcileStaleRuns`) treats a task as
--     live while it has a job that is queued or holds an unexpired lease.
--
-- Additive + nullable, so existing rows and writers are unaffected.
-- Idempotent (`if not exists` / guarded backfill). No RLS change: users
-- can still only select + insert their own rows; workers write through
-- the service-role / direct-Postgres connection.

alter table public.task_jobs
  add column if not exists lease_expires_at timestamptz;

comment on column public.task_jobs.lease_expires_at is
  'Worker lease for a running job. Set on claim, extended by heartbeat, cleared on settle/release. A running row past its lease is reclaimable (attempts < max_attempts) or reaped as failed.';

-- Reclaim / reap probe: expired leases among running rows. Partial on
-- `running` so the scan ignores the (much larger) settled history.
create index if not exists task_jobs_lease_idx
  on public.task_jobs (lease_expires_at)
  where status = 'running';

-- Backfill rows stranded `running` by a pre-lease worker so they become
-- reclaimable. Ten minutes past their last touch is far beyond any
-- chunk (45 s budget), so a job still being driven by an old worker
-- during a rolling deploy is not stolen. Only rows without a lease are
-- touched, so re-running the migration is a no-op.
update public.task_jobs
set lease_expires_at = coalesce(started_at, updated_at) + interval '10 minutes'
where status = 'running'
  and lease_expires_at is null;
