# Plan: Queue-backed continuation (durable background execution)

Status: **📋 proposed (architecture).** This is the deferred Phase 6 of
`PLAN-agent-hitl-approvals.md` and the queue half of
`PLAN-long-running-tasks.md` Phase 5. The HITL design ships v1 with the
**user's browser** driving every continuation (the click on Approve
starts a fresh function via `POST /api/tasks/:id/respond`). That works
but constrains the model: closing the tab kills any work that hasn't
suspended, runs longer than the serverless execution cap get truncated,
and there's no way to retry on transient failures or run a task on a
schedule. This doc proposes the next step — moving continuations onto a
**job queue + worker**, leaving the rest of the design intact.

## What the browser-driven v1 can't do

| Gap | Why it doesn't work today |
|---|---|
| **Survive a closed tab.** A user starts a 10-step task and closes the tab mid-step. | The `POST /api/tasks` request is the only thing driving the loop; closing the tab aborts it and the run gets reconciled to `failed`. |
| **Run beyond the serverless cap.** A research task that legitimately needs ~10 min. | The function is bounded by the deploy target's execution limit (60 s / 300 s / 900 s) — the run gets truncated even with steps left. |
| **Auto-retry transient errors.** A model-provider 502 mid-stream. | The request is the loop; a network error ends the request, the run goes to `failed`. |
| **Scheduled / recurring tasks.** "Run this prompt every morning at 8." | No scheduler; tasks only start in response to a user click. |
| **HITL while away.** User approves on mobile but doesn't keep a tab open after. | Without a worker, the continuation has nowhere to run when the user closes the responding tab. |

The HITL plan already paid the **durability** cost (Phase 1 — checkpoint
+ emitter seed). Phase 6 cashes it in: a worker can pick up from any
checkpoint, so the loop no longer has to fit in one invocation.

## Design overview

The HTTP routes become **producers** that enqueue jobs and return
immediately; a **worker** consumes jobs and runs the agent loop in
background invocations. The browser watches via the resume stream.

```
client ─POST /api/tasks──────► enqueue START job ──► 202 { runId }
                                                     │
                                                     ▼
                                              ┌──────────────┐
client ◄── GET /api/tasks/:id/stream ◄────────│   task_jobs  │
        (events as they're persisted)         │  + worker(s) │
                                              └──────────────┘
                                                     ▲
client ─POST /api/tasks/:id/respond──► enqueue RESPOND job ──► 202
```

### The job table

`task_jobs` (migration TBD):

| Column | Purpose |
|---|---|
| `id` | uuid pk |
| `task_id` | FK → `tasks.id` |
| `user_id` | RLS scope (own-your-rows) |
| `action` | `'start'` \| `'respond'` \| `'continue'` (chunk) |
| `payload` | jsonb — action-specific (e.g. respond's `{requestId, approved, …, mcpServers}`) |
| `status` | `'queued'` \| `'running'` \| `'done'` \| `'failed'` |
| `attempts` | int — retry counter |
| `max_attempts` | int — retry ceiling |
| `scheduled_at` | timestamp — for backoff / future scheduling |
| `started_at` / `finished_at` | for observability |
| `error` | jsonb — last failure detail |

Index: `(status, scheduled_at)` so the worker can `select … where status='queued' and scheduled_at <= now() order by scheduled_at for update skip locked limit 1`.

### Action handlers (one worker function per kind)

All three reuse the existing `runAgentLoop` + checkpoint machinery:

- **`start`** — load run config + initial `messages` from the task row, build tools, run loop. On suspend: checkpoint, emit `paused`. On settle: emit terminal.
- **`respond`** — load checkpoint, append the human's tool result message (binary approval / choice / input — same code paths as today's `/respond`), build tools, continue loop. Same suspend/settle behaviour.
- **`continue`** (new — chunking) — load checkpoint, no input injection, just keep going. Emitted by the worker itself before the execution cap hits: *"I've used X seconds, checkpoint and re-enqueue."* See *Chunking* below.

### The worker (deployment-agnostic)

