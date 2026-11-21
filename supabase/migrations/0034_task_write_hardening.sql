-- 0034_task_write_hardening.sql — take the worker tables away from PostgREST.
--
-- Before this, a signed-in user talking straight to PostgREST (anon key +
-- own JWT) could write the agent worker's inputs with any column values,
-- bypassing every check the Next routes make:
--
--   * task_jobs INSERT (0014 + 0031) checked only user_id / task
--     ownership. `status`, `attempts`, `max_attempts`, `scheduled_at`,
--     `lease_expires_at`, `action` and `payload` were free: a 1970
--     `scheduled_at` jumps the queue, `max_attempts = 1e9` makes a job the
--     reaper never fails, a `start` job on a finished task re-runs it at
--     the operator's cost.
--   * tasks INSERT/UPDATE (0012) allowed any column: `checkpoint` (model,
--     `requireApprovalFor`, `maxSteps`, the message history), `status`
--     (flip a finished task back to `queued`), `max_steps`, `metadata`,
--     `pending_children`, `parent_task_id`, ...
--
-- After this:
--
--   task_jobs  — no INSERT/UPDATE/DELETE for `anon` / `authenticated`
--                (SELECT stays: the reconciler and the UI read job state).
--                Enqueueing goes through `public.enqueue_task_job`, a
--                SECURITY DEFINER RPC that derives `user_id` from the
--                task, pins status/attempts/max_attempts, clamps
--                `scheduled_at` to [now(), now() + 1 day], validates
--                `action` + payload size, and (for user callers) checks
--                ownership, task state and a per-user queued-job cap.
--   tasks      — no INSERT for `anon` / `authenticated`; a run is created
--                through `public.create_task_run` (SECURITY DEFINER:
--                ownership of the conversation, status pinned to
--                `queued`, `max_steps` 1..50 copied into the checkpoint).
--                UPDATE is column-granted to (status, finished_at,
--                updated_at) only, and a trigger lets API callers move
--                `status` only from a live state (queued/running/paused)
--                to cancelled/failed — what the cancel route, the child
--                cancel cascade and the stale-run reconciler do.
--
-- Who is unaffected:
--   * agent-py / agent-ts connect straight to Postgres as the DSN role
--     (`postgres`), which owns these tables and bypasses RLS and grants;
--     the guard trigger only acts when `current_user` is `anon` or
--     `authenticated`. Their `SET LOCAL ROLE authenticated` impersonation
--     is used only for reads + the MCP / search RPCs, never task writes.
--   * The Next service-role client (`lib/server/supabase/admin.ts`, used
--     by the schedule tick) keeps its table grants (`service_role` is not
--     revoked) and may also call `enqueue_task_job`.
--   * SECURITY DEFINER functions run as their owner, so the trigger lets
--     the RPCs below write the protected columns.
--
-- Idempotent: revoke/grant are repeatable, functions are
-- `create or replace`, the trigger is dropped before re-creation.

-- ---------------------------------------------------------------------------
-- task_jobs
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table public.task_jobs from anon, authenticated;

-- The 0014 / 0031 insert policies are left in place on purpose: they are
-- inert without the INSERT grant, and keep the table safe-by-default if a
-- later migration ever re-grants it.

-- Per-user queued-job cap probe for enqueue_task_job.
create index if not exists task_jobs_user_queued_idx
  on public.task_jobs (user_id)
  where status = 'queued';

