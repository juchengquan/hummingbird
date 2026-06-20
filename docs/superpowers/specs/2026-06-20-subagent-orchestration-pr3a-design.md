# Subagent orchestration PR-3a — spawned children in the task strip — design

Status: **approved design**, ready for implementation plan.
Date: 2026-06-20. Parent plan:
[`docs/PLAN-subagent-orchestration.md`](../../PLAN-subagent-orchestration.md)
(the first slice of PR-3 — client surfacing).

## Goal

When an orchestrator task spawns child subagents, surface them in the
task strip: a "Spawned N subagents" group, each child labelled by its
persona slug + subgoal, with a live status pill. This makes the
goal-decomposition visible. Drill-in (viewing a child run) and the
canvas node tree are deferred to PR-3b / PR-3c (see §Scope boundary).

## Background — the unblocking prerequisite

PR-2 emits a `handoff` event per spawned child, but it only carries
`agent` (persona slug) + `phase` — **not the child task id**. Without the
child id the client can't track per-child status. And `reduceRun`
currently **no-ops** the handoff event (`lib/shared/agent/project.ts:180`).
So PR-3a first puts the child id on the wire, then folds + renders it.

## Components & data flow

### 1. Wire — carry the child id

Extend `HandoffEvent` with `childTaskId` + `subgoal` (both optional, for
back-compat with any already-emitted handoff events and non-spawn
handoffs):

- **agent-py** (`services/agent-py/src/agent_py/`):
  - `events.py`: `HandoffEvent` dataclass gains `child_task_id: str | None = None`
    and `subgoal: str | None = None`; its `event_to_row_payload` branch
    writes `childTaskId` / `subgoal` (camelCase, matching the wire).
  - `emitter.py`: `handoff(...)` gains `child_task_id` + `subgoal` params.
  - `executor.py` (the Task-7 spawn loop): the `emitter.handoff(...)` call
    passes `child_task_id=child_id, subgoal=spec.subgoal` (both already in
    scope in the fan-out loop).
- **shared**:
  - `lib/shared/agent/events.ts`: `HandoffEvent` interface gains
    `childTaskId?: string` + `subgoal?: string`.
  - `lib/shared/agent/wire.ts`: `HandoffEventSchema` (Zod) gains the two
    optional fields, so a handoff event round-trips through
    `toDataPart` / `fromDataPart`.

The fields are optional so existing consumers + non-spawn handoffs are
unaffected; only the spawn path populates them.

### 2. Projection — fold handoff into the run view

- `lib/shared/agent/events.ts` (or wherever `TaskRunView` is defined):
  add `childRuns?: ChildRunRef[]` where
  `ChildRunRef = { childTaskId: string; agent: string; subgoal: string }`.
- `lib/shared/agent/project.ts` `reduceRun` `case "handoff"`: when
  `phase === "enter"` **and** `childTaskId` is present, append a
  `ChildRunRef` (dedup by `childTaskId`; ignore a handoff with no
  `childTaskId` — keeps the old no-op behaviour for non-spawn handoffs).
  Pure; folded idempotently by `seq` like every other event.

### 3. Live child status — a small endpoint

Per-child status without N SSE subscriptions:

- `GET /api/tasks/[id]/children` → `{ children: [{ id, status, goal }] }`
  for tasks where `parent_task_id = id`, RLS-scoped via the user client
  (mirror `app/api/tasks/[id]/cancel/route.ts`'s auth + `getSupabaseServerClient`).
- A `store` helper `listTaskChildren(db, parentId, userId)` (in
  `lib/server/agent/store.ts`) returning the rows.
- The response shape is pinned in `lib/shared/api-schemas.ts`
  (`TaskChildrenResponseSchema`) per the API contract.
- `lib/client/api-client.ts`: `apiClient.listTaskChildren(id)` — components
  must use this, never raw `fetch` (API-contract rule).

### 4. Task-strip group

`components/agent/task-strip.tsx`: a new "Spawned N subagents" section,
rendered after `PlanList` and before `ToolCallStrip`, shown only when
`view.childRuns?.length`. One row per child: persona slug + subgoal + a
status pill. Statuses come from `apiClient.listTaskChildren(taskId)`,
keyed by child id, **polled while the parent run is in-flight** (reuse
the strip's existing running state; poll on a modest interval, e.g. the
same ~1s cadence the stream uses, stopping when the parent settles).
Pills are **display-only** in PR-3a (no click/drill-in yet). A child with
no status row yet shows "queued".

## Error handling

- A `handoff` event without `childTaskId` → not folded (no-op), exactly
  as today. Malformed events already drop to `null` in `fromDataPart`.
- `listTaskChildren` failure → the group still renders the children from
  `childRuns` with a neutral/"queued" pill (status fetch is best-effort;
  never blocks the strip).
- No children → no group (length-gated).

## Testing

- **Wire round-trip** — a `handoff` event with `childTaskId` + `subgoal`
  survives `toDataPart` → `fromDataPart` (TS) and the agent-py
  `event_to_row_payload` → row → `event_from_row_payload` (Python),
  both preserving the fields.
- **`reduceRun` fold** — a handoff(enter, childTaskId, agent, subgoal)
  appends one `ChildRunRef`; a second handoff with the same `childTaskId`
  doesn't duplicate; a handoff without `childTaskId` is a no-op.
- **Endpoint** — `GET /api/tasks/[id]/children` returns the parent's
  children (RLS-scoped); shape matches `TaskChildrenResponseSchema`.
- **Strip group** — given a `view` with `childRuns` + a statuses map, the
  group renders N rows with persona/subgoal + the right pill; absent
  childRuns → no group.
- **Manual smoke (deferred, needs live model+DB)** — a real orchestrator
  spawns 3 subagents; the strip shows the group with persona/subgoal +
  pills transitioning queued→running→done as children settle.

## Scope boundary

- **PR-3a (this spec):** the wire `childTaskId`/`subgoal`, the `reduceRun`
  fold, the children-status endpoint, the task-strip group (display-only
  pills).
- **PR-3b:** drill-in — click a pill → a modal/sheet with its own
  `useTaskRun(childTaskId)` (the current single-run `TaskRunContext`
  can't show two runs concurrently, so this is net-new UI).
- **PR-3c:** canvas node tree — add a `"task"` `CanvasNodeKind` **and**
  make orchestrator tasks canvas nodes (they aren't today), then
  `placeRelatedNode` per child with derived edges.
- **agent-ts:** unaffected (the handoff/spawn path is agent-py only).

## Caveat

Like PR-2, the full path is only exercisable once the spawn loop is
live-smoke-verified (model + Postgres). PR-3a's tests prove the wire,
projection, endpoint, and render in isolation.
