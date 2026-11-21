-- 0041_runs_on_tasks.sql — the run model on the existing task tables.
--
-- docs/PLAN-frontend-backend-split.md Q27: during the migration a run is
-- a `tasks` row, its event log is `task_events`, and background runs are
-- queued through `task_jobs`. The runs API (`/v1/runs`, wave 3b) and the
-- old task routes read the same rows, so nothing is copied or written
-- twice; Phase 5 renames and reshapes the tables into the long-run model.
--
-- What this adds to `tasks`:
--
--   mode              'interactive' | 'background'. Defaults to
--                     'background', so every existing row and every
--                     existing insert (create_task_run, the schedule
--                     dispatchers, subagent children) is unchanged.
--                     Interactive runs execute in the API process that
--                     received `POST /v1/runs` (Q28) and never get a
--                     `task_jobs` row (trigger below).
--   thread_id         The AG-UI `threadId` — the conversation id. Always
--                     set: back-filled from `conversation_id`, and an
--                     insert that omits it gets `conversation_id`.
--   previous_run_id   The run this one continues: for a resume (Q24) the
--                     interrupted run whose interrupts `resume[]` answers.
--   outcome           How the run ended, in the shape of AG-UI's closing
--                     event, written by the backend when it settles the
--                     run: {"type":"success","result":…} |
--                     {"type":"interrupt","interrupts":[…]} |
--                     {"type":"error","code":…,"message":…} |
--                     {"type":"cancelled"}. Null while live and on rows
--                     settled before 0041 (readers fall back to the log).
--   lease_expires_at  Liveness of an interactive run: the API process
--                     executing it heartbeats this; a live interactive run
--                     past its lease belongs to a dead process and is
--                     failed by the reaper (Q28 — never handed to another
--                     worker). Unused for background runs (their lease is
--                     `task_jobs.lease_expires_at`).
--
-- The thread / conversation choice. An interactive run must not fail
-- because its conversation has not synced to Postgres yet (local-first,
-- Q2/Q15: the browser owns the history and may sync it late, or never),
-- but background runs keep requiring a synced conversation the caller
-- owns. The smallest change that does both: `conversation_id` (the FK,
-- with its ON DELETE CASCADE and 0031 ownership policy) becomes nullable,
-- and the thread lives in a new FK-less `thread_id`. A CHECK pins the two
-- shapes:
--
--   background   conversation_id = thread_id (NOT NULL), goal NOT NULL
--   interactive  conversation_id IS NULL (thread_id is just the id)
--
-- so no existing row or writer changes, and an interactive run never
-- touches `conversations`. Because an interactive row has no FK, deleting
-- a conversation would no longer remove its interactive runs (whose event
-- logs hold the conversation's content); the `conversations` delete
-- trigger below restores exactly that cascade, scoped to the
-- conversation's owner.
--
-- `goal` becomes nullable for interactive runs only (CHECK above): a chat
-- turn has no goal and must not be forced to invent one.
--
-- Writes stay as 0034 left them: `anon` / `authenticated` cannot INSERT
-- `tasks`. A user-scoped run is created through the new
-- `public.create_run` RPC (SECURITY DEFINER), which agent-py calls as the
-- user (`_set_user_context`); every other run write (status transitions,
-- outcome, heartbeats, events) is the backend's, as the DSN role, exactly
-- like the workers today.
--
-- Old surfaces only see background runs (Q27): the Next routes filter on
-- `mode = 'background'` (lib/server/agent/store.ts), `task_jobs` refuses
-- interactive tasks (so the pollers, reapers, the stale-run reconciler's
-- job checks and `task_worker_active_within` never meet one), and
-- `enqueue_task_job` inherits that refusal.
--
-- Idempotent: `if not exists` columns, guarded constraints, create-or-
-- replace functions, dropped-then-created triggers and policies.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.tasks
  add column if not exists mode text not null default 'background',
  add column if not exists thread_id uuid,
  add column if not exists previous_run_id uuid
    references public.tasks(id) on delete set null,
  add column if not exists outcome jsonb,
  add column if not exists lease_expires_at timestamptz;

alter table public.tasks alter column conversation_id drop not null;
alter table public.tasks alter column goal drop not null;

comment on column public.tasks.mode is
  'interactive (runs in the API process that started it, no task_jobs) | background (queued through task_jobs). PLAN-frontend-backend-split Q27/Q28.';
comment on column public.tasks.thread_id is
  'The run''s thread (AG-UI threadId): the conversation id. No FK — an interactive run''s conversation may not have synced yet. Equals conversation_id on background runs.';
comment on column public.tasks.previous_run_id is
  'The run this one continues — for a resume, the interrupted run whose interrupts it answers.';
comment on column public.tasks.outcome is
  'How the run ended, shaped like AG-UI''s closing event: {type: success, result} | {type: interrupt, interrupts} | {type: error, code, message} | {type: cancelled}. Null while live and on rows settled before 0041.';
comment on column public.tasks.lease_expires_at is
  'Interactive runs only: heartbeated by the executing API process; a live interactive run past its lease is failed by the reaper.';

-- ---------------------------------------------------------------------------
-- 2. thread_id default + immutable run shape
-- ---------------------------------------------------------------------------
-- Back-fill before the guard below exists (it forbids changing
-- thread_id). The ADD COLUMN above holds an ACCESS EXCLUSIVE lock until
-- commit, so no insert can slip in between.
update public.tasks
   set thread_id = conversation_id
 where thread_id is null;

create schema if not exists private;

-- Insert: an omitted thread_id is the conversation (every pre-0041
-- writer). Update: mode and thread_id never change — a background run
-- may own task_jobs rows, and the thread is part of the run's identity.
-- Applies to every role, the DSN role included.
create or replace function private.tasks_run_shape()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.thread_id is null then
      new.thread_id := new.conversation_id;
    end if;
    return new;
  end if;
  if new.mode is distinct from old.mode
     or new.thread_id is distinct from old.thread_id then
    raise exception 'tasks.mode and tasks.thread_id are immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_run_shape on public.tasks;
create trigger tasks_run_shape
  before insert or update on public.tasks
  for each row execute function private.tasks_run_shape();

alter table public.tasks alter column thread_id set not null;

do $$ begin
  alter table public.tasks
    add constraint tasks_mode_check check (mode in ('interactive', 'background'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.tasks
    add constraint tasks_run_shape_check check (
      (mode = 'background'
        and conversation_id is not null
        and thread_id = conversation_id
        and goal is not null)
      or (mode = 'interactive' and conversation_id is null)
    );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
-- `GET /v1/runs?threadId=` and the default list, newest first with a
-- stable tiebreak for token paging.
create index if not exists tasks_user_thread_created_idx
  on public.tasks (user_id, thread_id, created_at desc, id desc);
create index if not exists tasks_user_created_idx
  on public.tasks (user_id, created_at desc, id desc);

-- The interactive reaper: live interactive runs whose lease lapsed.
create index if not exists tasks_interactive_lease_idx
  on public.tasks (lease_expires_at)
  where mode = 'interactive' and status in ('queued', 'running');

create index if not exists tasks_previous_run_id_idx
  on public.tasks (previous_run_id)
  where previous_run_id is not null;

-- ---------------------------------------------------------------------------
-- 4. RLS: 0031's FK-ownership pair, now with a nullable conversation_id
--    and the new previous_run_id FK.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks: fk ownership (insert)" on public.tasks;
create policy "tasks: fk ownership (insert)" on public.tasks
  as restrictive for insert to public
  with check (
    (conversation_id is null
     or exists (select 1 from public.conversations c
                where c.id = tasks.conversation_id and c.user_id = (select auth.uid())))
    and (result_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = tasks.result_message_id and m.user_id = (select auth.uid())))
    and (parent_task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = tasks.parent_task_id and t.user_id = (select auth.uid())))
    and (previous_run_id is null
         or exists (select 1 from public.tasks t
                    where t.id = tasks.previous_run_id and t.user_id = (select auth.uid())))
  );
drop policy if exists "tasks: fk ownership (update)" on public.tasks;
create policy "tasks: fk ownership (update)" on public.tasks
  as restrictive for update to public
  with check (
    (conversation_id is null
     or exists (select 1 from public.conversations c
                where c.id = tasks.conversation_id and c.user_id = (select auth.uid())))
    and (result_message_id is null
         or exists (select 1 from public.messages m
                    where m.id = tasks.result_message_id and m.user_id = (select auth.uid())))
    and (parent_task_id is null
         or exists (select 1 from public.tasks t
                    where t.id = tasks.parent_task_id and t.user_id = (select auth.uid())))
    and (previous_run_id is null
         or exists (select 1 from public.tasks t
                    where t.id = tasks.previous_run_id and t.user_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- 5. Interactive runs never have jobs
-- ---------------------------------------------------------------------------
-- Every task_jobs writer (enqueue_task_job, agent-py / agent-ts inserting
-- `continue` and subagent `start` jobs as the DSN role, the service-role
-- schedule tick) goes through this, so the pollers, the reapers, the
-- stale-run reconciler's job probes and task_worker_active_within only
-- ever see background runs.
create or replace function private.task_jobs_background_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.tasks t
              where t.id = new.task_id and t.mode = 'interactive') then
    raise exception 'interactive runs have no jobs (task %)', new.task_id
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.task_jobs_background_only() from public;

drop trigger if exists task_jobs_background_only on public.task_jobs;
create trigger task_jobs_background_only
  before insert or update of task_id on public.task_jobs
  for each row execute function private.task_jobs_background_only();

-- ---------------------------------------------------------------------------
-- 6. Deleting a conversation deletes its interactive runs
-- ---------------------------------------------------------------------------
-- Background runs go with the conversation through the conversation_id FK
-- (ON DELETE CASCADE); interactive runs have no FK, so this does the same
-- for them. Scoped to the conversation's owner: another user's runs that
-- happen to carry the same thread id are not touched. SECURITY DEFINER so
-- it works whoever deletes the conversation (the owner under RLS, the
-- service role, a cascade from a workspace delete).
create or replace function private.conversations_delete_thread_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.tasks t
   where t.thread_id = old.id
     and t.user_id = old.user_id
     and t.conversation_id is null;
  return old;
end;
$$;

revoke all on function private.conversations_delete_thread_runs() from public;

drop trigger if exists conversations_delete_thread_runs on public.conversations;
create trigger conversations_delete_thread_runs
  after delete on public.conversations
  for each row execute function private.conversations_delete_thread_runs();

-- ---------------------------------------------------------------------------
-- 7. create_run — the runs API's user-scoped, idempotent run creation
-- ---------------------------------------------------------------------------
-- Called by agent-py as the user (SET LOCAL ROLE authenticated + the
-- JWT claims). `p_id` is the client-minted AG-UI runId:
--
--   * new id              → inserts the run, returns (id, status, true).
--   * the caller's own run with the same thread and mode
--                         → idempotent retry: returns (id, current
--                           status, false) and changes nothing.
--   * anything else (another user's run, or the caller's run on another
--     thread / in another mode)
--                         → SQLSTATE 23505 'run id conflict'. The same
--                           error in every case, carrying nothing about
--                           the existing row.
--
-- Shapes:
--   background   p_thread_id must be a conversation the caller owns
--                (P0002 'thread not found' otherwise — the run needs it
--                synced); p_max_steps 1..50 and a p_checkpoint with
--                `messages` (array) + `config` (object) are required, as
--                in create_task_run. Created `queued`, with the
--                checkpoint's step / seq / config.maxSteps pinned (the
--                caller appends `status: queued` as seq 1, then enqueues
--                the `start` job with enqueue_task_job).
--   interactive  no conversation needed; created `running`, started now,
--                with lease_expires_at = now() + p_lease_seconds
--                (clamped to 10..3600, default 120). p_checkpoint is
--                optional (an object when given), p_goal optional.
--
-- p_previous_run_id, when set, must be one of the caller's runs on the
-- same thread (P0002 'previous run not found'). Whether it is actually
-- waiting on the interrupts being answered is the API's check.
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
  'Create a run for the runs API (PLAN-frontend-backend-split Q27), idempotent on the client-minted id. The only API path that inserts interactive runs.';
