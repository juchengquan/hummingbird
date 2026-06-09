# Plan: Proactive / ambient event-triggered agents

Status: **planning.** Promoted from [MASTER_PLAN § Later](MASTER_PLAN.md)
(third research round, 2026-06-09) to **Next**. Scope: **M–L** (needs a
careful trigger model + loop guards). Origin: the 2026 shift from
user-initiated to event-driven agents — see [Sources](#sources).

## Why

Hummingbird already runs agents on a **clock**: `task_schedules`
(migration `0019`) + `nextRunFromCron` + `dispatchDueSchedules` in the
tick loop fire a task on a cron schedule (PR #100). The 2026 shift is
from *scheduled* to **event-driven** — an agent runs on a *signal*
(a file uploaded, a bookmark added, a watched condition met), not just a
clock or a chat prompt. That turns the existing task queue into an
**ambient-agent substrate**: "when X happens, run persona Y with goal
Z." It's a small, natural extension of the schedule dispatcher that
reuses the entire executor + HITL + notification stack.

## Non-goals — what this is NOT

- **Not a new runtime.** Triggers enqueue tasks on the *existing*
  `task_jobs` queue; the executor/runner/RunStore handle them
  unchanged.
- **Not unbounded autonomy.** Every trigger has explicit scope + rate
  limits + loop guards; an agent action can't recursively re-fire its
  own trigger.
- **Not external webhooks (v1).** v1 triggers on **internal** events
  (store mutations — file/bookmark/note added, a task finished). An
  external-webhook source is future work.
- **Not always-on background polling of the world.** Event-driven off
  internal signals + the existing tick; no new always-on watchers
  beyond the dispatcher that already runs.

## Decisions to pin before code

1. **Trigger model.** A `task_triggers` row: `{ event_kind, filter,
   persona_id, goal_template, enabled, rate_limit, last_fired_at }`.
   `event_kind` ∈ a fixed enum (`file.added`, `bookmark.added`,
   `note.added`, `task.finished`, …). `filter` is a small predicate
   (e.g. file mime-type / name glob). `goal_template` interpolates the
   event payload.
2. **Event source (v1).** Internal store mutations. The cleanest hook
   is **server-side**: events that already pass through the sync layer /
   server routes (file upload → `/api/extract`, bookmark add) emit an
   event the dispatcher evaluates. Avoids trusting the client to fire
   triggers.
3. **Dispatch.** Extend the existing tick that runs
   `dispatchDueSchedules` to also run `dispatchMatchingTriggers(event)`
   — same enqueue path (`enqueueStartJob`), same executor.
4. **Loop guards (critical).** A trigger fired by an agent's own action
   must not re-fire indefinitely. Guards: a per-trigger rate limit, a
   cooldown (`last_fired_at`), an origin tag on agent-produced events so
   a trigger ignores events its own runs created, and a global
   per-window cap.
5. **HITL by default for side-effecting triggers.** A triggered run
   that would take a consequential action surfaces an approval
   (existing `askUser` / approval card) unless the user marked the
   trigger auto-approve. Ambient ≠ unsupervised.
6. **Notification.** Reuse the finish-while-away notification so a
   triggered run that completes (or needs approval) reaches the user.

## Shape — code surface

### Schema — `task_triggers`

`supabase/migrations/0025_task_triggers.sql` — the table + RLS +
indexes on `(event_kind, enabled)`. Mirrors `task_schedules`'s shape +
RLS.

### Event emission + dispatch

- `lib/server/agent/events-source.ts` — a small `emitDomainEvent(kind,
  payload, { originRunId? })` called from the server routes that own the
  relevant mutations (extract/upload, bookmark add, task settle).
- `dispatchMatchingTriggers(event)` — evaluates enabled triggers'
  filters, applies the loop guards + rate limit, interpolates the
  `goal_template`, and `enqueueStartJob` with the matched persona's
  scope. Lives beside `dispatchDueSchedules`; the tick calls both.

### Client — trigger management

- A "Triggers" section in the workspace detail sheet (beside the
  existing Schedules section): create/edit/enable a trigger
  (event kind + filter + persona + goal template + auto-approve).
- Reuses the Tasks panel for the resulting runs (a triggered run is a
  normal task with a `trigger` origin badge).

## Sequencing — PR series

1. **PR 1 — schema + dispatch (one event kind).** `0025` migration,
   `emitDomainEvent` + `dispatchMatchingTriggers`, the loop guards +
   rate limit, wired to a single event (`file.added`). Tested with
   synthetic events (no UI). Proves the guard logic in isolation.
2. **PR 2 — more event kinds + trigger UI.** `bookmark.added`,
   `note.added`, `task.finished`; the workspace Triggers section;
   HITL-by-default for side-effecting triggers.
3. **PR 3 — service-backend parity + origin guards hardening.** Python/
   TS dispatch parity; stress-test the loop guards (agent action that
   would re-fire its own trigger is suppressed).
4. **PR 4 (future) — external webhook source.** An inbound webhook
   endpoint as an `event_kind` so external systems can trigger agents.

## Tests

- **Loop guards (PR 1)** — a trigger respects its cooldown + rate
  limit; an event tagged with the trigger's own origin run is ignored;
  the global per-window cap holds. The crux — tested hard, mirroring
  the subagent barrier tests.
- **Filter matching (PR 1)** — a `file.added` trigger with a mime/glob
  filter fires only on matching uploads.
- **Dispatch enqueue (PR 1)** — a match enqueues a `start` job with the
  right persona scope + interpolated goal.
- **Manual smoke** — a "summarise every PDF I upload" trigger fires on a
  PDF upload, runs the persona, and the result + notification arrive;
  uploading a non-PDF doesn't fire; the triggered run's own outputs
  don't re-fire the trigger.

## Open questions before PR 1

1. **Server-side vs client-side event source.** Server is
   trustworthy + works headless; some events only exist client-side.
   **Default: server-side for the events that pass through routes
   (upload/extract, bookmark add, task settle); client-only events
   deferred.**
2. **Goal templating.** How much of the event payload can the goal
   reference? **Default: a small whitelist (`{file.name}`,
   `{bookmark.url}`, …); no arbitrary interpolation.**
3. **Default approval posture.** **Default: HITL-approve for any trigger
   whose persona has side-effecting tools (browse / code-interpreter /
   MCP writes); auto-run only for read/summarise personas.**

## Reopen / future work

- **External webhooks** (PR 4) — turn Hummingbird into an event sink for
  other systems.
- **Conditional/threshold triggers** — "when my context meter crosses
  X", "when N files accumulate."
- **Pairs with subagent orchestration** — a trigger could launch an
  orchestrator run, not just a single agent.

## Sources

- [Ambient agents — proactive AI](https://earlybirdlabs.com/insights/what-are-ambient-agents)
- [From events to actions: understanding ambient agents](https://medium.com/@vondevelopment/from-events-to-actions-understanding-ambient-agents-86d0c5641f50)
- [Chat agents vs ambient agents](https://www.walturn.com/insights/chat-agents-vs-ambient-agents-two-paths-to-ai-driven-assistance)
