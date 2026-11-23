-- verify-supabase-types: skip (replaces create_run with an identical signature, adds a private trigger function and backfills a 0045 column; generated types unchanged)
-- 0046_chat_answer_once.sql — chat on runs answers a question once (Q63).
--
-- docs/PLAN-frontend-backend-split.md Q57, Q63, Q64. 0045 made a
-- background run's question answerable again only if the failed /
-- cancelled resume never applied the answer. An interactive (chat)
-- resume still freed its question whenever it failed or was cancelled
-- (0042's `tasks_one_live_resume` only counts live rows), so a resume
-- that ran an approved tool and then failed, was stopped or lost its
-- process let a second answer start from the paused run's checkpoint
-- and run the tool again. Now, for interactive runs too:
--
--   * agent-py stamps the resume `tasks.answers_applied_at` (0045's
--     column) before any of its answers takes effect, while the run is
--     live and holding the user's task lock (`private.lock_user_tasks`,
--     taken here by `create_run` too, so the stamp and a second resume's
--     checks are serialised).
--   * `create_run` refuses an interactive resume of a run that another
--     resume applied answers to: 23505 'answer already applied' with
--     CONSTRAINT = 'tasks_answer_applied' (agent-py: `409
--     run_answer_applied`) when that resume has ended, 23505 'run already
--     resumed' / 'tasks_one_live_resume' (`409 run_already_resumed`)
--     while it is still live, done or paused. The paused run stays as it
--     is (Q64). A resume that ended before applying still frees the
--     question. An interactive resume answers every open interrupt of its
--     run, so `answered_question_ids` stays NULL (= all of them).
--   * Deleting an interactive resume that applied its answers fails the
--     paused run it answered ("send the message again") rather than
--     reopening the question — the same rule as 0045's `tasks_deleted`
--     for background runs.
--
-- Background runs are untouched: 0045's `create_run` branch, triggers and
-- functions are as they were.
--
-- Rows that already exist (section 3): an interactive resume of a
-- paused interactive run, with no `answers_applied_at`, counts as applied
-- (stamped with its `finished_at`, else `updated_at`) unless its log
-- shows that its harness never started: entries that are all `status` /
-- `result`. A resume with no log at all (purged after its retention
-- window) is doubtful and counts as applied. Nothing else changes: no
-- status, outcome or other column of any row, no job. The effect is that
-- a paused chat turn whose earlier answer got as far as running may not
-- be answered again (409 `run_answer_applied`); its message is sent again
-- instead.
--
-- Deploy order: stop every agent-py → apply this → start the new
-- agent-py → deploy Next (the new client shows `run_answer_applied`; the
-- one deployed before reports it as an unknown error, and nothing runs
-- twice). An older agent-py against this database maps the new 23505 to
-- `409 run_id_conflict` (still a refusal) and doesn't stamp its own
-- resumes, so don't run it past this migration. Rollback: stop
-- agent-py, re-run 0045_background_tasks_correct.sql's section 7
-- (`create_run`), then
--
--   drop trigger if exists tasks_interactive_resume_deleted on public.tasks;
--   drop function if exists private.tasks_interactive_resume_deleted();
--
-- and start the older agent-py. The stamps can stay.
--
-- Idempotent: create-or-replace, a dropped-then-created trigger,
-- repeatable grants, a backfill that skips rows it already stamped (a
-- re-run can only stamp more: never unstamp).

-- ---------------------------------------------------------------------------
-- 1. create_run (signature unchanged; 0045's body plus the interactive check)
-- ---------------------------------------------------------------------------
comment on column public.tasks.answers_applied_at is
  'A resume run only: when it committed to applying its answers, written before any side effect. Set = the questions can never be answered again (Q57, 0045; interactive runs Q63, 0046).';

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
  'Create a run for the runs API (PLAN-frontend-backend-split Q27), idempotent on the client-minted id. The only API path that inserts interactive runs. A resume re-checks under the lock that the previous run is paused, in the same mode, top-level and (background) waiting on those questions (55000); a question a resume holds raises 23505 ''run already resumed'', one a respond job holds 55000 ''run already answered'' (0045); an interactive question a failed / cancelled resume applied raises 23505 ''answer already applied'' (constraint tasks_answer_applied, 0046).';

-- ---------------------------------------------------------------------------
-- 2. Deleting an applied interactive resume
-- ---------------------------------------------------------------------------
create or replace function private.tasks_interactive_resume_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The approved tool may already have run: the question must not reopen.
  update public.tasks p
     set status = 'failed',
         outcome = jsonb_build_object(
           'type', 'error',
           'code', 'invalid_state',
           'message', 'An answer to this question was already applied. Send the message again.'
         ),
         finished_at = now(),
         updated_at = now()
   where p.id = old.previous_run_id
     and p.user_id = old.user_id
     and p.mode = 'interactive'
     and p.status = 'paused';
  return null;
end;
$$;

revoke all on function private.tasks_interactive_resume_deleted() from public, anon, authenticated;

drop trigger if exists tasks_interactive_resume_deleted on public.tasks;
create trigger tasks_interactive_resume_deleted
  after delete on public.tasks
  for each row
  when (old.mode = 'interactive'
        and old.previous_run_id is not null
        and old.answers_applied_at is not null)
  execute function private.tasks_interactive_resume_deleted();

-- ---------------------------------------------------------------------------
-- 3. Rows that already exist
-- ---------------------------------------------------------------------------
update public.tasks r
   set answers_applied_at = coalesce(r.finished_at, r.updated_at)
  from public.tasks p
 where p.id = r.previous_run_id
   and p.user_id = r.user_id
   and r.mode = 'interactive'
   and p.mode = 'interactive'
   and p.status = 'paused'
   and r.answers_applied_at is null
   and (
     not exists (select 1 from public.task_events e where e.task_id = r.id)
     or exists (select 1 from public.task_events e
                 where e.task_id = r.id
                   and e.kind not in ('status', 'result'))
   );

-- PostgREST: the replaced function.
notify pgrst, 'reload schema';
