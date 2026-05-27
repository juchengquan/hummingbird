# Plan: Agent tasks — follow-ups after the runner→UI slice

Status: **🛠️ mostly shipped.** Builds on the long-running-task stack:
event-model core ([#66](https://github.com/juchengquan/hummingbird/pull/66)),
persistence ([#68](https://github.com/juchengquan/hummingbird/pull/68)),
the runner → route → resume → task-card UI → polish slices
([#69](https://github.com/juchengquan/hummingbird/pull/69)), and the
hybrid UI + durable result ([#72](https://github.com/juchengquan/hummingbird/pull/72)).
Workstreams #1–#5 plus the MCP / budget / resume-on-reload grab-bag are
now implemented; only the two architectural items (realtime tail, HITL
approvals) remain deferred — see the marks below.

## What already exists

The task backend is built and runs **in-process** in Next.js route
handlers (no separate service — the `PLAN-agent-api.md` split is still
just a plan):

| Piece | Location |
|---|---|
| Start + stream | `app/api/tasks/route.ts` |
| Cancel | `app/api/tasks/[id]/cancel/route.ts` |
| Resume / replay | `app/api/tasks/[id]/stream/route.ts` |
| Runner loop + step | `lib/server/agent/runner.ts` |
| Persistence store | `lib/server/agent/store.ts` |
| Row codec | `lib/server/agent/persistence.ts` |
| Tables (`tasks`, `task_events`) | `supabase/migrations/0012_tasks.sql` |
| Client hook | `lib/client/hooks/use-task-run.ts` |
| Stream decoder | `lib/shared/agent/stream.ts` |
| In-flight surface | `components/agent/task-strip.tsx` |
| Sidebar dot | `components/agent/task-status-dot.tsx` |
| Resume pointer + notify | `lib/client/agent/{active-task,notify}.ts` |

So the verbs (`start`/`cancel`/`resume`/`stream`/`fold`/`render`) all
exist. The gaps are integration, a few backend additions, and
robustness.

## Workstreams

### 1. Hybrid UI — chat entry + dedicated Tasks panel — ✅ shipped (#72)

Today there is **no UI entry point**: slices 6–9 are reachable only
from code. Make the feature usable.

**Why not inline-in-chat.** A task is async and long-lived — you fire
it and come back. The chat thread is turn-based and singular; a
5-minute / 25-step run clutters it, one inline strip can't show
multiple runs or a history, and the conversation should stay the record
of *answers*, not a live console. So we split entry from control:

- **Chat = entry point + durable result.** The prompt *is* the task
  goal (natural launch point), and the settled answer lands back in the
  thread as a normal assistant `Message` (workstream #2 makes this the
  server-side record). The conversation reads normally on reload.
- **Tasks panel = the live control room.** A new toggleable panel
  (alongside `SourcesSidebar` / `EditorSidebar`) lists in-flight and
  recent runs and expands the selected one to the full live
  `TaskRunView`. This is where progress, the plan/todo, tool pills,
  streaming text, and Cancel live — and it naturally holds *multiple*
  and *past* tasks.

This fits the app's existing multi-panel architecture (toggleable
panels driven by the Zustand store, per `CLAUDE.md`), and it's the
shape that doesn't need redoing once concurrent / background tasks
arrive (#6, Phase 5).

**Pieces:**

- **Launch:** a **"Run as task"** toggle next to the model picker in the
  chat header (mirror `PLAN-long-running-tasks.md` Phase 2). When on,
  `handleSendMessage` (`components/panels/chat.tsx`) drives
  `useTaskRun().start(...)` instead of `apiClient.chat.stream`, and
  opens the Tasks panel.
- **Inline affordance:** a minimal, collapsed `TaskStrip` row in the
  thread — "Task running · step N/M · view →" — that focuses the panel
  on click. Not the full surface; just a pointer + status so the user
  knows where it went. (`TaskStrip` already collapses to a one-liner on
  settle; add a compact `variant="inline"`.)
- **Tasks panel** (`components/panels/tasks.tsx` + a
  `TasksSidebar`): a run list (status dot + goal + step counter, newest
  first) over the top, the selected run's full `<TaskStrip>` below.
  Store wiring mirrors the other panels (`lib/hooks/use-store.ts`:
  `tasksPanelOpen`, width, `activeTaskId`).
- **State:** lift `useTaskRun` to a small provider/store so both the
  chat strip and the panel read one source of truth, and so a run
  survives navigating between conversations. Persist the active run via
  the existing `active-task` pointer (already built) for resume-on-reload.
- **Settle:** result becomes a `Message` (see #2); the panel row flips
  to a "finished · N steps" badge; the inline strip collapses.

**Sketch (panel layout):**

```
┌─ Tasks ───────────────────────────┐
│ ● Research AI SDK notes  3/25  ⏵   │ ← run list (active highlighted)
│ ✓ Summarize Q3 deck      done      │
│ ✗ Scrape pricing table   failed    │
├────────────────────────────────────┤
│ Running · Step 3 / 25      [Cancel] │ ← selected run = full TaskStrip
│ ▸ plan / todo                       │
│ 🌐 Searching the web for "…"        │
│ streaming answer text…              │
└────────────────────────────────────┘
```

Depends on nothing (uses existing `useTaskRun` / `TaskStrip` /
`TaskStatusDot`). Highest value — without it the rest is dormant. The
two days vs. one reflects the extra panel + shared-state lift over the
old inline-only plan; the payoff is the design survives concurrency.

### 2. Materialize the result as a durable Message — ✅ shipped (#72, client-authored)

> Shipped as a **client-authored** message on settle rather than the
> server-side insert below: the app is local-first with client→server
> push sync, so a server insert would fight the sync model. The original
> design is kept for context.


The route persists `task_events` but **never writes the answer into
`messages` nor sets `tasks.result_message_id`** (the column and the
`updateRun` patch field exist but are unused). A finished task
therefore leaves no row in the conversation thread — a reload shows the
event log but no assistant bubble.

- On `result: done`, insert the assistant message
  (`finalText` / accumulated token text) into `messages`, scoped to
  `conversation_id` + `user_id`.
- Call `updateRun(..., { resultMessageId })` to link it.
- Decide ownership: server-side insert (survives a client that
  navigated away) is preferred over relying on workstream 1's
  client-side hoist. Do the server insert; the client hoist becomes a
  pure projection of it.

Pairs naturally with #1.

### 3. Orphaned-run reconciliation — ✅ shipped

> `reconcileStaleRuns` (liveness judged by latest `task_events` row, not
> `tasks.updated_at`) + `appendSyntheticResult`; wired into the resume
> endpoint (GC on reconnect) and `POST /api/tasks/sweep`.


If the serverless function is killed mid-run (the execution-cap risk
from `PLAN-agent-api.md`), the `tasks` row is stuck `running` forever —
nothing reconciles it, and resume poll-tails until its wall-clock cap.

- A sweeper that marks runs `failed` when `status='running'` and no
  `task_events` row in the last N minutes (cron route, or a check on
  the next `getRun`).
- Emit a synthetic `result: failed` event so the resume stream and the
  projection settle cleanly rather than hanging.

Priority scales with the deploy target: critical on capped serverless,
deferrable on a long-cap / self-host target.

### 4. Produce `plan` / todo events — ✅ shipped

> A run-scoped `setPlan` tool emits `plan` events (suppressed from the
> tool-pill strip via the runner's `silentTools`); system prompt tells
> the model to plan up front.


`TaskStrip` renders a plan list, but `makeStreamTextStep` never emits
`plan` events — the section is permanently empty.

- Add a `setPlan` / `updatePlan` tool the model calls (writes
  `emitter.plan(items)`), **or** a lightweight planning step at run
  start that seeds the todo list.
- Update items to `in_progress` / `completed` as steps advance.

Self-contained; makes the existing UI meaningful.

### 5. Coalesce token persistence — ✅ shipped

> `makeTokenCoalescer` buffers deltas per channel and emits one `token`
> event per ~96 chars (deviates from the plan's "per-token on wire" —
> coalesces wire + disk together for simplicity/correctness; ~96-char
> chunks still read as live).


Every token is a separate `task_events` insert, serialized through the
persistence chain and drained at end-of-request — a long run is
thousands of writes and a slow tail.

- Keep per-token frames **on the wire** (smooth streaming) but
  **batch** them on disk: accumulate token deltas and flush one
  coalesced `token` event per step boundary (or every ~250 ms / N
  chars).
- Resume fidelity is preserved — `reduceRun` folds a coalesced token
  the same as many small ones; the cursor just advances in bigger hops.

### 6. Smaller items

- ✅ **MCP tools in the task route.** Cloud-mode looked up server-side
  from `workspaceId` (already sent); local-mode accepted via
  `mcpServers` in the schema (client wiring for local-mode is the one
  remaining sub-item — cloud-mode works as-is).
- ✅ **Per-IP budget gate.** The task route now gates skill tools behind
  the same sliding-window buckets as chat (image gen tighter).
- ✅ **Reload auto-resume + notification-permission UX.** Provider reads
  the persisted pointer on mount and reconnects; enabling task mode
  requests Notification permission.
- 🔶 **Route-level integration tests.** Pure units are covered
  (`setPlan` emit, token coalescer, decoder, codec, runner control
  flow). Full handler tests (auth + sink + persistence chain) need a
  Supabase + AI-SDK harness the repo doesn't have yet — still open.
- ⬜ **Poll-tail → realtime (deferred).** Swap the resume endpoint's 1 s
  poll for Supabase Realtime / `LISTEN/NOTIFY`. Needs infra; the poll
  works for v1.
- ⬜ **Human-in-the-loop approvals (deferred).** The `approval` events
  are reserved but unused. Wiring them means the runner must *pause*
  across function invocations and wait for an approve/reject — which
  doesn't fit the single-invocation runner; it depends on the durable-
  execution / queue work (`PLAN-long-running-tasks.md` Phase 5).

## Recommended sequencing

Workstreams #1–#5 and the tractable #6 items are done. The two remaining
(realtime tail, HITL approvals) are architectural and deferred: realtime
needs Supabase Realtime infra; HITL needs durable cross-invocation pause
(Phase 5 of `PLAN-long-running-tasks.md`). Route-level integration tests
remain a worthwhile follow-up once a Supabase/AI-SDK test harness exists.

## Out of scope

- The standalone agent-service split (`PLAN-agent-api.md`) — a separate,
  larger decision; everything here keeps the in-process Next.js backend.
- True parallel sub-tasks and a real job queue
  (`PLAN-long-running-tasks.md` Phase 5) — deferred until concurrent
  tasks per user are a real ask.
