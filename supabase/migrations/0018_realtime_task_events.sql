-- verify-supabase-types: skip
-- 0018_realtime_task_events.sql — enable Supabase Realtime on task_events
--
-- Phase 6 step 6 of PLAN-agent-task-queue.md. With the worker writing
-- events into `task_events` from a background invocation, the client
-- needs a push channel to see them as they're produced instead of
-- polling the resume endpoint every second. The Realtime extension
-- streams INSERTs from any table added to the `supabase_realtime`
-- publication; RLS on `task_events` (own-your-rows) gates what each
-- user can subscribe to, so adding the table here is safe by default.
--
-- The client subscribes via `lib/client/agent/realtime.ts`; the
-- existing resume endpoint stays as the replay-from-cursor path AND
-- as fallback for anonymous mode / Realtime hiccups.

alter publication supabase_realtime add table public.task_events;
