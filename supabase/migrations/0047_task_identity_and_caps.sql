-- 0047_task_identity_and_caps.sql — a task's identity, its delivery mark
-- and the per-user task cap (wave 6).
--
-- docs/PLAN-frontend-backend-split.md Q69, Q72, Q73, Q75, Q77, Q79, Q80
-- and the wave-6 item "background runs use `run_answer_applied`".
--
-- A task is a top-level background run (its **root**) with every run that
-- answered it (`previous_run_id`, Q24) and every sub-agent run any of them
-- spawned (`parent_task_id`). Before this migration nothing stored that
-- grouping: a chain had to be walked, and a deleted middle row broke it.
--
--   * `tasks.root_run_id` (no FK) — the task's first run. A resume's root is
--     its previous run's, a sub-agent's is its parent's, any other row is
--     its own. A BEFORE INSERT trigger (`tasks_identity`) fills it for every
--     writer — `create_run`, `create_task_run`, `create_scheduled_task`,
--     the worker's spawn insert, a raw DSN insert — unless the insert sets it.
--   * `tasks.research` — `checkpoint.config.mode = 'research'` at insert
--     (Q46), or the previous run's for a resume. Never read from the
--     checkpoint again, which can be large.
--   * `tasks.result_delivered_at` — Q77: a browser wrote the finished task's
--     result into its conversation and sync drained. Set on the root only,
--     through `mark_task_delivered` (users can't write it: 0034's column
--     grants are untouched).
--   * "Current run" (Q75): `public.task_run_is_current(tasks)` and
--     `public.task_current_run_id(tasks)`, below.
--   * The cap (Q72, Q79): at most 5 active top-level background tasks per
--     user — a task counts while its current run is queued, running or
--     paused (on a question, or waiting on its sub-agents). Resumes are
--     exempt. `create_run` and `create_task_run` refuse the sixth with
--     54000 under `private.lock_user_tasks` (agent-py and Next both map
--     54000 to `409 limit_reached`); a schedule fire goes through
--     `create_scheduled_task`, which creates it already failed
--     (`limit_reached`), so it still shows in the task list.
--   * A background question that a failed / cancelled resume had applied
--     is refused with constraint `tasks_answer_applied` (agent-py: `409
--     run_answer_applied`), as 0046 does for chat. Before, it was
--     `tasks_one_live_resume`.
--   * The sub-agent cap (Q72: 20 per task) stays in agent-py's
--     `store.commit_spawn`, the only writer of children, which already
--     holds the user's task lock: it calls `private.task_child_count` here.
--
-- Rows that already exist:
--
--   every row             gets `root_run_id`: walked up `parent_task_id`,
--                         else `previous_run_id`, to the first row with
--                         neither; a chain broken by a deleted row roots at
--                         its earliest row still reachable. `research` from
--                         its checkpoint. `result_delivered_at` is set on
--                         a background root whose current run has ended
--                         (the old path delivered it), so the first browser
--                         after wave 6 writes nothing old; a task still
--                         live delivers once when it ends (Q70, §5b).
--                         No status, outcome, checkpoint or `updated_at`
--                         changes; no job is written.
--   enabled schedules     with no model (`model IS NULL`: every schedule the
--   (Q73, Q80)            editor made) are paused, `enabled = false`, ONCE —
--                         only by the run that adds `root_run_id`, so a
--                         re-run never pauses a schedule its owner has since
--                         re-enabled. Their owners re-enable them; the
--                         editor then sets a model.
--   users already over    keep their tasks; they can't start a new one (nor
--   the cap               can their schedules) until fewer than 5 are
--                         active. Answering a question still works.
--
-- Deploy order: stop every agent-py → apply this → start the new agent-py
-- → deploy Next. An agent-py or Next from before this keeps working
-- against it, except: a sixth task is refused with 54000, which the
-- agent-py before this answers as a 500 (it maps 54000 only for the
-- `start` job) and the Next task route as `409 limit_reached`; a schedule
-- dispatcher from before this still inserts raw, past the cap.
-- Rollback: stop agent-py, re-run 0046_chat_answer_once.sql's section 1
-- (`create_run`) and 0034_task_write_hardening.sql's `create_task_run`,
-- then
--
--   drop trigger if exists tasks_identity on public.tasks;
--   drop function if exists public.create_scheduled_task(uuid, uuid, uuid, text, integer, jsonb);
--   drop function if exists public.mark_task_delivered(uuid);
--
-- and start the older agent-py. The columns, index and the read-only
-- functions can stay; paused schedules stay paused.
--
-- Idempotent: `if not exists`, create-or-replace, a dropped-then-created
-- trigger, repeatable grants, backfills that only fill what is NULL, and
-- the schedule pause guarded by the column it runs before.

