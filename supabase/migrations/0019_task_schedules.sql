-- 0019_task_schedules.sql — recurring agent-task runs ("run every morning")
--
-- Step 7 of PLAN-agent-task-queue.md, the last optional piece of the
-- task-queue arc. A row here is a saved "spec for a task" plus a cron
-- expression + IANA timezone; the worker's `/api/tasks/jobs/tick`
-- route walks due rows on every cron tick and enqueues a `start` job
-- for each. The user owns + scopes everything per the existing
-- own-your-rows RLS pattern.
--
-- Why `next_run_at` is stored (not computed):
--   The Vercel cron's 1-min granularity means we'd otherwise re-parse
--   the cron expression on every row on every tick. Storing the
--   computed `next_run_at` plus a partial index gives O(log N)
--   dispatch: `where enabled and next_run_at <= now()`. The resolver
--   updates `next_run_at` after each successful enqueue.

create table if not exists public.task_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Display + edit fields.
  name text not null check (length(name) between 1 and 200),
  prompt text not null check (length(prompt) between 1 and 20000),
  cron text not null check (length(cron) between 1 and 100),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 100),
  enabled boolean not null default true,

  -- Override knobs (NULL falls back to the workspace's defaults at
  -- enqueue time, same as the chat path).
  model text check (model is null or length(model) <= 100),
  system_prompt text check (system_prompt is null or length(system_prompt) <= 20000),
  skills jsonb,
  max_steps int check (max_steps is null or max_steps between 1 and 50),

  -- Bookkeeping.
  last_run_at timestamptz,
  last_run_task_id uuid references public.tasks(id) on delete set null,
  next_run_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dispatch index: partial-indexed on the only rows the tick cares about.
create index if not exists task_schedules_due_idx
  on public.task_schedules (next_run_at)
  where enabled = true;

-- Per-user list view.
create index if not exists task_schedules_user_idx
  on public.task_schedules (user_id, workspace_id);

alter table public.task_schedules enable row level security;

create policy "users select own task_schedules"
  on public.task_schedules
  for select
  using (auth.uid() = user_id);

create policy "users insert own task_schedules"
  on public.task_schedules
  for insert
  with check (auth.uid() = user_id);

create policy "users update own task_schedules"
  on public.task_schedules
  for update
  using (auth.uid() = user_id);

create policy "users delete own task_schedules"
  on public.task_schedules
  for delete
  using (auth.uid() = user_id);

comment on table public.task_schedules is
  'Recurring task specs evaluated by the worker tick — see lib/server/agent/schedules.ts.';
comment on column public.task_schedules.next_run_at is
  'Cached next-fire time. Maintained by the resolver after each enqueue; recomputed when cron / timezone changes.';
