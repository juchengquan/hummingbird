-- 0013_task_checkpoint.sql — durable checkpoint for HITL pause/resume
--
-- A run that suspends for a human decision (approval / askUser) must
-- be resumable in a fresh serverless invocation; persisting just the
-- event log isn't enough because the model `messages` array (assistant
-- turns + raw tool I/O) can't be losslessly rebuilt from the UI-shaped
-- events. This column stores `{ messages, step, seq, config }` at the
-- suspend point so a new invocation can pick up exactly where it
-- paused. JSONB so the shape can evolve without further migrations.
--
-- Inherits the tasks-table RLS (own-your-rows). No new policies.

alter table public.tasks
  add column if not exists checkpoint jsonb;

comment on column public.tasks.checkpoint is
  'Persisted run state at a HITL suspend point — { messages, step, seq, config }. Null when never suspended.';
