-- Long-running tasks — persistence slice (#4) of the agent event
-- model. See `docs/PLAN-agent-event-model.md` (Implementation slices)
-- and `docs/PLAN-long-running-tasks.md`.
--
-- Two tables:
--   - `tasks`        : one row per run. The durable run header
--                      (status, step, result link, timestamps).
--   - `task_events`  : the append-only event log — the source of
--                      truth from which every view (live task card,
--                      settled message, status badge) is projected.
--                      Mirrors the shipped `TaskEvent` IR in
--                      `lib/shared/agent/events.ts`.
--
-- Reconciled against the IR (the Phase-1 sketch in
-- PLAN-long-running-tasks predates it):
--   - `seq` is the monotonic resume cursor (UNIQUE per task). Replay
--     on reconnect is `where seq > $cursor order by seq`. The Phase-1
--     sketch only had `step`; `seq` is finer (many events per step).
--   - `kind` is unconstrained `text` ON PURPOSE — the event taxonomy
--     is designed to be additive (consumers tolerate unknown/future
--     kinds; see the multi-SDK section of the plan). A CHECK list
--     here would force a migration for every new event kind and fight
--     that design. Validation lives at the IR boundary (Zod, in
--     `lib/shared/agent/wire.ts` / the persistence row codec).
--   - `status` DOES get a CHECK — the run-status set is small + stable
--     and mirrors `RunStatus` (incl. `paused`).
--
-- RLS: the boilerplate own-your-rows pattern — same four-policy shape
-- as every other table (`0002_rls_policies.sql`, `0011_prompts.sql`).
-- Idempotent: `if not exists` + duplicate-policy-swallowing DO blocks.

create table if not exists tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  goal text not null,
  status text not null
    check (status in ('queued', 'running', 'paused', 'cancelled', 'done', 'failed')),
  step int not null default 0,
  max_steps int not null default 25,
  -- The settled assistant message this run produced, once it lands.
  result_message_id uuid references messages(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_user_conversation_idx
  on tasks (user_id, conversation_id);

-- Cheap "what's still running for this user" probe (sidebar badge,
-- resume-on-reload). Partial index keeps it tiny.
create index if not exists tasks_active_idx
  on tasks (user_id)
  where status in ('queued', 'running', 'paused');

create table if not exists task_events (
  -- DB-internal surrogate key; ordering is by (task_id, seq).
  id bigserial primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Monotonic per task — the resume cursor. UNIQUE makes append
  -- idempotent (a re-emitted seq on retry hits the conflict and is
  -- dropped) and enforces gap-free-ish ordering.
  seq int not null,
  step int not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (task_id, seq)
);

-- The resume query: `where task_id = $1 and seq > $cursor order by seq`.
create index if not exists task_events_task_seq_idx
  on task_events (task_id, seq);

alter table tasks enable row level security;
alter table task_events enable row level security;

do $$ begin
  create policy "tasks: select own"
    on tasks for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "tasks: insert own"
    on tasks for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "tasks: update own"
    on tasks for update using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "tasks: delete own"
    on tasks for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "task_events: select own"
    on task_events for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "task_events: insert own"
    on task_events for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- task_events are append-only — no update/delete policies. Rows go
-- away only via the ON DELETE CASCADE from `tasks`.
