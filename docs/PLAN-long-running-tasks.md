# Plan: Long-running task mode

Status: **planning** — no code yet.

A separate "task" surface for prompts that need many tool calls, much
context, or many minutes to finish — *"research the top 10 React
frameworks and write a comparison"*, *"go read these 30 PRs and
draft release notes"*. Lifts the assistant from turn-based chat to a
durable, cancellable, notify-when-done agent.

## Why

Today every chat turn is bounded by:

- A single HTTP request lifecycle (browser tab open, no resume).
- The model's `stepCountIs(N)` step cap (currently 10 in the chat
  route).
- The user's attention — they're staring at the chat panel waiting
  for the stream.

That model breaks down for genuinely large jobs. The user needs a way
to *dispatch* a goal, *navigate away*, and *come back to the result*.
Most chat apps don't have this. The ones that do — Devin, Manus,
Replit Agent — position it as their main product surface.

For Hummingbird, this is the next step from "good chat" to "agent
substrate." It also unlocks the Project mode plan
(`PLAN-project-mode.md`), which depends on tasks as the unit of work.

## Goal & scope cuts

**v1 ships:**

- A "Run as task" toggle (or `/task` slash command — fits cleanly into
  the slash-commands plan) on the chat input.
- A `tasks` table + a server-side runner that drives `streamText` in
  a loop with the configured skill set until the model signals done
  or a step cap hits.
- A **task strip** at the top of the conversation with live progress
  (step counter + the current tool call) and Cancel.
- Final result lands as a normal assistant message; the task strip
  collapses.
- Browser notification + a small badge on the conversation sidebar
  entry when a task finishes while the user is on another tab /
  conversation / app.

**Out of v1:**

- True multi-tenant queue. v1 uses a single worker per browser tab
  (the Server-Sent Events stream that ran the original chat call) +
  a Postgres-backed "resume" mechanism for reload. A real queue
  (Inngest, pg-boss) lands when concurrent tasks per user become a
  real ask.
- Parallel sub-tasks. v1 is sequential: one task, one stream.
- Branching the conversation when a task finishes (the answer lands
  inline). Branching can be a follow-up.

## Architecture

```
+----------------+   POST /api/tasks   +---------------------+
| Chat input     | ------------------> | tasks (Postgres)    |
| "Run as task"  | <--- task_id ------ | { id, status, goal, |
+--------+-------+                     |   step, max_steps } |
         |                             +----------+----------+
         |  GET /api/tasks/:id/stream             |
         v          (SSE)                         |
+----------------+                                v
| Task strip UI  | <----- ticks ----- +---------------------+
| (step + cancel)|                    | Worker loop:        |
+----------------+                    |  - streamText       |
                                      |  - persist step     |
                                      |  - emit SSE tick    |
                                      |  - stop on done /   |
                                      |    cap / cancel     |
                                      +---------------------+
```

The worker is **the same Next.js route process** that received the
initial request — long-running HTTP, kept alive by the open SSE
stream from the browser. On reload, the browser reconnects to
`GET /api/tasks/:id/stream` and resumes from `step` in the DB row
(missed steps replay from `task_events`). This avoids needing a
real queue for v1.

Trade-off: closing the browser tab will eventually kill the worker
when Next.js times out the connection. We mitigate with a short
"finish or checkpoint" interval — every step persists progress so
re-connect resumes within a step.

## Phases

### Phase 1 — Schema + minimal runner (≈ 1.5 days)

**Migration** — `supabase/migrations/00XX_tasks.sql`:

```sql
create table tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  goal text not null,
  status text not null check (status in ('queued','running','done','cancelled','failed')),
  step int not null default 0,
  max_steps int not null default 25,
  result_message_id uuid references messages(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table task_events (
  id bigserial primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step int not null,
  kind text not null check (kind in ('thought','tool_call','tool_result','message','error','done')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index on task_events (task_id, step);
```

Per-user RLS on both tables — same pattern as `messages`.

**Routes:**

- `POST /api/tasks` — creates the row, kicks off the runner inline,
  returns the SSE stream of `task_events`.
- `GET /api/tasks/:id/stream` — re-attaches to a still-running task
  or replays the events log if `status = 'done'`.
- `POST /api/tasks/:id/cancel` — sets `status = 'cancelled'`; the
  runner polls `status` between steps and exits cleanly.

**Runner** — `lib/server/tasks/run.ts`:

```ts
while (step < max_steps) {
  if (await isCancelled(taskId)) break
  const step = await runOneStep(taskId, history, skills)
  await persistEvent(taskId, step)
  if (step.kind === 'done') break
}
```

`runOneStep` is one `streamText` call with `stopWhen: stepCountIs(1)`
so we can checkpoint after each tool call. The accumulated message
history is reconstructed from `task_events` on resume.

### Phase 2 — Chat integration (≈ 1 day)

- "Run as task" toggle next to the model picker in the chat header
  (visible only when imageGen / web search etc. are on — tasks
  without tools are just slow chat).
- `handleSendMessage` branches: if the toggle is on, POST to
  `/api/tasks` instead of `/api/chat`; the same SSE handling logic
  parses `task_events` and renders into the task strip + final
  message.
- A new `TaskStrip` component above the message list (live step
  counter + Cancel button). Collapses to a one-line "Task ran 12
  steps, finished at 14:32" badge once `status === 'done'`.

### Phase 3 — Cross-conversation surfacing (≈ half day)

- Sidebar conversation row gains a small green dot when a task
  finished while the user was elsewhere.
- Browser `Notification` (with user permission) on `status='done'`
  for any of the user's tasks, including the conversation title and
  the first 80 chars of the result.

### Phase 4 — Resume-on-reload (≈ half day)

The browser stores the active `task_id` in localStorage. On reload,
if the task's `status === 'running'`, auto-reconnect to its SSE
stream and re-attach the task strip. If `status` changed to `done`
/ `failed` while the tab was closed, hydrate the result into the
conversation and clear the localStorage entry.

### Phase 5 — Real queue (future, deferred)

When concurrent tasks per user become a real ask: swap the inline
worker for Inngest or pg-boss. The DB schema is queue-agnostic —
this is a runtime swap, not a data migration.

## Verification

End-to-end:

1. Send a `/task research the AI SDK release notes` prompt with web
   search on. Verify the task strip shows step counter, current tool
   call name, Cancel button.
2. Reload mid-task. Strip re-attaches, step counter continues from
   where it was within ~1 step.
3. Cancel mid-task. Strip collapses, no orphan `running` row left in
   `tasks`.
4. Close the tab mid-task, reopen 30s later. Browser notification
   fired when the worker exited; task row shows `done`; result
   message visible in the conversation.
5. RLS: a second user can't read another user's `tasks` rows.
6. Failure mode: kill the AI Gateway mid-stream. Task transitions to
   `failed` with a `task_events` entry; the strip shows an error.

## Out of scope

- True parallel sub-tasks. v1 is sequential.
- Task templates ("research workflow"). The slash-command + prompt
  library combination already covers that for chat; tasks just
  inherit the same templating if we want.
- Cross-user task sharing.
- Pause / resume on demand (only auto-resume on reload). Manual
  pause is a Phase 5 nicety.
