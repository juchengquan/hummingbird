-- 0040_task_worker_liveness.sql — "is any task worker executing?" probe.
--
-- The TS stale-run reconciler (`reconcileStaleRuns` in
-- lib/server/agent/store.ts) fails a run that was never picked up with
-- "No task worker available" once it has waited
-- TASK_NO_WORKER_TIMEOUT_MINUTES. Waiting alone is not proof that no
-- worker exists: with one busy worker a backlog can easily wait longer
-- than that while the worker is healthy. So the reconciler only fails
-- such a run when this probe says no worker has EXECUTED anything in
-- the same window.
--
-- "Executed" means a job a worker actually ran:
--   * `running` under an unexpired lease (a worker is on it now), or
--   * settled `done` / `failed` recently with `started_at` set (a
--     worker claimed and finished it).
-- A dry-run worker's claim → release does NOT count (release clears
-- `started_at` and puts the job back to `queued`), so a deployment left
-- in WORKER_DRY_RUN=true still lets the safety net fire.
--
-- SECURITY DEFINER because the reconciler runs as the signed-in user
-- under RLS and can only see its own jobs; the function returns a
-- single boolean, so nothing about other users' jobs leaks.
--
-- Idempotent: create-or-replace, `if not exists`, repeatable grants.

create index if not exists task_jobs_updated_at_idx
  on public.task_jobs (updated_at desc);

create or replace function public.task_worker_active_within(p_seconds integer)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.task_jobs j
    where (j.status = 'running' and j.lease_expires_at > now())
       or (
         j.status in ('done', 'failed')
         and j.started_at is not null
         and j.updated_at > now() - make_interval(
           secs => least(greatest(coalesce(p_seconds, 0), 0), 86400)
         )
       )
  );
$$;

revoke all on function public.task_worker_active_within(integer)
  from public, anon, authenticated;
grant execute on function public.task_worker_active_within(integer)
  to authenticated, service_role;

comment on function public.task_worker_active_within(integer) is
  'True when some task worker holds a live lease or finished a job within p_seconds (capped at 1 day). Used by the stale-run reconciler before failing never-started runs as "no worker".';
