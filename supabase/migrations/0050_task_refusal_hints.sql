-- 0050_task_refusal_hints.sql — wave 7 (Q88, Q90 of
-- docs/PLAN-frontend-backend-split.md).
--
-- * Q88: a task write refused with 54000 says which limit it met, in the
--   error's HINT, so Next and agent-py tell them apart without reading the
--   message: `task_cap` (5 active tasks — `create_run`, `create_task_run`,
--   0047) and `job_queue` (20 queued jobs — `enqueue_task_job`, 0045).
--   Each function is its latest body (0047 / 0045) with only the raise
--   changed. The schedule limit (0035) keeps its own route and message.
-- * Q90: `private.task_waits_on` reads 0048's generated
--   `tasks.awaiting_children` instead of `checkpoint ? 'awaiting_children'`,
--   which fetched the whole TOASTed checkpoint on every answer.
--
-- Signatures, grants and comments are unchanged (`create or replace`).
-- Idempotent. Deploy order: any — an older caller reads the same SQLSTATE
-- and message as before, only without looking at the hint.
--
-- Rollback: re-run the four functions' definitions from 0047
-- (`create_run`, `create_task_run`) and 0045 (`enqueue_task_job`,
-- `private.task_waits_on`).

-- 1. create_run (0047) — the task cap's hint
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
  v_previous record;
  v_questions text[];
  v_question text;
  v_applied text;
  v_thread_owned boolean := false;
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

  if p_mode = 'background' then
    perform 1 from public.conversations c
      where c.id = p_thread_id and c.user_id = v_uid
      for key share;
    v_thread_owned := found;
  end if;
  perform private.lock_user_tasks(v_uid);

  -- An idempotent retry answers before any validation of the new body,
  -- so it cannot fail on state that changed since the first request (the
  -- cap included). Under the lock: a concurrent retry sees the first
  -- request's row.
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
    select t.status, t.mode, t.parent_task_id
      into v_previous
      from public.tasks t
     where t.id = p_previous_run_id
       and t.user_id = v_uid
       and t.thread_id = p_thread_id
       for no key update;
    if not found then
      raise exception 'previous run not found' using errcode = 'P0002';
    end if;
    if v_previous.mode <> p_mode then
      raise exception 'previous run has another mode' using errcode = '55000';
    end if;
    if v_previous.parent_task_id is not null then
      raise exception 'previous run is a sub-agent run' using errcode = '55000';
    end if;
    if p_mode = 'background' then
      if jsonb_typeof(p_checkpoint #> '{resume,answers}') = 'array' then
        select array_agg(distinct a ->> 'interruptId')
          into v_questions
          from jsonb_array_elements(p_checkpoint #> '{resume,answers}') a;
      end if;
      if v_questions is null or array_position(v_questions, null) is not null then
        raise exception 'invalid resume answers' using errcode = '22023';
      end if;
      foreach v_question in array v_questions loop
        if private.question_held_by_resume(p_previous_run_id, v_question) then
          -- 0047: one that applied the answer and then ended holds it for
          -- good (Q57) — the same refusal as chat's (0046).
          perform 1
             from public.tasks r
            where r.previous_run_id = p_previous_run_id
              and r.user_id = v_uid
              and r.status in ('failed', 'cancelled')
              and r.answers_applied_at is not null
              and (r.answered_question_ids is null
                   or v_question = any (r.answered_question_ids));
          if found then
            raise exception 'answer already applied'
              using errcode = '23505', constraint = 'tasks_answer_applied';
          end if;
          raise exception 'run already resumed'
            using errcode = '23505', constraint = 'tasks_one_live_resume';
        end if;
        if private.question_held_by_respond(p_previous_run_id, v_question) then
          raise exception 'run already answered' using errcode = '55000';
        end if;
        if not private.task_waits_on(p_previous_run_id, v_question) then
          raise exception 'previous run is not waiting on these answers'
            using errcode = '55000';
        end if;
      end loop;
    elsif v_previous.status <> 'paused' then
      raise exception 'previous run is not waiting on these answers'
        using errcode = '55000';
    else
      -- Q63: a resume that applied the answers holds the questions for
      -- good, whatever its status. The stamp is written under the lock
      -- taken above, so it can't land between this check and the insert;
      -- an ended resume's status can, so any applied resume refuses.
      select r.status
        into v_applied
        from public.tasks r
       where r.previous_run_id = p_previous_run_id
         and r.user_id = v_uid
         and r.answers_applied_at is not null
       order by (r.status in ('failed', 'cancelled')) desc
       limit 1;
      if found then
        if v_applied in ('failed', 'cancelled') then
          raise exception 'answer already applied'
            using errcode = '23505', constraint = 'tasks_answer_applied';
        end if;
        raise exception 'run already resumed'
          using errcode = '23505', constraint = 'tasks_one_live_resume';
      end if;
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
    if not v_thread_owned then
      raise exception 'thread not found' using errcode = 'P0002';
    end if;
    -- Q79: a new task, not an answer, under the user's task lock.
    if p_previous_run_id is null and private.task_cap_reached(v_uid) then
      raise exception 'too many active tasks (at most 5 per user)'
        using errcode = '54000', hint = 'task_cap';
    end if;

    insert into public.tasks (
      id, user_id, mode, thread_id, conversation_id, goal, status, step,
      max_steps, started_at, checkpoint, previous_run_id, answered_question_ids
    )
    values (
      p_id, v_uid, 'background', p_thread_id, p_thread_id,
      left(coalesce(p_goal, ''), 2000), 'queued', 0, p_max_steps, now(),
      jsonb_set(
        jsonb_set(jsonb_set(p_checkpoint, '{step}', '0'::jsonb), '{seq}', '1'::jsonb),
        '{config,maxSteps}', to_jsonb(p_max_steps)
      ),
      p_previous_run_id, v_questions
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
    -- Lost a race with a create of the same id by another user.
    raise exception 'run id conflict' using errcode = '23505';
  end if;

  return query select v_inserted, v_status, true;
end;
$$;

-- 2. create_task_run (0047) — the task cap's hint
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
  -- conversation's owner is checked here — then 0045's lock order.
  perform 1 from public.conversations c
    where c.id = p_conversation_id and c.user_id = v_uid
    for key share;
  if not found then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  perform private.lock_user_tasks(v_uid);

  if private.task_cap_reached(v_uid) then
    raise exception 'too many active tasks (at most 5 per user)'
      using errcode = '54000', hint = 'task_cap';
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

-- 3. enqueue_task_job (0045) — the job queue's hint
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
  v_question text;
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

  -- Ownership before any lock, then the locks in 0045's order.
  select t.user_id into v_task_user from public.tasks t where t.id = p_task_id;
  if not found or (not v_is_service and v_task_user is distinct from v_uid) then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  perform private.lock_task_scope(v_task_user, p_task_id);
  select t.status into v_task_status
    from public.tasks t
   where t.id = p_task_id
     for no key update;
  if not found then
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
    if p_action = 'respond' then
      if v_task_status <> 'paused' then
        raise exception 'task is not paused (status %)', v_task_status
          using errcode = '55000';
      end if;
      v_question := v_payload ->> 'requestId';
      if coalesce(v_question, '') = '' then
        raise exception 'requestId is required' using errcode = '22023';
      end if;
      -- One winner per question (Q58), serialised by the locks above.
      if private.question_held_by_resume(p_task_id, v_question) then
        raise exception 'task already answered by a resume run'
          using errcode = '55000';
      end if;
      if private.question_held_by_respond(p_task_id, v_question) then
        raise exception 'question already answered' using errcode = '55000';
      end if;
      if not private.task_waits_on(p_task_id, v_question) then
        raise exception 'task is not waiting on this question' using errcode = '55000';
      end if;
    end if;
    if (select count(*) from public.task_jobs j
         where j.user_id = v_uid and j.status = 'queued') >= 20 then
      raise exception 'too many queued jobs' using errcode = '54000', hint = 'job_queue';
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

-- 4. private.task_waits_on (0045) — 0048's column, not the checkpoint
create or replace function private.task_waits_on(p_task_id uuid, p_question text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_task record;
begin
  select t.user_id, t.status, t.outcome,
         t.awaiting_children as awaiting
    into v_task
    from public.tasks t
   where t.id = p_task_id;
  if not found or v_task.status <> 'paused' or p_question is null then
    return false;
  end if;
  if v_task.outcome ->> 'type' = 'interrupt' then
    return coalesce(
      v_task.outcome -> 'interrupts'
        @> jsonb_build_array(jsonb_build_object('id', p_question)),
      false
    );
  end if;
  if v_task.awaiting then
    return false;
  end if;
  return coalesce((
    select e.payload ->> 'approvalId' = p_question
      from public.task_events e
     where e.task_id = p_task_id
       and e.user_id = v_task.user_id
       and e.kind = 'approval'
       and e.payload ->> 'phase' = 'request'
       and not exists (
         select 1 from public.task_events a
          where a.task_id = e.task_id
            and a.user_id = e.user_id
            and a.kind = 'approval'
            and a.seq > e.seq
            and a.payload ->> 'phase' = 'response'
            and a.payload ->> 'approvalId' = e.payload ->> 'approvalId')
     order by e.seq desc
     limit 1
  ), false);
end;
$$;

-- PostgREST: the redefined functions.
notify pgrst, 'reload schema';
