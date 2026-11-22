-- verify-supabase-types: skip (signatures unchanged)
-- 0043_answer_once.sql — a paused background task is answered one way only.
--
-- docs/PLAN-frontend-backend-split.md Q41. A paused background task can
-- be answered two ways while both APIs live: the old
-- `POST /api/tasks/:id/respond` (a `respond` job resumes the same row in
-- place) and a runs-API resume (`POST /v1/runs` with `previousRunId` +
-- `resume[]`: a new run that starts from the paused run's checkpoint,
-- the paused row staying `paused`). Both would continue the same turn
-- and an approved tool would run twice, so each refuses the other:
--
--   * `enqueue_task_job` — the same function as 0034, except that a
--     `respond` job for a task with a resume run that is not failed /
--     cancelled (the rows 0042's `tasks_one_live_resume` covers) raises
--     55000 'task already answered by a resume run'. The Next routes map
--     55000 to `409 invalid_state` (`lib/server/agent/task-writes.ts`).
--   * `create_run` — the same function as 0042, except that a resume of
--     a task that has a `respond` job raises 55000 'run already
--     answered' (agent-py maps it to `409 run_already_answered`).
--     `task_jobs` rows are never purged, so the job is a reliable marker
--     that the task was answered the old way. It now also takes the
--     previous run's row `FOR UPDATE`, the lock `enqueue_task_job`
--     already takes on the task, so the two serialise: whichever commits
--     second sees the first one's row (READ COMMITTED: each statement
--     after the lock wait reads a fresh snapshot).
--
-- Both signatures are unchanged (generated types unchanged).
-- Idempotent: create-or-replace, repeatable grants.

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
    -- Answered through the runs API (Q41, 0043): a resume run whose
    -- previous_run_id is this task and that is not failed / cancelled
    -- (the rows `tasks_one_live_resume` covers). The row lock above
    -- serialises this with `create_run`.
    if p_action = 'respond' and exists (
      select 1 from public.tasks r
       where r.previous_run_id = p_task_id
         and r.status not in ('failed', 'cancelled')
    ) then
      raise exception 'task already answered by a resume run'
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
  'The only API path that writes task_jobs. Pins status/attempts/max_attempts, clamps scheduled_at, checks task ownership + state for user callers. A respond for a task a runs-API resume already answers raises 55000 (0043).';

create or replace function public.create_run(
  p_id uuid,
  p_thread_id uuid,
  p_mode text,
  p_goal text default null,
  p_previous_run_id uuid default null,
  p_max_steps integer default null,
  p_checkpoint jsonb default null,
  p_lease_seconds integer default null
)
returns table (id uuid, status text, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_inserted uuid;
  v_existing record;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_id is null or p_thread_id is null then
    raise exception 'run id and thread id are required' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('interactive', 'background') then
    raise exception 'invalid run mode' using errcode = '22023';
  end if;

  -- An idempotent retry answers before any validation of the new body,
  -- so it cannot fail on state that changed since the first request.
  select t.user_id, t.thread_id, t.mode, t.status
    into v_existing
    from public.tasks t
   where t.id = p_id;
  if found then
    if v_existing.user_id = v_uid
       and v_existing.thread_id = p_thread_id
       and v_existing.mode = p_mode then
      return query select p_id, v_existing.status, false;
      return;
    end if;
    raise exception 'run id conflict' using errcode = '23505';
  end if;

  if p_previous_run_id is not null then
    -- Lock the answered run: `enqueue_task_job` takes the same row lock
    -- before it inserts a `respond` job, so the two ways of answering
    -- serialise and each sees the other's committed write (0043).
    perform 1 from public.tasks t
     where t.id = p_previous_run_id
       and t.user_id = v_uid
       and t.thread_id = p_thread_id
       for update;
    if not found then
      raise exception 'previous run not found' using errcode = 'P0002';
    end if;
    -- Answered the old way (`/api/tasks/:id/respond`): task_jobs rows are
    -- never purged, so a `respond` job is a permanent marker.
    if exists (
      select 1 from public.task_jobs j
       where j.task_id = p_previous_run_id and j.action = 'respond'
    ) then
      raise exception 'run already answered' using errcode = '55000';
    end if;
  end if;

  begin
  if p_mode = 'background' then
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
       where c.id = p_thread_id and c.user_id = v_uid
    ) then
      raise exception 'thread not found' using errcode = 'P0002';
    end if;

    insert into public.tasks (
      id, user_id, mode, thread_id, conversation_id, goal, status, step,
      max_steps, started_at, checkpoint, previous_run_id
    )
    values (
      p_id, v_uid, 'background', p_thread_id, p_thread_id,
      left(coalesce(p_goal, ''), 2000), 'queued', 0, p_max_steps, now(),
      jsonb_set(
        jsonb_set(jsonb_set(p_checkpoint, '{step}', '0'::jsonb), '{seq}', '1'::jsonb),
        '{config,maxSteps}', to_jsonb(p_max_steps)
      ),
      p_previous_run_id
    )
    on conflict on constraint tasks_pkey do nothing
    returning tasks.id, tasks.status into v_inserted, v_status;
  else
    if p_max_steps is not null and (p_max_steps < 1 or p_max_steps > 50) then
      raise exception 'max_steps must be between 1 and 50' using errcode = '22023';
    end if;
    if p_checkpoint is not null and jsonb_typeof(p_checkpoint) <> 'object' then
      raise exception 'invalid checkpoint' using errcode = '22023';
    end if;

    insert into public.tasks (
      id, user_id, mode, thread_id, conversation_id, goal, status, step,
      max_steps, started_at, checkpoint, previous_run_id, lease_expires_at
    )
    values (
      p_id, v_uid, 'interactive', p_thread_id, null,
      left(p_goal, 2000), 'running', 0, coalesce(p_max_steps, 25), now(),
      p_checkpoint, p_previous_run_id,
      now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 3600))
    )
    on conflict on constraint tasks_pkey do nothing
    returning tasks.id, tasks.status into v_inserted, v_status;
  end if;
  exception when unique_violation then
    -- Only the live-resume index can be violated here (the primary key
    -- is the ON CONFLICT arbiter): another run already answers
    -- p_previous_run_id and is not failed / cancelled.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'tasks_one_live_resume' then
      raise exception 'run already resumed'
        using errcode = '23505', constraint = 'tasks_one_live_resume';
    end if;
    raise;
  end;

  if v_inserted is null then
    -- Lost a race with a concurrent create of the same id: answer as if
    -- that request had come first.
    select t.user_id, t.thread_id, t.mode, t.status
      into v_existing
      from public.tasks t
     where t.id = p_id;
    if found
       and v_existing.user_id = v_uid
       and v_existing.thread_id = p_thread_id
       and v_existing.mode = p_mode then
      return query select p_id, v_existing.status, false;
      return;
    end if;
    raise exception 'run id conflict' using errcode = '23505';
  end if;

  return query select v_inserted, v_status, true;
end;
$$;

revoke all on function public.create_run(uuid, uuid, text, text, uuid, integer, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.create_run(uuid, uuid, text, text, uuid, integer, jsonb, integer)
  to authenticated;

comment on function public.create_run(uuid, uuid, text, text, uuid, integer, jsonb, integer) is
  'Create a run for the runs API (PLAN-frontend-backend-split Q27), idempotent on the client-minted id. The only API path that inserts interactive runs. A second live resume of one interrupted run raises 23505 ''run already resumed'' (constraint tasks_one_live_resume, 0042); a run answered through /api/tasks/:id/respond raises 55000 ''run already answered'' (0043).';
