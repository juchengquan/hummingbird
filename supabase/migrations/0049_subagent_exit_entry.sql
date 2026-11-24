-- 0049_subagent_exit_entry.sql — a sub-agent run's end shows on its parent
-- as it happens (wave 6).
--
-- docs/PLAN-frontend-backend-split.md wave 6 (the seam's finding), RUN_EVENTS.md
-- § 3.2 (`handoff` `exit` → `SUBAGENT_FINISHED`).
--
-- A parent's log announced each sub-agent run it spawned (`handoff` `enter`,
-- written with the spawn) but never its end: the stream closed every open
-- sub-agent only when the parent itself ended, so a task's sub-agent pill
-- spun until then. Now whatever ends a sub-agent run — the worker's settle,
-- its own cancel (Q60), the reconciler, the owner's update — also writes a
-- `handoff` `exit` entry naming it (`childTaskId`) on its parent's log, in
-- the same transaction, from the `tasks_ended` trigger (0045) that already
-- recounts the parent's live children.
--
-- Only while the parent is `paused` (waiting on its sub-agent runs): then no
-- worker is writing its log, so the entry takes the next seq without racing
-- one, and the parent's `continue` (queued by the same transaction's barrier)
-- seeds past it. A parent that already ended — it was cancelled, which
-- cancels its sub-agent runs — gets nothing: its stream is closing anyway.
-- The entry is written under the parent's row lock (the barrier takes the
-- same lock next), so two sub-agent runs ending at once take distinct seqs.
--
-- Rows that already exist: nothing changes. Idempotent: create-or-replace.
-- Rollback: re-run 0045_background_tasks_correct.sql's `private.tasks_ended`,
-- then `drop function if exists private.note_subagent_exit(public.tasks);`.

create or replace function private.note_subagent_exit(p_child public.tasks)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent record;
begin
  select t.status, t.step
    into v_parent
    from public.tasks t
   where t.id = p_child.parent_task_id and t.user_id = p_child.user_id
     for no key update;
  if not found or v_parent.status <> 'paused' then
    return;
  end if;
  insert into public.task_events (task_id, user_id, seq, step, kind, payload)
  values (
    p_child.parent_task_id,
    p_child.user_id,
    (select coalesce(max(e.seq), 0) + 1
       from public.task_events e
      where e.task_id = p_child.parent_task_id),
    coalesce(v_parent.step, 0),
    'handoff',
    jsonb_build_object(
      'agent', coalesce(nullif(p_child.checkpoint #>> '{subagent,personaSlug}', ''), 'subagent'),
      'phase', 'exit',
      'childTaskId', p_child.id::text
    )
  )
  on conflict (task_id, seq) do nothing;
end;
$$;

-- 0045's body, plus the exit entry before the barrier.
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
    perform private.note_subagent_exit(new);
    perform private.settle_barrier(new.parent_task_id, new.user_id);
  end if;
  return null;
end;
$$;

revoke all on function private.note_subagent_exit(public.tasks) from public, anon, authenticated;
revoke all on function private.tasks_ended() from public, anon, authenticated;
