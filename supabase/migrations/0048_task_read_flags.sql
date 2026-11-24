-- 0048_task_read_flags.sql — read a run's state without reading its
-- checkpoint (wave 6, survey bug 8; Q66).
--
-- A background parent that spawned sub-agents is `paused` with an
-- `awaiting_children` key in `tasks.checkpoint` (agent-py
-- `store.commit_spawn`) and no `outcome`: the runs API calls it
-- `running`, not `interrupted` (RUN_EVENTS.md § 1). Every read of a run —
-- each `listRuns` row, each `getRun`, each idle poll of a run's stream —
-- asked `checkpoint ? 'awaiting_children'`, which decompresses (detoasts)
-- the whole checkpoint: the conversation so far, images as data URLs
-- included.
--
--   * `tasks.awaiting_children` — a stored generated column, so Postgres
--     computes it when the checkpoint is written, for every writer (the
--     worker's spawn / fan-in / pause writes, `create_run`, a raw DSN
--     insert); nothing has to remember to set it, and no one can write it.
--   * "Current run" by its columns: `public.task_run_is_current_by(...)`
--     and `public.task_current_run_id_by(...)`. 0047's
--     `task_run_is_current(tasks)` / `task_current_run_id(tasks)` take the
--     whole row, and passing a row to a function makes Postgres fetch
--     every TOASTed column of it first (a whole-row value can't hold
--     TOAST pointers) — the checkpoint included, once per run and once
--     per run of its chain. The rule is unchanged: 0047's two functions
--     now call these, and so does the 5-task cap's count
--     (`private.active_task_count`), which ran it over every active task
--     at every start.
--
-- Rows that already exist: computed by the `add column` itself (a table
-- rewrite under an ACCESS EXCLUSIVE lock — `tasks` is small next to
-- `task_events`, but run it when the worker is stopped, as 0047). No other
-- column, status or job changes.
--
-- Deploy order: stop every agent-py → apply this → start the new agent-py.
-- An agent-py or Next from before this keeps working against it (neither
-- names the column or the new functions). Rollback: stop the agent-py
-- that reads them, re-run 0047_task_identity_and_caps.sql's sections 5
-- and 6 (the row functions and the cap's count), then
--
--   drop function if exists public.task_current_run_id_by(uuid, uuid, uuid, uuid);
--   drop function if exists public.task_run_is_current_by(uuid, uuid, uuid, text, timestamptz);
--   alter table public.tasks drop column if exists awaiting_children;
--
-- Idempotent: `add column if not exists`, create-or-replace, repeatable
-- grants.

alter table public.tasks
  add column if not exists awaiting_children boolean
    generated always as (coalesce(checkpoint ? 'awaiting_children', false)) stored;

comment on column public.tasks.awaiting_children is
  'Whether the run waits on its sub-agent runs (checkpoint key awaiting_children), computed when the checkpoint is written so reads never detoast the checkpoint (0048).';

-- ---------------------------------------------------------------------------
-- Current run (Q75) by columns — 0047's rule, word for word
-- ---------------------------------------------------------------------------
create or replace function public.task_run_is_current_by(
  p_id uuid,
  p_user_id uuid,
  p_previous_run_id uuid,
  p_status text,
  p_answers_applied_at timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (p_previous_run_id is null
          or p_status not in ('failed', 'cancelled')
          or p_answers_applied_at is not null)
     and not exists (
       select 1 from public.tasks s
        where s.previous_run_id = p_id
          and s.user_id = p_user_id
          and (s.status not in ('failed', 'cancelled')
               or s.answers_applied_at is not null));
$$;

create or replace function public.task_current_run_id_by(
  p_id uuid,
  p_user_id uuid,
  p_parent_task_id uuid,
  p_root_run_id uuid
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when p_parent_task_id is not null then p_id
    else coalesce((
      select c.id
        from public.tasks c
       where c.user_id = p_user_id
         and c.root_run_id = coalesce(p_root_run_id, p_id)
         and c.parent_task_id is null
         and public.task_run_is_current_by(
               c.id, c.user_id, c.previous_run_id, c.status, c.answers_applied_at)
       order by c.created_at desc, c.id desc
       limit 1), p_id)
  end;
$$;

create or replace function public.task_run_is_current(t public.tasks)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.task_run_is_current_by(
    t.id, t.user_id, t.previous_run_id, t.status, t.answers_applied_at);
$$;

create or replace function public.task_current_run_id(t public.tasks)
returns uuid
language sql
stable
set search_path = ''
as $$
  select public.task_current_run_id_by(t.id, t.user_id, t.parent_task_id, t.root_run_id);
$$;

create or replace function private.active_task_count(p_user_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.tasks t
   where t.user_id = p_user_id
     and t.mode = 'background'
     and t.parent_task_id is null
     and t.status in ('queued', 'running', 'paused')
     and public.task_run_is_current_by(
           t.id, t.user_id, t.previous_run_id, t.status, t.answers_applied_at);
$$;

revoke all on function public.task_run_is_current_by(uuid, uuid, uuid, text, timestamptz)
  from public, anon;
revoke all on function public.task_current_run_id_by(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.task_run_is_current_by(uuid, uuid, uuid, text, timestamptz)
  to authenticated, service_role;
grant execute on function public.task_current_run_id_by(uuid, uuid, uuid, uuid)
  to authenticated, service_role;
revoke all on function private.active_task_count(uuid) from public, anon, authenticated;

comment on function public.task_run_is_current_by(uuid, uuid, uuid, text, timestamptz) is
  'public.task_run_is_current (Q75, 0047) from the run''s id, user_id, previous_run_id, status and answers_applied_at — no whole row, so no TOASTed column is fetched (0048). Read-only, the caller''s rights.';
comment on function public.task_current_run_id_by(uuid, uuid, uuid, uuid) is
  'public.task_current_run_id (Q75, 0047) from the run''s id, user_id, parent_task_id and root_run_id (0048). Read-only, the caller''s rights.';

notify pgrst, 'reload schema';
