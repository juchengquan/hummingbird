-- 0030_task_metadata.sql — free-form audit metadata on agent tasks.
--
-- The Python agent service (`services/agent-py/src/agent_py/store.py`
-- `set_task_handler`) stamps `metadata.handler = 'python'` on every run
-- it executes so postmortems can tell which worker ran which task. The
-- column was referenced by that code but never created, so every
-- Python-executed start/continue/respond failed with
-- `UndefinedColumnError`. Additive + defaulted, so existing rows and the
-- TS writers (which never set it) are unaffected. No RLS change needed —
-- the existing per-user row policies on `tasks` cover new columns.
alter table public.tasks
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.tasks.metadata is
  'Free-form audit metadata (e.g. {"handler": "python"} — which agent service executed the run). Not read by the runtime.';