-- ---------------------------------------------------------------------------
-- 1. Q73: pause schedules without a model (once)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_attribute
     where attrelid = 'public.tasks'::regclass
       and attname = 'root_run_id'
       and not attisdropped
  ) then
    update public.task_schedules
       set enabled = false, updated_at = now()
     where enabled
       and model is null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Columns (not granted to API roles: 0034's column grants)
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column if not exists root_run_id uuid,
  add column if not exists research boolean not null default false,
  add column if not exists result_delivered_at timestamptz;

comment on column public.tasks.root_run_id is
  'The task this run belongs to: its first run (Q75, 0047). A resume''s root is its previous run''s, a sub-agent''s its parent''s, otherwise the row itself. No FK: it survives deleting a run of the chain. Always set (trigger tasks_identity).';
comment on column public.tasks.research is
  'A research-mode run (checkpoint config.mode = ''research'' at insert, or its previous run''s; Q46, 0047).';
comment on column public.tasks.result_delivered_at is
  'Root runs only: when a browser wrote the finished task''s result into its conversation (Q70, Q77, 0047). Set through mark_task_delivered.';

create index if not exists tasks_user_root_idx
  on public.tasks (user_id, root_run_id);

-- ---------------------------------------------------------------------------
-- 3. Identity at insert
-- ---------------------------------------------------------------------------
create schema if not exists private;

create or replace function private.tasks_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_root uuid;
  v_research boolean;
begin
  if new.root_run_id is null then
    if new.parent_task_id is not null then
      select coalesce(p.root_run_id, p.id) into v_root
        from public.tasks p
       where p.id = new.parent_task_id and p.user_id = new.user_id;
    elsif new.previous_run_id is not null then
      select coalesce(p.root_run_id, p.id), p.research into v_root, v_research
        from public.tasks p
       where p.id = new.previous_run_id and p.user_id = new.user_id;
    end if;
    new.root_run_id := coalesce(v_root, new.id);
  end if;
  if not new.research
     and (coalesce(v_research, false)
          or new.checkpoint #>> '{config,mode}' = 'research') then
    new.research := true;
  end if;
  return new;
end;
$$;

revoke all on function private.tasks_identity() from public, anon, authenticated;

drop trigger if exists tasks_identity on public.tasks;
create trigger tasks_identity
  before insert on public.tasks
  for each row execute function private.tasks_identity();

-- ---------------------------------------------------------------------------
-- 4. Rows that already exist
-- ---------------------------------------------------------------------------
update public.tasks t
   set research = true
 where not t.research
   and t.checkpoint #>> '{config,mode}' = 'research';

-- The rows that exist before 0047 (none has a root yet; on a re-run, none
-- is without one): §5b marks the ended ones delivered.
create temp table if not exists _0047_preexisting (id uuid primary key);
insert into _0047_preexisting
select t.id from public.tasks t where t.root_run_id is null
on conflict do nothing;

do $$
declare
  v_rows integer;
begin
  -- Rows with nothing (left) above them are roots.
  update public.tasks t
     set root_run_id = t.id
   where t.root_run_id is null
     and not exists (
       select 1 from public.tasks u
        where u.id = coalesce(t.parent_task_id, t.previous_run_id)
          and u.user_id = t.user_id);
  -- Then one level at a time: a row takes the root of the row above it.
  loop
    update public.tasks t
       set root_run_id = u.root_run_id
      from public.tasks u
     where t.root_run_id is null
       and u.id = coalesce(t.parent_task_id, t.previous_run_id)
       and u.user_id = t.user_id
       and u.root_run_id is not null;
    get diagnostics v_rows = row_count;
    exit when v_rows = 0;
  end loop;
  -- A cycle can't be built by any writer; should one exist, it roots at itself.
  update public.tasks t set root_run_id = t.id where t.root_run_id is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Current run (Q75)
-- ---------------------------------------------------------------------------
-- A run holds its task's question when it answered it and is live, done,
-- or ended after applying the answer (0045 / 0046's `answers_applied_at`);
-- a resume that failed or was cancelled before applying is a dead branch
-- (the question shows again, with that failure as a note). A run is its
-- task's current run when it is on the task's line (a root, or a resume
-- that holds) and no resume of it holds. A sub-agent run is answered in
-- place, so it is always its own current run.
create or replace function public.task_run_is_current(t public.tasks)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (t.previous_run_id is null
          or t.status not in ('failed', 'cancelled')
          or t.answers_applied_at is not null)
     and not exists (
       select 1 from public.tasks s
        where s.previous_run_id = t.id
          and s.user_id = t.user_id
          and (s.status not in ('failed', 'cancelled')
               or s.answers_applied_at is not null));
$$;

-- The current run of `t`'s task: `t` itself for a sub-agent run, else the
-- newest top-level run of its root that is current (one, unless a deleted
-- run broke the chain).
create or replace function public.task_current_run_id(t public.tasks)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when t.parent_task_id is not null then t.id
    else coalesce((
      select c.id
        from public.tasks c
       where c.user_id = t.user_id
         and c.root_run_id = coalesce(t.root_run_id, t.id)
         and c.parent_task_id is null
         and public.task_run_is_current(c)
       order by c.created_at desc, c.id desc
       limit 1), t.id)
  end;
$$;

revoke all on function public.task_run_is_current(public.tasks) from public, anon;
revoke all on function public.task_current_run_id(public.tasks) from public, anon;
grant execute on function public.task_run_is_current(public.tasks) to authenticated, service_role;
grant execute on function public.task_current_run_id(public.tasks) to authenticated, service_role;

comment on function public.task_run_is_current(public.tasks) is
  'Whether this run is its task''s current run (Q75, 0047): a root, or a resume that holds the question (live, done, or ended after applying), with no resume of it that holds. Sub-agent runs: always. Read-only, the caller''s rights.';
comment on function public.task_current_run_id(public.tasks) is
  'The id of the current run of this run''s task (Q75, 0047); the run itself for a sub-agent run. Read-only, the caller''s rights.';

-- ---------------------------------------------------------------------------
-- 5b. Tasks that ended before 0047 count as delivered (Q70, Q77)
-- ---------------------------------------------------------------------------
-- Their results were written by the old path already; without this, the
-- first browser after wave 6 would write every finished task in history
-- into its conversation again. Background roots only, whose current run
-- has ended; one still live delivers once when it ends. A re-run marks
-- nothing (no row is pre-existing then).
update public.tasks t
   set result_delivered_at = coalesce(t.finished_at, t.updated_at)
  from _0047_preexisting p
 where p.id = t.id
   and t.mode = 'background'
   and t.parent_task_id is null
   and t.root_run_id = t.id
   and t.result_delivered_at is null
   and exists (
     select 1 from public.tasks c
      where c.id = public.task_current_run_id(t)
        and c.status in ('done', 'failed', 'cancelled'));

drop table _0047_preexisting;

-- ---------------------------------------------------------------------------
-- 6. Caps (Q72, Q79)
-- ---------------------------------------------------------------------------
-- Active top-level tasks of a user: tasks whose current run is queued,
-- running or paused. Callers hold `private.lock_user_tasks(p_user_id)`.
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
     and public.task_run_is_current(t);
$$;

create or replace function private.task_cap_reached(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.active_task_count(p_user_id) >= 5;
$$;

-- Sub-agent runs of a task (any depth, every run of its chain): what
-- agent-py's `commit_spawn` checks against 20 (Q72) under the user's task
-- lock, before it inserts more.
create or replace function private.task_child_count(p_task_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.tasks t
    join public.tasks c
      on c.user_id = t.user_id
     and c.root_run_id = coalesce(t.root_run_id, t.id)
     and c.parent_task_id is not null
   where t.id = p_task_id;
$$;

revoke all on function private.active_task_count(uuid) from public, anon, authenticated;
revoke all on function private.task_cap_reached(uuid) from public, anon, authenticated;
revoke all on function private.task_child_count(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. create_run (signature unchanged; 0046's body plus the cap and the
--    background `tasks_answer_applied`)
-- ---------------------------------------------------------------------------
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
        using errcode = '54000';
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
  'Create a run for the runs API (PLAN-frontend-backend-split Q27), idempotent on the client-minted id. The only API path that inserts interactive runs. A resume re-checks under the lock that the previous run is paused, in the same mode, top-level and (background) waiting on those questions (55000); a question a live / done resume holds raises 23505 ''run already resumed'' (constraint tasks_one_live_resume), one a failed / cancelled resume applied 23505 ''answer already applied'' (constraint tasks_answer_applied; interactive 0046, background 0047), one a respond job holds 55000 ''run already answered'' (0045). A new background task past 5 active per user raises 54000 (0047); resumes are exempt.';

-- ---------------------------------------------------------------------------
-- 8. create_task_run (signature unchanged; 0034's body plus the lock and cap)
-- ---------------------------------------------------------------------------
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
    raise exception 'too many active tasks (at most 5 per user)' using errcode = '54000';
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
  'Create a queued agent run with its initial checkpoint (the Next task route). The only path for it that inserts tasks. 54000 past 5 active tasks per user (0047).';

-- ---------------------------------------------------------------------------
-- 9. create_scheduled_task — a schedule fire (Q79)
-- ---------------------------------------------------------------------------
-- What both dispatchers (agent-py `schedules.PgScheduleStore.fire`, Next
-- `fireSchedule`) call once the fire's conversation exists, instead of
-- their raw insert + checkpoint + `status: queued` event + `start` job.
-- Writes all of them, under the user's task lock. At the cap it writes the
-- task already `failed` (`limit_reached`) with its `result` entry and no
-- job, so the fire still shows in the task list. Returns the status it
-- wrote: 'queued' or 'failed'. Service role and the DSN role only.
create or replace function public.create_scheduled_task(
  p_id uuid,
  p_user_id uuid,
  p_conversation_id uuid,
  p_goal text,
  p_max_steps integer,
  p_checkpoint jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkpoint jsonb;
  v_queued jsonb;
begin
  if p_id is null or p_user_id is null or p_conversation_id is null then
    raise exception 'task id, user id and conversation id are required' using errcode = '22023';
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

  perform 1 from public.conversations c
    where c.id = p_conversation_id and c.user_id = p_user_id
    for key share;
  if not found then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  perform private.lock_user_tasks(p_user_id);

  v_checkpoint := jsonb_set(
    jsonb_set(jsonb_set(p_checkpoint, '{step}', '0'::jsonb), '{seq}', '1'::jsonb),
    '{config,maxSteps}', to_jsonb(p_max_steps)
  );
  v_queued := jsonb_build_object('status', 'queued', 'maxSteps', p_max_steps);

  if private.task_cap_reached(p_user_id) then
    insert into public.tasks (
      id, user_id, conversation_id, goal, status, step, max_steps,
      started_at, finished_at, checkpoint, outcome
    )
    values (
      p_id, p_user_id, p_conversation_id, left(coalesce(p_goal, ''), 2000),
      'failed', 0, p_max_steps, now(), now(), v_checkpoint,
      jsonb_build_object(
        'type', 'error',
        'code', 'limit_reached',
        'message', 'Skipped: 5 tasks were already active. Finish or cancel one, and the next run of this schedule will start.'
      )
    );
    insert into public.task_events (task_id, user_id, seq, step, kind, payload)
    values
      (p_id, p_user_id, 1, 0, 'status', v_queued),
      (p_id, p_user_id, 2, 0, 'result', jsonb_build_object(
        'status', 'failed',
        'errorCode', 'limit_reached',
        'error', 'Skipped: 5 tasks were already active. Finish or cancel one, and the next run of this schedule will start.'
      ));
    return 'failed';
  end if;

  insert into public.tasks (
    id, user_id, conversation_id, goal, status, step, max_steps, started_at, checkpoint
  )
  values (
    p_id, p_user_id, p_conversation_id, left(coalesce(p_goal, ''), 2000),
    'queued', 0, p_max_steps, now(), v_checkpoint
  );
  insert into public.task_events (task_id, user_id, seq, step, kind, payload)
  values (p_id, p_user_id, 1, 0, 'status', v_queued);
  insert into public.task_jobs (task_id, user_id, action, payload, status, scheduled_at)
  values (p_id, p_user_id, 'start', '{}'::jsonb, 'queued', now());
  return 'queued';
end;
$$;

revoke all on function public.create_scheduled_task(uuid, uuid, uuid, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_scheduled_task(uuid, uuid, uuid, text, integer, jsonb)
  to service_role;

comment on function public.create_scheduled_task(uuid, uuid, uuid, text, integer, jsonb) is
  'A schedule fire (0047): the task row with its checkpoint, the status:queued entry and the start job — or, past 5 active tasks for the user (Q79), the task already failed (limit_reached) with its result entry and no job. Returns ''queued'' or ''failed''. Service role / DSN only.';

-- ---------------------------------------------------------------------------
-- 10. mark_task_delivered — Q77
-- ---------------------------------------------------------------------------
-- As the user (agent-py's `_as_user`, like `create_run` and `cancel_task`),
-- so ownership is checked here, on the database's own `auth.uid()`, not by
-- a DSN-role caller's filter. Only a task's root, once its current run has
-- ended (done, failed or cancelled). Idempotent: returns the first mark.
create or replace function public.mark_task_delivered(p_task_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_task public.tasks;
  v_current_status text;
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  perform private.lock_user_tasks(v_uid);
  select t.* into v_task
    from public.tasks t
   where t.id = p_task_id and t.user_id = v_uid
     for no key update;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  if v_task.mode <> 'background'
     or v_task.parent_task_id is not null
     or coalesce(v_task.root_run_id, v_task.id) <> v_task.id then
    raise exception 'not a task''s root run' using errcode = '55000';
  end if;
  if v_task.result_delivered_at is not null then
    return v_task.result_delivered_at;
  end if;
  select c.status into v_current_status
    from public.tasks c
   where c.id = public.task_current_run_id(v_task);
  if v_current_status is null or v_current_status not in ('done', 'failed', 'cancelled') then
    raise exception 'task has not ended' using errcode = '55000';
  end if;
  update public.tasks t
     set result_delivered_at = now(), updated_at = now()
   where t.id = p_task_id and t.user_id = v_uid
  returning t.result_delivered_at into v_at;
  return v_at;
end;
$$;

revoke all on function public.mark_task_delivered(uuid) from public, anon, authenticated;
grant execute on function public.mark_task_delivered(uuid) to authenticated;

comment on function public.mark_task_delivered(uuid) is
  'Mark a finished task''s result delivered (Q77, 0047), as its owner: the task''s root run, once its current run ended. Idempotent; returns the mark. P0002 not the caller''s; 55000 not a root, or not ended.';

-- PostgREST: the new columns and functions.
notify pgrst, 'reload schema';
