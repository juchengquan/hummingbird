-- verify-supabase-types: skip (adds an index and replaces create_run with an identical signature; generated types unchanged)
-- 0042_one_live_resume.sql — at most one live resume per interrupted run.
--
-- A resume (Q24) is a new run whose previous_run_id is the interrupted
-- run and whose resume[] answers its interrupts; the interrupted run
-- itself stays `paused`. Nothing stopped a second resume of the same
-- run: both would load the same harness checkpoint and both would run
-- an approved tool — the tool runs twice. The API's check ("the previous
-- run is interrupted") cannot see a concurrent request in another
-- process, so the rule lives in the database:
--
--   * `tasks_one_live_resume` — a unique partial index on
--     previous_run_id over rows that are not `failed` / `cancelled`. Two
--     resumes that are live (or done, or themselves interrupted) cannot
--     coexist; a resume that failed or was cancelled frees the slot, so
--     the user can answer again with a new runId. Only resumes set
--     previous_run_id (create_run, 0041).
--   * `create_run` — the same function as 0041, except that a violation
--     of that index raises 23505 'run already resumed' with
--     CONSTRAINT = 'tasks_one_live_resume' (agent-py maps it to
--     `409 run_already_resumed`), distinct from the bare 23505
--     'run id conflict'. An idempotent retry of the resume itself (same
--     runId, thread and mode) still answers before any insert, and two
--     concurrent creates of the same id still settle on the primary key
--     (the ON CONFLICT arbiter is checked before the other indexes).
--
-- Rows written before this migration: two live resumes of one run would
-- make the index build fail; the runs API shipped with 0041 and has no
-- such rows in practice. If one exists, cancel the newer resume first.
--
-- Idempotent: `if not exists`, create-or-replace, repeatable grants.

create unique index if not exists tasks_one_live_resume
  on public.tasks (previous_run_id)
  where previous_run_id is not null and status not in ('failed', 'cancelled');

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

  if p_previous_run_id is not null and not exists (
    select 1 from public.tasks t
     where t.id = p_previous_run_id
       and t.user_id = v_uid
       and t.thread_id = p_thread_id
  ) then
    raise exception 'previous run not found' using errcode = 'P0002';
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
  'Create a run for the runs API (PLAN-frontend-backend-split Q27), idempotent on the client-minted id. The only API path that inserts interactive runs. A second live resume of one interrupted run raises 23505 ''run already resumed'' (constraint tasks_one_live_resume, 0042).';
