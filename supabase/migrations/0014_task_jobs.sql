-- 0014_task_jobs.sql — durable job queue for agent task continuations
--
-- The worker's input. A row here represents one chunk of work that
-- needs to run in a background invocation: continue a yielded run past
-- the function cap (the `continue` action, used in this PR), or — in
-- later phases — start a fresh run / resume a paused one without the
-- user's browser holding the request open.
--
-- v1 schema is intentionally narrow:
--  - `action` is a free `text` so adding `start`/`respond` later doesn't
--    require another migration.
--  - The ready set is `status = 'queued' AND scheduled_at <= now()`;
--    the partial index makes claim-next O(log N) on that selectivity.
--  - Append-only audit of attempts/errors lives on the row itself; we
--    don't bother with a separate history table for v1.
--  - RLS scopes user-facing reads to `auth.uid()`. The worker uses the
--    service-role client, which bypasses RLS — same pattern as cross-
--    user reconciliation work elsewhere in the schema.

create table if not exists public.task_jobs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ready-set probe (claim-next-job) — partial-indexed on `queued` so the
-- scan ignores done/failed rows. Ordered by `scheduled_at` so backoff
-- works (a retry pushes `scheduled_at` forward).
create index if not exists task_jobs_ready_idx
  on public.task_jobs (scheduled_at)
  where status = 'queued';

-- Per-task lookup (debug, "what jobs has this run produced").
create index if not exists task_jobs_task_id_idx
  on public.task_jobs (task_id);

alter table public.task_jobs enable row level security;

-- Users can read their own jobs (status / error visibility); the worker
-- writes via the service-role client and is not subject to these.
create policy "users select own task_jobs"
  on public.task_jobs
  for select
  using (auth.uid() = user_id);

create policy "users insert own task_jobs"
  on public.task_jobs
  for insert
  with check (auth.uid() = user_id);

comment on table public.task_jobs is
  'Durable queue of agent-task continuations. Rows are claimed and processed by a background worker (see lib/server/agent/worker.ts).';
comment on column public.task_jobs.action is
  'Job kind: continue (chunk past function cap), start (future), respond (future).';
comment on column public.task_jobs.payload is
  'Action-specific input — see worker.ts for the per-action shape.';