The handler logic lives in `lib/server/agent/jobs.ts` as a pure
function `processNextJob(db)` that:

1. Atomically claims one ready job (`UPDATE … RETURNING` with
   `SKIP LOCKED`).
2. Dispatches on `action`.
3. Drives the loop, emitting events into `task_events` (and to
   Realtime/poll-tail consumers).
4. On success → `status='done'`. On retryable error → bump `attempts`,
   set `scheduled_at = now() + backoff(attempts)`. On terminal failure
   → `status='failed'`, mirror onto the `tasks` row.

`processNextJob` is the contract. *How often it runs* is the
deploy-target's problem:

| Deployment | How it runs |
|---|---|
| Vercel | `vercel.json` cron hits `/api/jobs/tick` every minute; the handler runs a few `processNextJob`s before its cap. Latency: ≤ 1 min to start a job. |
| Vercel + Inngest | An Inngest function subscribes to `task_jobs.created` (via a small enqueue hook) and calls `processNextJob`. Latency: ~seconds. Adds an external dep. |
| Self-host | A small Node process loops `processNextJob` continuously (or `pg-boss` does it). Latency: sub-second. |
| Supabase Edge Function + `pgmq` | An edge function subscribes to the `pgmq` queue; effectively the same as Vercel + Inngest but Supabase-native. |

The recommendation for v1: **start with the Vercel cron path** (no new
infra), because it's the smallest delta from where we are and the
existing app already deploys to Vercel. Move to Inngest or a dedicated
worker once polling latency or job volume hurts.

### Chunking — beating the execution cap

Without HITL, today a 25-step run has to finish in one function
invocation. With the queue, the worker can voluntarily checkpoint
mid-run when it's nearing the cap:

```ts
// Pseudo
const deadline = Date.now() + (FUNCTION_CAP_MS - SAFETY_MARGIN)
runAgentLoop({
  …,
  shouldYield: () => Date.now() > deadline,
})
// On yield: same code path as a HITL suspend — checkpoint + return.
// The worker enqueues a `continue` job for next tick.
```

`runAgentLoop` already returns `AgentLoopResult` (settled / suspended) —
we add a `yielded` variant for this path. The HITL "suspend" was the
precedent; this is the same primitive applied to time.

This **removes the execution-cap ceiling on task length** — a run can
take an arbitrary number of chunks.

### The new role of the resume stream

`GET /api/tasks/:id/stream` already exists (Last-Event-ID replay +
poll-tail). It becomes the primary stream for *every* run, not just
reconnects:

- `POST /api/tasks` returns `{ runId }` immediately.
- The client opens `GET /api/tasks/:id/stream` and folds events as they
  arrive — initially the worker hasn't started, so the stream is empty;
  once the worker picks up, events flow.
- Same for `respond`.

The current `POST /api/tasks` streaming path goes away (the route
becomes a thin enqueue). The client's `useTaskRun.start` / `respond`
gain a small change: after the POST returns, open the resume stream.

If we adopt **Supabase Realtime** for `task_events`, the resume stream
becomes truly push-based (sub-second latency) — same wire format, just
a different transport under the GET endpoint. That's also the
deferred-realtime item from `PLAN-agent-tasks-followups.md` — Phase 6
naturally subsumes it.

## HITL flow with the queue

1. User submits prompt → `POST /api/tasks` enqueues a `start` job → 202.
2. Browser opens the resume stream and shows "Queued" status (a new
   leading status event the route emits inline before returning 202).
3. Worker picks up; emits `status: running`; streams events.
4. Model calls a gated MCP tool → worker saves checkpoint, emits
   `approval:request` + `status: paused`, returns. Job done.
5. Browser sees `paused`. User can close the tab — the run is dormant
   until they respond.
6. Later, user clicks Approve → `POST /respond` enqueues a `respond`
   job → 202. Browser opens (or already has open) the resume stream.
7. Worker picks up, executes the MCP tool, continues the loop. Events
   flow to the browser via the stream.
