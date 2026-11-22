-- 0045_background_tasks_correct.sql — background tasks made correct (wave 5c).
--
-- docs/PLAN-frontend-backend-split.md Q53–Q60. The rules a crash or a
-- race could break move into the database:
--
--   * Terminal is final: no write moves a done / failed / cancelled row
--     to another status (55000).
--   * One winner per question (Q57, Q58). A question is the pair (paused
--     task, question id). It is answered by a queued / running `respond`
--     job for it, or by a resume run that is live, done, or — whatever
--     became of it — had applied the answer (`tasks.answers_applied_at`,
--     written before any side effect). `create_run` and
--     `enqueue_task_job` check it, and that the task still waits on that
--     very question, under the lock below.
--   * Cancel is the whole task (Q60): a background run's chain of answers,
--     both directions, and their children. A child is skipped. A plain
--     `status = 'cancelled'` update (the column grant; the Next route
--     deployed before this) means the same.
--   * The join barrier lives here: whatever ends a child (the worker, a
--     cancel, the reconciler, the owner's status update or delete) recounts
--     the parent's live children once and queues its `continue` at zero.
--
-- Lock order, for every writer of more than one row:
--
--   1. the conversation row (FOR KEY SHARE; only where a write re-checks
--      that foreign key)
--   2. the user's task lock (`private.lock_user_tasks`, transaction-scoped)
--   3. task rows
--   4. the job row (the worker's lease fence, FOR SHARE)
--
-- `create_run`, `enqueue_task_job`, `cancel_task` and the worker's
-- `private.fence_task_job` follow it; an API caller's own UPDATE / DELETE
-- of tasks takes 2 from a statement trigger, before any row lock.
--
-- Rows that already exist (all steps are in section 8):
--
--   resume runs            get the question ids they answer. One that no
--                          longer holds its unapplied answers counts as
--                          applied (a doubtful crash counts as applied).
--   half-answered question stays answerable unless such a resume or a
--                          queued / running respond job holds it. A failed
--                          or finished respond job no longer blocks it, so
--                          a task stuck by 0043's per-task marker works.
--   paused, outcome cancelled
--                          a cancel a pause overwrote: cancelled again.
--   live resume of a cancelled run, live child of an ended parent
--                          cancelled.
--   waiting parent         its counter is recounted. With no live child
--                          and no job: continued if it moved in the last
--                          hour, failed if older (as 0036: nothing dead
--                          for weeks starts spending on deploy).
--   queued, never queued a job, older than an hour
--                          failed (an orphan of a failed enqueue).
--   queued, start job claimed
--                          running.
--   paused on a question   gets finished_at.
--   jobs                   untouched; a task's queued jobs run as before.
--
-- Deploy order: stop every agent-py (an older worker also decrements the
-- barrier, so a parent would resume early) → apply this → start the new
-- agent-py → deploy Next. The Next app deployed before this keeps working
-- against it. Rollback: stop agent-py, then
--
--   drop trigger if exists tasks_terminal_is_final on public.tasks;
--   drop trigger if exists tasks_ended on public.tasks;
--   drop trigger if exists tasks_deleted on public.tasks;
--   drop trigger if exists tasks_lock_caller on public.tasks;
--   (re-run 0043_answer_once.sql)
--
-- and start the older agent-py; the Next app from before 5c is required,
-- as the new one calls `cancel_task`. The two new columns can stay.
--
-- Idempotent: `if not exists`, create-or-replace, dropped-then-created
-- triggers, repeatable grants, backfills that skip what they already did.

-- ---------------------------------------------------------------------------
-- 1. Columns (not granted to API roles: 0034's column grants)
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column if not exists answered_question_ids text[],
  add column if not exists answers_applied_at timestamptz;

comment on column public.tasks.answered_question_ids is
  'A resume run only: the ids of the questions of previous_run_id it answers (0045).';
comment on column public.tasks.answers_applied_at is
  'A resume run only: when the worker committed to applying its answers, written before any side effect. Set = the questions can never be answered again (Q57, 0045).';

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- 2. Locks
-- ---------------------------------------------------------------------------
create or replace function private.lock_user_tasks(p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('hummingbird.tasks:' || p_user_id::text, 0)
    );
  end if;
end;
$$;

-- Steps 1 and 2 for a write on one task's tree.
create or replace function private.lock_task_scope(p_user_id uuid, p_task_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_conversation uuid;
begin
  select t.conversation_id into v_conversation
    from public.tasks t
   where t.id = p_task_id and t.user_id = p_user_id;
  if v_conversation is not null then
    perform 1 from public.conversations c where c.id = v_conversation for key share;
  end if;
  perform private.lock_user_tasks(p_user_id);
end;
$$;

-- The worker's fence (agent-py `fence.fenced_connection`): the locks in
-- order, then "is this claim still mine".
create or replace function private.fence_task_job(p_job_id uuid, p_attempts integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_task uuid;
  v_user uuid;
begin
  select j.task_id, j.user_id into v_task, v_user
    from public.task_jobs j
   where j.id = p_job_id;
  if not found then
    return false;
  end if;
  perform private.lock_task_scope(v_user, v_task);
  perform 1 from public.tasks t where t.id = v_task for no key update;
  perform 1 from public.task_jobs j
    where j.id = p_job_id and j.attempts = p_attempts and j.status = 'running'
    for share;
  return found;
end;
$$;

create or replace function private.tasks_lock_caller()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_user_tasks(auth.uid());
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Questions
-- ---------------------------------------------------------------------------
-- Whether the task is paused on this question: `outcome.interrupts`, or
-- for a row paused before 0045 (no outcome) the newest request of its log
-- that no later response answers. The executor asks one question at a
-- time, so a newer request supersedes any a dead attempt left.
create or replace function private.task_waits_on(p_task_id uuid, p_question text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_task record;
begin
  select t.user_id, t.status, t.outcome,
         coalesce(t.checkpoint ? 'awaiting_children', false) as awaiting
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

-- Whether a resume run answers it: one that is neither failed nor
-- cancelled, or one that applied its answer before it ended.
create or replace function private.question_held_by_resume(p_task_id uuid, p_question text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  return exists (
    select 1
      from public.tasks r
      join public.tasks p on p.id = r.previous_run_id and p.user_id = r.user_id
     where r.previous_run_id = p_task_id
       and (r.status not in ('failed', 'cancelled')
            or (r.answers_applied_at is not null
                and (r.answered_question_ids is null
                     or p_question = any (r.answered_question_ids))))
  );
end;
$$;

-- Whether a respond job answers it. Once the job claimed the task the
-- task no longer waits on the question; one that failed before that
-- never applied it.
create or replace function private.question_held_by_respond(p_task_id uuid, p_question text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  return exists (
    select 1 from public.task_jobs j
     where j.task_id = p_task_id
       and j.action = 'respond'
       and j.status in ('queued', 'running')
       and j.payload ->> 'requestId' = p_question
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cancel tree and barrier
-- ---------------------------------------------------------------------------
-- A task is a background run with every run before and after it in its
-- chain of answers, and their children. For a child: the child alone.
create or replace function private.cancel_task_tree(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select t.user_id into v_user
    from public.tasks t
   where t.id = p_task_id and t.mode = 'background';
  if not found then
    return;
  end if;
  with recursive earlier(id, previous_run_id) as (
    select t.id, t.previous_run_id from public.tasks t where t.id = p_task_id
    union
    select t.id, t.previous_run_id
      from public.tasks t
      join earlier e on t.id = e.previous_run_id
     where t.user_id = v_user and t.mode = 'background'
  ), whole(id) as (
    select e.id from earlier e
    union
    select t.id
      from public.tasks t
      join whole w on t.previous_run_id = w.id or t.parent_task_id = w.id
     where t.user_id = v_user and t.mode = 'background'
  )
  update public.tasks t
     set status = 'cancelled',
         outcome = '{"type":"cancelled"}'::jsonb,
         finished_at = now(),
         updated_at = now(),
         lease_expires_at = null
   where t.id in (select w.id from whole w)
     and t.status in ('queued', 'running', 'paused');
end;
$$;

-- A child ended: recount, and wake the parent when the last one did.
-- The recount makes it idempotent; `pending_children > 0` makes the wake
-- happen once.
create or replace function private.settle_barrier(p_parent_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent record;
  v_live integer;
begin
  select t.status, t.pending_children,
         coalesce(t.checkpoint ? 'awaiting_children', false) as awaiting
    into v_parent
    from public.tasks t
   where t.id = p_parent_id and t.user_id = p_user_id
     for no key update;
  if not found or v_parent.status in ('done', 'failed', 'cancelled') then
    return;
  end if;
  select count(*) into v_live
    from public.tasks c
   where c.parent_task_id = p_parent_id
     and c.user_id = p_user_id
     and c.status in ('queued', 'running', 'paused');
  if v_live = v_parent.pending_children then
    return;
  end if;
  update public.tasks t
     set pending_children = v_live, updated_at = now()
   where t.id = p_parent_id and t.user_id = p_user_id;
  if v_live = 0
     and v_parent.pending_children > 0
     and v_parent.status = 'paused'
     and v_parent.awaiting then
    insert into public.task_jobs (task_id, user_id, action, payload, status, scheduled_at)
    values (p_parent_id, p_user_id, 'continue', '{}'::jsonb, 'queued', now());
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------------
create or replace function private.tasks_terminal_is_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status in ('done', 'failed', 'cancelled') then
    raise exception 'task already ended (status %)', old.status using errcode = '55000';
  end if;
  if new.status in ('done', 'failed', 'cancelled') then
    -- Also for a plain status update, which can't write these columns.
    if new.finished_at is not distinct from old.finished_at then
      new.finished_at := now();
    end if;
    if new.status = 'cancelled' then
      new.outcome := '{"type":"cancelled"}'::jsonb;
    elsif new.outcome ->> 'type' = 'interrupt' then
      new.outcome := null;
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.tasks_ended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' then
    perform private.cancel_task_tree(new.id);
  else
    update public.tasks c
       set status = 'cancelled',
           outcome = '{"type":"cancelled"}'::jsonb,
           finished_at = now(),
           updated_at = now()
     where c.parent_task_id = new.id
       and c.user_id = new.user_id
       and c.status in ('queued', 'running', 'paused');
  end if;
  if new.parent_task_id is not null then
    perform private.settle_barrier(new.parent_task_id, new.user_id);
  end if;
  return null;
end;
$$;

create or replace function private.tasks_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.parent_task_id is not null and old.status in ('queued', 'running', 'paused') then
    perform private.settle_barrier(old.parent_task_id, old.user_id);
  end if;
  -- Deleting the resume that applied an answer must not reopen the
  -- question: the approved tool may already have run.
  if old.previous_run_id is not null and old.answers_applied_at is not null then
    update public.tasks p
       set status = 'failed',
           outcome = jsonb_build_object(
             'type', 'error',
             'code', 'invalid_state',
             'message', 'An answer to this question was already applied. Run the task again.'
           ),
           finished_at = now(),
           updated_at = now()
     where p.id = old.previous_run_id
       and p.user_id = old.user_id
       and p.mode = 'background'
       and p.status = 'paused'
       and (old.answered_question_ids is null
            or exists (select 1 from unnest(old.answered_question_ids) q(id)
                        where private.task_waits_on(p.id, q.id)));
  end if;
  return null;
end;
$$;

drop trigger if exists tasks_lock_caller on public.tasks;
create trigger tasks_lock_caller
  before update or delete on public.tasks
  for each statement execute function private.tasks_lock_caller();

-- Fires after `tasks_guard_api_update` (name order), so an API caller
-- keeps getting that guard's 42501.
drop trigger if exists tasks_terminal_is_final on public.tasks;
create trigger tasks_terminal_is_final
  before update on public.tasks
  for each row execute function private.tasks_terminal_is_final();

drop trigger if exists tasks_ended on public.tasks;
create trigger tasks_ended
  after update on public.tasks
  for each row
  when (new.mode = 'background'
        and old.status in ('queued', 'running', 'paused')
        and new.status in ('done', 'failed', 'cancelled'))
  execute function private.tasks_ended();

drop trigger if exists tasks_deleted on public.tasks;
create trigger tasks_deleted
  after delete on public.tasks
  for each row
  when (old.mode = 'background'
        and (old.parent_task_id is not null or old.previous_run_id is not null))
  execute function private.tasks_deleted();

revoke all on function private.lock_user_tasks(uuid) from public, anon, authenticated;
revoke all on function private.lock_task_scope(uuid, uuid) from public, anon, authenticated;
revoke all on function private.fence_task_job(uuid, integer) from public, anon, authenticated;
revoke all on function private.task_waits_on(uuid, text) from public, anon, authenticated;
revoke all on function private.question_held_by_resume(uuid, text) from public, anon, authenticated;
revoke all on function private.question_held_by_respond(uuid, text) from public, anon, authenticated;
revoke all on function private.cancel_task_tree(uuid) from public, anon, authenticated;
revoke all on function private.settle_barrier(uuid, uuid) from public, anon, authenticated;
revoke all on function private.tasks_lock_caller() from public, anon, authenticated;
revoke all on function private.tasks_terminal_is_final() from public, anon, authenticated;
revoke all on function private.tasks_ended() from public, anon, authenticated;
revoke all on function private.tasks_deleted() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. cancel_task — cancel for the Next route and the runs API
-- ---------------------------------------------------------------------------
create or replace function public.cancel_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select t.mode into v_mode
    from public.tasks t
   where t.id = p_task_id and t.user_id = v_uid;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  perform private.lock_task_scope(v_uid, p_task_id);
  perform 1 from public.tasks t
    where t.id = p_task_id and t.user_id = v_uid
    for no key update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  if v_mode = 'background' then
    perform private.cancel_task_tree(p_task_id);
  else
    -- An interactive run is cancelled alone (Q24: stopping a resume
    -- leaves the question of the run before it answerable).
    update public.tasks t
       set status = 'cancelled',
           outcome = '{"type":"cancelled"}'::jsonb,
           finished_at = now(),
           updated_at = now(),
           lease_expires_at = null
     where t.id = p_task_id
       and t.user_id = v_uid
       and t.status in ('queued', 'running', 'paused');
  end if;
end;
$$;

revoke all on function public.cancel_task(uuid) from public, anon, authenticated;
grant execute on function public.cancel_task(uuid) to authenticated;

comment on function public.cancel_task(uuid) is
  'Cancel one of the caller''s runs (Q60, 0045). Background: the whole task (chain of answers + children); a child alone, whose parent continues. Interactive: that run alone. Idempotent.';

-- ---------------------------------------------------------------------------
-- 7. enqueue_task_job, create_run (signatures unchanged)
-- ---------------------------------------------------------------------------
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
  'The only API path that writes task_jobs. Pins status/attempts/max_attempts, clamps scheduled_at, checks task ownership + state for user callers. A respond must answer the question the task waits on, once (55000 otherwise, 0045).';

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
  -- so it cannot fail on state that changed since the first request.
  -- Under the lock: a concurrent retry sees the first request's row.
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

revoke all on function public.create_run(uuid, uuid, text, text, uuid, integer, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.create_run(uuid, uuid, text, text, uuid, integer, jsonb, integer)
  to authenticated;

comment on function public.create_run(uuid, uuid, text, text, uuid, integer, jsonb, integer) is
  'Create a run for the runs API (PLAN-frontend-backend-split Q27), idempotent on the client-minted id. The only API path that inserts interactive runs. A resume re-checks under the lock that the previous run is paused, in the same mode, top-level and (background) waiting on those questions (55000); a question a resume holds raises 23505 ''run already resumed'', one a respond job holds 55000 ''run already answered'' (0045).';

-- ---------------------------------------------------------------------------
-- 8. Rows that already exist
-- ---------------------------------------------------------------------------
update public.tasks r
   set answered_question_ids = coalesce(
         case when jsonb_typeof(r.checkpoint #> '{resume,answers}') = 'array' then (
           select array_agg(a ->> 'interruptId')
             from jsonb_array_elements(r.checkpoint #> '{resume,answers}') a
         ) end,
         (select array[e.payload ->> 'approvalId']
            from public.task_events e
           where e.task_id = r.previous_run_id
             and e.user_id = r.user_id
             and e.kind = 'approval'
             and e.payload ->> 'phase' = 'request'
             and e.created_at <= r.created_at
           order by e.seq desc
           limit 1)
       )
  from public.tasks p
 where p.id = r.previous_run_id
   and p.mode = 'background'
   and r.answered_question_ids is null;

-- The answers leave the checkpoint when they are applied. An interactive
-- resume of a background run (possible before 0045) never had them.
update public.tasks r
   set answers_applied_at = r.updated_at
  from public.tasks p
 where p.id = r.previous_run_id
   and p.mode = 'background'
   and r.answers_applied_at is null
   and r.status <> 'queued'
   and not coalesce(r.checkpoint ? 'resume', false);

update public.tasks t
   set status = 'cancelled'
 where t.mode = 'background'
   and t.status in ('queued', 'running', 'paused')
   and t.outcome ->> 'type' = 'cancelled';

update public.tasks r
   set status = 'cancelled'
  from public.tasks p
 where p.id = r.previous_run_id
   and p.user_id = r.user_id
   and p.status = 'cancelled'
   and r.mode = 'background'
   and p.mode = 'background'
   and r.status in ('queued', 'running', 'paused');

update public.tasks c
   set status = 'cancelled'
  from public.tasks p
 where p.id = c.parent_task_id
   and p.user_id = c.user_id
   and p.status in ('done', 'failed', 'cancelled')
   and c.status in ('queued', 'running', 'paused');

update public.tasks t
   set status = 'running'
 where t.mode = 'background'
   and t.status = 'queued'
   and exists (select 1 from public.task_jobs j
                where j.task_id = t.id
                  and j.action = 'start'
                  and j.status in ('running', 'done'));

update public.tasks t
   set status = 'failed',
       outcome = jsonb_build_object(
         'type', 'error',
         'code', 'no_worker',
         'message', 'This task was never queued for a worker. Run it again.'
       )
 where t.mode = 'background'
   and t.status = 'queued'
   and t.created_at < now() - interval '1 hour'
   and not exists (select 1 from public.task_jobs j where j.task_id = t.id);

do $$
declare
  v_parent record;
  v_live integer;
  v_moved timestamptz;
begin
  for v_parent in
    select t.id, t.user_id, t.updated_at
      from public.tasks t
     where t.mode = 'background'
       and t.status = 'paused'
       and t.checkpoint ? 'awaiting_children'
  loop
    select count(*) filter (where c.status in ('queued', 'running', 'paused')),
           greatest(v_parent.updated_at, max(c.finished_at), max(c.updated_at))
      into v_live, v_moved
      from public.tasks c
     where c.parent_task_id = v_parent.id and c.user_id = v_parent.user_id;
    update public.tasks t
       set pending_children = v_live
     where t.id = v_parent.id and t.pending_children <> v_live;
    if v_live = 0 and not exists (
      select 1 from public.task_jobs j
       where j.task_id = v_parent.id and j.status in ('queued', 'running')
    ) then
      if v_moved >= now() - interval '1 hour' then
        insert into public.task_jobs (task_id, user_id, action, payload, status, scheduled_at)
        values (v_parent.id, v_parent.user_id, 'continue', '{}'::jsonb, 'queued', now());
      else
        update public.tasks t
           set status = 'failed',
               outcome = jsonb_build_object(
                 'type', 'error',
                 'code', 'worker_lost',
                 'message', 'The task stopped while waiting for its sub-agents. Run it again.'
               )
         where t.id = v_parent.id;
      end if;
    end if;
  end loop;
end;
$$;

update public.tasks t
   set finished_at = t.updated_at
 where t.mode = 'background'
   and t.status = 'paused'
   and t.finished_at is null
   and not coalesce(t.checkpoint ? 'awaiting_children', false);

-- PostgREST: the new function and columns.
notify pgrst, 'reload schema';
