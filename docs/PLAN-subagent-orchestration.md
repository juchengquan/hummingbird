# Plan: Subagent orchestration — parallel specialists for one goal

Status: **planning.** Drafted in the 2026-06-09 market refresh; item
from [MASTER_PLAN § Later](MASTER_PLAN.md) promoted to **Next**. Scope:
**L** (a phased PR series; needs the join barrier + guardrails up
front). Origin: the 2026 multi-agent-orchestration wave — see
[Sources](#sources).

## Why

Hummingbird has custom agents/personas (`agents` slice) and a durable
task queue (`task_jobs` + the executor/runner/RunStore pattern shared by
`services/agent-py` and `services/agent-ts`), but a task runs as a
**single** agent in a single context window. The 2026 orchestration
pattern — Claude subagents, supervisor/worker teams — decomposes a goal
across **specialised subagents**, each with its *own* context window,
run in parallel and gathered by an orchestrator. That sidesteps the
"one context window depletes and quality drops" failure mode and lets
each subagent carry only the persona + tools its subtask needs.

This is **distinct from Beam** (inspirations item #8: *same prompt → N
models*). Here it's *one goal → N specialised subtasks*, each a full
agent run. It composes three things Hummingbird already owns:

- the **personas slice** (`Agent`: model + `systemPrompt` +
  `allowedSkillIds` + `allowedMcpServerIds`) — a subagent *is* a
  persona pinned to a subgoal;
- the **durable task executor** (`execute_start` / `run_agent_loop` /
  `RunStore` idempotent on `(task_id, seq)`) — each subagent is a child
  task row;
- the **workspace canvas** — the orchestrator + its children render as
  a node tree (the Flowchat `placeRelatedNode` work).

## Non-goals — what this is NOT

- **Not autonomous peer-to-peer delegation.** No CrewAI-style symmetric
  hand-offs where agents bounce a task between each other — that's the
  documented "delegation ping-pong" OOM crash mode (inspirations
  skip-list). Strictly a one-level orchestrator → workers tree with a
  hard depth cap.
- **Not a new agent runtime.** Subagents reuse the *existing* executor,
  runner, RunStore, and TaskEvent IR. The only new machinery is the
  **spawn tool** + the **join barrier** that re-enqueues the parent when
  children settle.
- **Not Beam.** Same-prompt/N-model fan-out is a separate, simpler item
  (#8). This is goal-decomposition.
- **Not unbounded fan-out.** Fixed caps on depth (1 level v1) and
  breadth (N children) + the existing per-IP budget.

## Decisions to pin before code

1. **Topology — one level only (v1).** An orchestrator run may spawn
   children; **children may not spawn** (depth cap = 1). This kills the
   recursion/ping-pong risk outright. Lift to 2 levels later only with
   a hard global cap.
2. **Parallel, with a durable join barrier.** Spawning enqueues N child
   `start` jobs on `task_jobs`; the parent run **yields** (the runner's
   existing `kind: 'yielded'` path persists a checkpoint + re-enqueues —
   no terminal event). When the last child settles, a completion hook
   enqueues the parent's `continue` job. The parent resumes with the
   children's results injected as a synthetic `tool_output`. This reuses
   the chunk-yield mechanism the runner already has — no new run state
   machine, just a new *reason* to yield.
3. **Child isolation.** Each child is a normal task row with its own
   `RunEmitter` (own `seq`), own checkpoint (the picked persona's model
   + `systemPrompt` + `allowedSkillIds` + `allowedMcpServerIds` +
   subgoal), and own `task_events`. Full context isolation falls out of
   the existing per-task design for free.
4. **The spawn tool.** `makeSpawnSubagentTool(ctx)` (beside
   `makePlanTool` / `makeAskUserTool` in `lib/server/agent/`):
   `inputSchema { tasks: [{ personaSlug, subgoal }] (1..N) }`. It does
   **not** execute the children inline — it enqueues them and signals
   the runner to yield with a `pending_children` marker. (Same "no
   inline work" spirit as the gated tools.)
5. **Result aggregation.** Each child's `result.finalText` is collected
   into the parent's resume payload as a labelled block
   (`### <persona>: <subgoal>\n<finalText>`). The orchestrator's next
   step reasons over them. Failed children surface as a labelled
   failure block, not a hard parent failure — the orchestrator decides.
6. **Cancellation.** Cancelling the parent cascades a cancel to
   unsettled children (set their `tasks.status='cancelled'`; the
   runner's `isCancelled()` probe already short-circuits a running
   child at its next step).
7. **Persona resolution.** `personaSlug` resolves against the
   workspace's `agents` (the `(workspace_id, slug)` unique index). An
   unknown slug → the child runs with the workspace default model +
   prompt + a warning block (don't fail the whole orchestration on a
   typo).

## Shape — code surface

### Schema — children + barrier

`supabase/migrations/0024_subagents.sql`:

- `tasks` gains `parent_task_id UUID REFERENCES tasks(id)` (NULL for
  top-level) + `pending_children INT NOT NULL DEFAULT 0` (the barrier
  counter).
- Index `(parent_task_id)` for the completion sweep.
- A child-settlement trigger **or** an application-level decrement (see
  below) drives the barrier.

### Spawn tool — `lib/server/agent/spawn-subagent-tool.ts`

```ts
export function makeSpawnSubagentTool(ctx: SpawnCtx) {
  return tool({
    description: "Decompose this goal: spawn specialist subagents, each a persona pinned to a subgoal. They run in parallel; you resume with their results.",
    inputSchema: z.object({
      tasks: z.array(z.object({ personaSlug: z.string(), subgoal: z.string() })).min(1).max(MAX_CHILDREN),
    }),
    // no execute — the runner sees the call and yields with pending_children
  })
}
```

### Executor / runner — the yield + resume seam

This is the heart of the change and it lands in **both** services
(`services/agent-py/src/agent_py/` + `services/agent-ts/src/`),
byte-for-byte mirrored as the codebase already maintains them:

- **`executor`** — when the step fn reports a `spawn_subagents` outcome:
  (a) create N child task rows (`parent_task_id = self`, status
  `queued`), (b) `enqueueStartJob` for each, (c) set
  `tasks.pending_children = N`, (d) save a checkpoint marking the parent
  "awaiting children", (e) let the runner return `kind: 'yielded'` (the
  parent job finishes without a terminal event).
- **child settlement** — `mark_job_done` / `mark_job_failed` (already
  the Phase 2a settlement point) gains: if the settled task has a
  `parent_task_id`, atomically decrement the parent's
  `pending_children`; if it hits 0, `enqueueContinueJob(parent)` with
  the aggregated child results in the payload.
- **`runner.run_agent_loop`** — the injected `RunStepFn` already returns
  an outcome; add a `spawn` variant alongside `done`/`continue`. The
  loop emits `step_end` and returns `kind: 'yielded'` with a
  `pending_children` marker (no new terminal state). On resume, the
  orchestrator's checkpoint carries the aggregated results as a
  synthetic `tool_output` so the next step reads them naturally.

### Events — surfacing the tree

`lib/shared/agent/events.ts` (+ the Python mirror): reuse the existing
`handoff` event kind (already in the IR) for "spawned child <id>
(persona, subgoal)" and `step_end` for the join. No new event kind
needed for v1 — the parent's `task_events` reference child ids; the
client resolves child runs by id.

### Client — canvas + task strip

- `lib/shared/canvas/placement.ts` — on spawn, `placeRelatedNode(parent
  Canvas, orchestratorNodeId, { id: childTaskId, kind: 'conversation' })`
  for each child (the Flowchat auto-place pattern), so the orchestrator
  + children render as a node tree with derived edges.
- `components/agent/task-strip.tsx` — the orchestrator's strip shows a
  "spawned N subagents" group with per-child status pills (queued →
  running → done/failed), each linking to the child run's tail.

## Sequencing — PR series

1. **PR 1 — schema + barrier (no model wiring).** `0024` migration,
   `parent_task_id` + `pending_children`, the settlement decrement +
   parent re-enqueue, cancellation cascade. Tested with *synthetic*
   children (no real model) so the barrier logic is provable in
   isolation. Both services.
2. **PR 2 — the spawn tool + runner yield/resume.** `makeSpawnSubagent
   Tool`, the `spawn` step outcome, the yield + aggregated-results
   resume. Depth cap = 1, breadth cap enforced. Both services.
3. **PR 3 — client surfacing.** Canvas node tree on spawn + the
   task-strip child group + child-run drill-in.
4. **PR 4 (optional) — orchestration polish.** A "decompose this goal"
   affordance in the Tasks UI that seeds an orchestrator run; per-child
   model/persona override before launch.

## Tests

- **Barrier (PR 1)** — `pending_children` decrements exactly once per
  child settlement (idempotent against retries — the `task_jobs`
  `attempts` path can re-settle); parent re-enqueues exactly when the
  counter hits 0; cancellation cascades. Pure-ish against a test DB,
  mirroring the existing jobs/poller tests in both services.
- **Runner spawn outcome (PR 2)** — a `RunStepFn` stub returning a
  `spawn` outcome yields (no terminal event) and persists the marker;
  resume injects the aggregated `tool_output`. Reuses the runner's
  injected-step-fn test seam in both services.
- **Aggregation (PR 2)** — pure helper formatting child results
  (success + failure blocks, label ordering) into the resume payload.
- **Depth/breadth caps (PR 2)** — a child attempting to spawn is
  rejected; > MAX_CHILDREN tasks is clamped + reported.
- **Manual smoke (PR checklist)** — an orchestrator goal spawns 3
  specialists, all run concurrently (visible as parallel running pills),
  the parent resumes with all three results and produces a synthesis;
  one child forced to fail surfaces as a failure block, not a parent
  crash; cancelling the parent cancels in-flight children.

## Open questions before PR 1

1. **Settlement decrement: trigger vs application code.** A DB trigger
   on `tasks` status change is atomic but splits logic across SQL +
   app; an application-level decrement in `mark_job_done` keeps it in
   one place but must be transactional against retries. **Default:
   application-level inside the settlement transaction, `UPDATE … SET
   pending_children = pending_children - 1 … RETURNING pending_children`
   so the re-enqueue decision is race-free.**
2. **What the orchestrator sees of child *streams*.** Full child token
   streams would blow the parent's context. **Default: the parent sees
   only each child's `finalText` (+ failure reason); the live child
   streams are for the *user* via the canvas/task-strip, not the
   orchestrator model.**
3. **Budget accounting across the tree.** Children consume the same
   per-IP/user budget. **Default: each child run draws on the shared
   budget independently; a runaway fan-out is bounded by MAX_CHILDREN ×
   per-run caps. Revisit a per-orchestration budget envelope if needed.**
4. **MAX_CHILDREN / MAX_DEPTH values.** **Default: breadth 5, depth 1.**

## Reopen / future work

- **Depth > 1** — nested orchestration, only with a hard global node
  cap and cycle detection.
- **Streaming child summaries to the orchestrator** — periodic
  compaction of a child's progress fed back mid-run (needs the compact
  event, which the IR already has).
- **Shared scratchpad** — a workspace artifact children co-write
  (would need a write-conflict story; defer).
- **Beam convergence** (#8) — same-prompt/N-model fan-out could reuse
  the same spawn/join barrier with a degenerate "no decomposition"
  orchestrator.

## Sources

- [Anthropic — building multi-agent systems / Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Addy Osmani — the code agent orchestra](https://addyosmani.com/blog/code-agent-orchestra/)
- [CrewAI delegation ping-pong failure mode](https://azguards.com/technical/the-delegation-ping-pong-breaking-infinite-handoff-loops-in-crewai-hierarchical-topologies/)
  (the cautionary tale behind the depth cap)
