-- verify-supabase-types: skip
-- (Idempotency-only fix to an existing migration — schema shape unchanged.)
--
-- Subagent orchestration PR-1: parent/child link + join-barrier counter.
-- A task may have a parent (orchestrator); `pending_children` is the
-- parent's barrier counter (0 for leaves). No RLS change needed — the
-- existing per-user row policies on `tasks` already cover new columns.
-- Idempotent: columns + index are guarded, so a re-run is a no-op.
alter table public.tasks
  add column if not exists parent_task_id uuid references public.tasks(id) on delete cascade,
  add column if not exists pending_children int not null default 0;

create index if not exists tasks_parent_task_id_idx
  on public.tasks (parent_task_id);
