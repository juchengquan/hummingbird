-- 0035_task_schedule_limits.sql — bound what a user's schedules can cost.
--
-- 0019 only length-checked `cron`, had no per-user cap, and let users
-- write every column. Fifty `* * * * *` schedules from one account
-- filled the tick's 50-row batch every minute and starved everyone else.
--
-- Three layers (the precise rule lives in the app, this is the floor a
-- direct-PostgREST writer can't get under):
--
--   1. Column grants. `anon` / `authenticated` lose table-level
--      INSERT/UPDATE and get it back only for the user-editable columns.
--      `last_run_at` + `last_run_task_id` are the dispatcher's
--      bookkeeping (service role); `last_run_at` is what its
--      minimum-gap throttle keys on, so users must not be able to
--      reset it. `user_id` is insert-only.
--   2. A coarse cron guard (`private.task_schedule_cron_coarse_ok`):
--      exactly five fields (no seconds field) and a minute field that
--      fires at most 12 times an hour — a list of ≤ 12 minutes, or a
--      `*`/range/start with a step ≥ 5. The routes additionally check
--      the real minimum gap (≥ 5 min) with cron-parser
--      (`validateScheduleCron` in lib/server/agent/schedules.ts).
--   3. A per-user cap of 20 enabled schedules, checked on insert and on
--      re-enable under a per-user advisory lock so concurrent inserts
--      can't both slip under it.
--
-- Rows 2 + 3 run in a BEFORE trigger that acts only for `anon` /
-- `authenticated`; the service-role tick (which advances
-- `next_run_at` / `last_run_at`) and direct-Postgres workers are not
-- affected. Existing rows are left alone — the dispatcher's own
-- minimum-gap throttle (schedules.ts) rate-limits any legacy
-- too-frequent schedule, and the guard bites the next time its cron is
-- edited.
--
-- Idempotent: revoke/grant are repeatable, functions are
-- `create or replace`, the trigger is dropped before re-creation.

-- ---------------------------------------------------------------------------
-- 1. Column grants
-- ---------------------------------------------------------------------------
revoke insert, update on table public.task_schedules from anon, authenticated;

grant insert (
  id, user_id, workspace_id, name, prompt, cron, timezone, enabled,
  model, system_prompt, skills, max_steps, next_run_at, created_at, updated_at
) on table public.task_schedules to authenticated;

grant update (
  workspace_id, name, prompt, cron, timezone, enabled,
  model, system_prompt, skills, max_steps, next_run_at, updated_at
) on table public.task_schedules to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Coarse cron guard
-- ---------------------------------------------------------------------------
create schema if not exists private;

create or replace function private.task_schedule_cron_coarse_ok(p_cron text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    array_length(f, 1) = 5
    and (
      -- explicit minute list: at most 12 entries an hour
      f[1] ~ '^[0-5]?[0-9](,[0-5]?[0-9]){0,11}$'
      -- */n, a-b/n, a/n with n >= 5
      or f[1] ~ '^(\*|[0-5]?[0-9]-[0-5]?[0-9]|[0-5]?[0-9])/([5-9]|[1-5][0-9])$'
    ),
    false
  )
  from (select regexp_split_to_array(btrim(coalesce(p_cron, '')), '\s+') as f) s;
$$;

revoke all on function private.task_schedule_cron_coarse_ok(text) from public;
grant execute on function private.task_schedule_cron_coarse_ok(text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 + 3. Guard trigger
-- ---------------------------------------------------------------------------
create or replace function private.task_schedules_guard_api_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_check_cron boolean;
  v_check_cap boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Branch on tg_op instead of touching OLD on INSERT.
  if tg_op = 'INSERT' then
    v_check_cron := true;
    v_check_cap := new.enabled;
  else
    v_check_cron := new.cron is distinct from old.cron;
    v_check_cap := new.enabled and not old.enabled;
  end if;

  if v_check_cron and not private.task_schedule_cron_coarse_ok(new.cron) then
    raise exception 'cron fires too often (minimum interval is 5 minutes)'
      using errcode = '22023';
  end if;

  if v_check_cap then
    perform pg_advisory_xact_lock(
      hashtextextended('task_schedules:' || new.user_id::text, 0)
    );
    if (select count(*) from public.task_schedules s
         where s.user_id = new.user_id
           and s.enabled
           and s.id <> new.id) >= 20 then
      raise exception 'schedule limit reached (20 enabled schedules per user)'
        using errcode = '54000';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists task_schedules_guard_api_write on public.task_schedules;
create trigger task_schedules_guard_api_write
  before insert or update on public.task_schedules
  for each row execute function private.task_schedules_guard_api_write();