8. Settle. The result lands in the conversation as a normal message
   (the client-author guard still fires on running→done, on whatever
   browser happens to be subscribed when the terminal event arrives;
   if no browser is around, the message is authored when one reattaches
   via resume — same behaviour as today's reload path).

The user can switch devices between (1) and (6); their original tab can
be closed at (4); they can re-open later and resume — the worker drives
everything.

## Migration / phasing within Phase 6

1. **`task_jobs` table + worker shell** — migration; `enqueueJob`,
   `processNextJob`; unit tests for dispatch.
2. **`continue` action + chunking** — adds `shouldYield` to
   `runAgentLoop`, the new `AgentLoopResult: 'yielded'`, and worker
   re-enqueue. Lands as a pure improvement to long runs (no HITL change
   yet). This also benefits all current tasks.
3. **`start` action** — move the loop body of `POST /api/tasks` into
   the worker; route becomes enqueue + 202; client `useTaskRun.start`
   opens the resume stream after enqueueing.
4. **`respond` action** — same for `/respond`. Removes the dual-path
   tension where HITL has two ways to continue.
5. **Cleanup** — delete the inline streaming machinery from POST
   routes. Surface a "Queued" status event in the UI for the brief
   pre-pickup window.
6. **(Optional) Realtime swap** — `task_events` channel; the resume
   stream endpoint forwards Realtime push instead of polling. Cuts
   reconnect-to-first-event latency from ~1 s to sub-second.
7. **(Optional) Scheduling** — a `task_schedules` table + cron
   resolver that periodically enqueues `start` jobs from a cron
   expression. Unlocks "run every morning."

## Trade-offs / open questions

- **Pickup latency.** Cron-polled: ≤ 1 min. Inngest/pg-boss/realtime:
  seconds or less. Mitigated by surfacing a "Queued" status so the user
  isn't staring at a blank panel.
- **Local-mode MCP creds.** The browser holds them; a background worker
  can't reach them. Strategies: (a) keep local-mode runs browser-driven
  via a dual path (worst), (b) require local-mode users to keep a tab
  open until settle (acceptable v1), (c) push them to Supabase
  (encrypted) on enqueue and TTL-evict (a real engineering effort).
  v1 recommendation: (b) with a clear UI note.
- **Two transports during migration.** During phases 3–5 we'll briefly
  have inline-streaming routes coexisting with the queued worker.
  Easy to manage with a feature flag on the routes.
- **Job dedup / idempotency.** Double-click on Approve enqueues two
  `respond` jobs. Dedup on `(task_id, payload.requestId)` while
  `status` is `queued`/`running`. The append-only event log already
  handles duplicate emits via `(task_id, seq)`.
- **Worker observability.** Job table + simple admin page (per-user
  list of recent jobs with status + last error) covers v1; metrics
  later.
- **Backpressure / fairness.** A single user can't monopolise the
  worker. Per-user job-count cap + round-robin claim ordering.
- **Cost model.** The cron-polled v1 runs `processNextJob` once a
  minute regardless of load — cheap and predictable. Realtime/Inngest
  scales with actual work.

## Relationship to other plans

- **`PLAN-agent-hitl-approvals.md`** — Phase 6 of that plan IS this
  doc. The checkpoint foundation is the shared substrate.
- **`PLAN-long-running-tasks.md`** Phase 5 ("Real queue: swap the
  inline worker for Inngest or pg-boss") — same change, told from the
  long-running-task angle. This doc subsumes it.
- **`PLAN-agent-tasks-followups.md`** — Phase 6 closes the "realtime
  tail (deferred)" item via step 6 (optional realtime swap).
- **`PLAN-agent-api.md`** — the agent-service split. Phase 6 makes the
  in-process worker easy to lift into a separate service later: the
  worker contract is the same; only deployment changes.

## Recommendation / next step

The smallest valuable first PR: **steps 1 + 2** (job table + chunking),
which removes the execution-cap ceiling without changing any client
behavior or HTTP contracts. It buys real value for current long tasks,
proves the worker shell, and leaves the `start` / `respond` migrations
(steps 3–4) for a follow-on PR where the UX surface change is staged
deliberately.