create or replace function public.enqueue_task_job(
  p_task_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb,
  p_scheduled_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_task_user uuid;
  v_task_status text;
  v_job_id uuid;
begin
  if v_uid is null and not v_is_service then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- `continue` is the worker's own chunk-break job; workers insert it
  -- directly as the DSN role. API callers may only start or answer.
  if p_action is null
     or p_action not in ('start', 'respond', 'continue')
     or (p_action = 'continue' and not v_is_service) then
    raise exception 'invalid job action' using errcode = '22023';
  end if;

  if jsonb_typeof(v_payload) <> 'object'
     or octet_length(v_payload::text) > 65536 then
    raise exception 'invalid job payload' using errcode = '22023';
  end if;

  -- Lock the task so two concurrent enqueues serialise on the state
  -- checks below.
  select t.user_id, t.status
    into v_task_user, v_task_status
    from public.tasks t
   where t.id = p_task_id
     for update;
  if not found or (not v_is_service and v_task_user is distinct from v_uid) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;

  if not v_is_service then
    if p_action = 'start' and (
         v_task_status <> 'queued'
         or exists (select 1 from public.task_jobs j
                     where j.task_id = p_task_id and j.action = 'start')
       ) then
      raise exception 'task cannot be started (status %)', v_task_status
        using errcode = '55000';
    end if;
    if p_action = 'respond' and v_task_status <> 'paused' then
      raise exception 'task is not paused (status %)', v_task_status
        using errcode = '55000';
    end if;
    if (select count(*) from public.task_jobs j
         where j.user_id = v_uid and j.status = 'queued') >= 20 then
      raise exception 'too many queued jobs' using errcode = '54000';
    end if;
  end if;

  insert into public.task_jobs (
    task_id, user_id, action, payload, status, attempts, scheduled_at
  )
  values (
    p_task_id, v_task_user, p_action, v_payload, 'queued', 0,
    least(greatest(now(), coalesce(p_scheduled_at, now())), now() + interval '1 day')
  )
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke all on function public.enqueue_task_job(uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_task_job(uuid, text, jsonb, timestamptz)
  to authenticated, service_role;

comment on function public.enqueue_task_job(uuid, text, jsonb, timestamptz) is
  'The only API path that writes task_jobs. Pins status/attempts/max_attempts, clamps scheduled_at, checks task ownership + state for user callers.';

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
-- Revoking the table-level privilege also drops any column-level grant,
-- so the grant below is re-applied cleanly on every run.
revoke insert, update on table public.tasks from anon, authenticated;
grant update (status, finished_at, updated_at) on table public.tasks to authenticated;

create or replace function public.create_task_run(
  p_id uuid,
  p_conversation_id uuid,
  p_goal text,
  p_max_steps integer,
  p_checkpoint jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_max_steps is null or p_max_steps < 1 or p_max_steps > 50 then
    raise exception 'max_steps must be between 1 and 50' using errcode = '22023';
  end if;

  if p_checkpoint is null
     or jsonb_typeof(p_checkpoint) <> 'object'
     or jsonb_typeof(p_checkpoint -> 'messages') is distinct from 'array'
     or jsonb_typeof(p_checkpoint -> 'config') is distinct from 'object' then
    raise exception 'invalid checkpoint' using errcode = '22023';
  end if;

  -- SECURITY DEFINER skips RLS (and 0031's FK-ownership policy), so the
  -- conversation's owner is checked here.
  if not exists (
    select 1 from public.conversations c
     where c.id = p_conversation_id and c.user_id = v_uid
  ) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;

  insert into public.tasks (
    id, user_id, conversation_id, goal, status, step, max_steps,
    started_at, checkpoint
  )
  values (
    p_id, v_uid, p_conversation_id, left(coalesce(p_goal, ''), 2000),
    'queued', 0, p_max_steps, now(),
    -- A fresh run starts at step 0 / seq 1 (the route's synthetic
    -- `status:queued` event); the step budget the worker reads is the
    -- validated column value, not whatever the caller sent.
    jsonb_set(
      jsonb_set(jsonb_set(p_checkpoint, '{step}', '0'::jsonb), '{seq}', '1'::jsonb),
      '{config,maxSteps}', to_jsonb(p_max_steps)
    )
  );
end;
$$;

revoke all on function public.create_task_run(uuid, uuid, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_task_run(uuid, uuid, text, integer, jsonb)
  to authenticated;

comment on function public.create_task_run(uuid, uuid, text, integer, jsonb) is
  'Create a queued agent run with its initial checkpoint. The only API path that inserts tasks.';

-- Status transitions an API caller may make: settle a live run as
-- cancelled (cancel route + child cascade) or failed (stale-run
-- reconciler). Never back to queued/running/paused, never out of a
-- terminal state. Workers / service role / definer functions skip it.
create schema if not exists private;

create or replace function private.tasks_guard_api_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.status is distinct from old.status
     and (old.status not in ('queued', 'running', 'paused')
          or new.status not in ('cancelled', 'failed')) then
    raise exception 'tasks.status % -> % is not allowed', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_guard_api_update on public.tasks;
create trigger tasks_guard_api_update
  before update on public.tasks
  for each row execute function private.tasks_guard_api_update();
