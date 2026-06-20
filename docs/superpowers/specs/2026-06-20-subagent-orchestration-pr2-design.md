# Subagent orchestration PR-2 — spawn tool + fan-out + fan-in (agent-py) design

Status: **approved design**, ready for implementation plan.
Date: 2026-06-20. Parent plan:
[`docs/PLAN-subagent-orchestration.md`](../../PLAN-subagent-orchestration.md)
(PR-2 of the series; PR-1 = the schema + barrier, shipped #255).

## Goal

Wire the full orchestration loop in agent-py: a model can call a
`spawnSubagent` tool to decompose its goal into N child tasks, each
pinned to a subgoal (the `personaSlug` is recorded for labelling but
children run the parent's config in v1 — see §4.3); the executor fans
them out as child task rows, the parent yields;
when the last child settles, PR-1's barrier re-enqueues the parent, which
resumes with the children's results injected as the spawn tool's result
and synthesises an answer. Depth is capped at 1, breadth at
`MAX_CHILDREN`. agent-py only (agent-ts deferred to its real-step phase).

## Key reuse — the suspend/resume machinery

The real-model step fn (`make_anthropic_step_fn`) already has a
**gated-tool** path: a tool whose `execute` raises is detected by name,
the step returns early with a `pending_input` descriptor (no execution),
the executor saves a checkpoint recording the pending `tool_call_id` +
marks the run paused, and on resume (`execute_respond`) the human's
answer is injected as a `tool_result` for that `tool_call_id`.

Spawn is the **same shape** with two differences: (1) instead of pausing
for a human, the executor creates children and yields; (2) the
`tool_result` injected on resume is the **aggregated child results**, not
a human answer. So PR-2 adds a parallel "spawn" outcome alongside
`pending_input`, reusing the checkpoint+tool_result-injection pattern.

## Components & data flow

### 1. Spawn outcome IR — `runner.py`

- Add `SpawnSpec` (`persona_slug: str`, `subgoal: str`) and
  `SpawnDescriptor` (`tool_call_id: str`, `tasks: list[SpawnSpec]`).
- `RunStepOutcome` gains `spawn: SpawnDescriptor | None = None` (beside
  `done` and `pending_input`).
- `AgentLoopResultKind` gains `"spawned"`; `AgentLoopResult` gains
  `spawn: SpawnDescriptor | None = None`.
- In `run_agent_loop`, **before** the `done` check and after the
  `pending_input` check: `if outcome.spawn is not None: return
  AgentLoopResult(kind="spawned", spawn=outcome.spawn)`.

### 2. Spawn tool — `tools/spawn_subagent.py`

- `SPAWN_SUBAGENT_TOOL_NAME = "spawnSubagent"`.
- `build_spawn_subagent_tool() -> ToolDescriptor` with input schema
  `{ tasks: array<{ personaSlug: string, subgoal: string }> (1..MAX_CHILDREN) }`
  and an `execute` that raises `ToolError` (never executed inline — same
  as `ask_user`'s fallback).
- Registered in `default_tool_registry()` (always available; the model
  only calls it when decomposition helps).
- Description: "Decompose this goal into specialist subagents, each a
  persona pinned to a subgoal. They run in parallel; you resume with
  their results."

### 3. Step-fn detection — `providers/anthropic_provider.py`

In the tool-use handling loop, **before** the gated-tool branch, add:

```python
if tool_name == SPAWN_SUBAGENT_TOOL_NAME:
    specs = _parse_spawn_specs(_block_field(block, "input"))  # tasks → list[SpawnSpec]
    await ctx.emitter.tool_input(tool_call_id, tool_name, args)
    config.messages.append({"role": "assistant", "content": content_blocks})
    return RunStepOutcome(
        done=False,
        spawn=SpawnDescriptor(tool_call_id=tool_call_id, tasks=specs),
    )
```

(Appends the assistant turn carrying the `tool_use` block so the resume
path can match the `tool_call_id` and inject the `tool_result`. Mirrors
the gated-tool branch exactly, minus the execution.) `_parse_spawn_specs`
is a pure helper: validate/clamp the `tasks` array, drop malformed
entries, return `list[SpawnSpec]`.

### 4. Executor fan-out — `executor.py` (`_run_chunk` new `spawned` branch)

When `result.kind == "spawned"`:

1. **Depth cap.** Load this task's `parent_task_id` (a child has one). If
   non-null → depth>1 attempt: inject a `tool_result` for the spawn
   `tool_call_id` reading "Subagent spawning is not available here
   (depth limit)." into `live_messages`, save checkpoint, enqueue the
   parent's own `continue` job, return `settled=True`. (The model
   continues without children — no hard failure.)
2. **Breadth cap.** `specs = result.spawn.tasks[:MAX_CHILDREN]` (clamp;
   the input schema also caps, this is defence-in-depth).
3. **Create children.** For each spec: `child_id =
   store.create_child_task(pool, parent_task_id=task_id, user_id=…,
   conversation_id=…, goal=spec.subgoal, checkpoint=child_checkpoint)`
   then `jobs.enqueue_start_job(pool, task_id=child_id, user_id=…)`.

   **Persona resolution — v1 default (pinned, but explicit):** PR-2 does
   **not** introduce a server-side persona lookup. The child's
   `child_checkpoint.config` is **derived from the parent's checkpoint
   config** (same `model` + `workspaceSystemPrompt`), with the child's
   first user message set to the `subgoal`, and `parent_task_id` linking
   it. `spec.persona_slug` is **recorded** (in the child's checkpoint
   metadata + the parent's `awaiting_children` entry) so it labels the
   child in `handoff` events and the fan-in aggregation — but it does
   **not** change the child's model/prompt in v1. Rationale: agent
   personas (the `agents` slice) are not confirmed to be reachable as a
   server-side table from agent-py; resolving slug → model/systemPrompt
   server-side is a follow-up (noted in §Scope boundary). This keeps PR-2
   unblocked while still delivering true goal-decomposition + parallel
   fan-out/fan-in. A child therefore runs the parent's configuration
   pinned to its own subgoal — "specialised by subgoal," not yet "by
   persona model/prompt."
4. **Set the barrier counter.** `store.set_pending_children(pool,
   task_id, n=len(specs))`.
5. **Checkpoint the parent as awaiting.** Save a checkpoint with
   `awaiting_children = { tool_call_id, children: [{ id, persona_slug,
   subgoal }] }` plus the current `messages` (incl. the spawn assistant
   turn). No terminal status.
6. **Emit a `handoff` event per child** (persona + subgoal + child id) so
   the UI can render the tree later (PR-3).
7. **Yield**: return `ExecutorOutcome(settled=True)` — the parent job is
   done; the parent task stays non-terminal (status e.g. `paused` or a
   new marker; reuse `paused`).

### 5. New store + jobs helpers

- `store.create_child_task(pool, *, parent_task_id, user_id, conversation_id, goal, checkpoint) -> str` —
  `INSERT INTO tasks (id, user_id, conversation_id, goal, status, parent_task_id, checkpoint) VALUES (gen_random_uuid()…, 'queued', …) RETURNING id`.
- `store.set_pending_children(pool, *, task_id, user_id, n)` —
  `UPDATE tasks SET pending_children = $n WHERE id = $1`.
- `jobs.enqueue_start_job(pool, *, task_id, user_id)` — INSERT a `start`
  job (reuses the shared `ENQUEUE_*` INSERT shape; payload `{}`).

### 6. Settlement → barrier — `executor.py`

Replace the terminal `store.update_run(status=…, finished=True)` calls in
`_run_chunk`'s settled/cancelled paths with
`barrier.settle_task_terminal(pool, task_id=…, user_id=…, status=…)`.
For a top-level task this just sets terminal (parent_task_id null →
transition-only); for a child it decrements the parent and, at zero,
enqueues the parent's `continue` (PR-1 behaviour). The non-terminal
yield/suspend paths are unchanged (they don't settle the task).

### 7. Fan-in / resume — `executor.py` (`execute_continue`)

At the top of `execute_continue`, after loading the checkpoint: if
`checkpoint.awaiting_children` is present:
1. Query the children's terminal status + final text:
   `store.load_child_results(pool, parent_task_id=task_id, user_id=…) ->
   list[ChildResult]` where `ChildResult = { persona_slug, subgoal,
   status, final_text }`. `final_text` comes from each child's latest
   `result` event payload in `task_events` (or empty on failure).
2. `tool_result_text = aggregate_child_results(awaiting.children, results)`
   (pure helper, §8).
3. Inject `{ role: "user", content: [{ type: "tool_result",
   tool_use_id: awaiting.tool_call_id, content: tool_result_text }] }`
   into `live_messages`.
4. Drop `awaiting_children` from the checkpoint and proceed into
   `run_agent_loop` — the step fn now sees the spawn call + its result
   and continues to synthesis.

### 8. Aggregation helper — pure

`aggregate_child_results(children, results) -> str`: for each child, a
labelled block `### <persona_slug>: <subgoal>\n<final_text>`; a failed
child becomes `### <persona_slug>: <subgoal>\n[failed: <reason or
"no result">]`. Order matches the spawn order. Pure → unit-tested.

### 9. Events — `events.py`

Add a `HandoffEvent` dataclass (`kind="handoff"`, `agent: str`,
`phase: "enter" | "exit"`) to the agent-py `TaskEvent` union (the kind is
already in `TaskEventKind`; the union is missing the dataclass) and an
`emitter.handoff(agent, phase)` method that builds + appends it. Used to
mark each spawned child. Mirrors the TS `HandoffEvent` shape so the wire
stays aligned.

### 10. Caps & config

`MAX_CHILDREN = 5`, `MAX_DEPTH = 1` (constants in a small
`subagent_config.py` or beside the spawn tool); `MAX_CHILDREN`
overridable via env `MAX_SPAWN_CHILDREN` (parsed defensively, falls back
to 5). Depth is structural (a task with a `parent_task_id` may not
spawn), so `MAX_DEPTH` is effectively a constant guard, not a counter.

### 11. Cancel cascade — `app/api/tasks/[id]/cancel/route.ts`

After the existing parent `updateRun(status="cancelled")`, set its
unsettled children cancelled:
`db.from("tasks").update({ status: "cancelled", finished_at: now })
.eq("parent_task_id", id).eq("user_id", userId)
.not("status", "in", "(done,failed,cancelled)")`. Wrap in a small
`cancelChildTasks(db, parentId, userId)` helper in `lib/server/agent/store.ts`.
(The barrier's "only re-enqueue a live parent" guard already prevents a
cancelled parent from being resurrected by a late child settlement; this
cascade also stops the children themselves.)

## Tests

Unit (mocked pool / synthetic step fn — repo convention):

- **Spawn outcome → fan-out** (executor): a synthetic step fn returning
  `RunStepOutcome(done=False, spawn=…)` → `create_child_task` called N
  times, `enqueue_start_job` N times, `set_pending_children(n=N)`,
  checkpoint has `awaiting_children`, outcome `settled=True`, no terminal.
- **Depth cap**: a task with a non-null `parent_task_id` that emits a
  spawn outcome → no children created; a rejection `tool_result` is
  injected; a `continue` job is enqueued.
- **Breadth clamp**: a spawn outcome with > MAX_CHILDREN tasks → exactly
  MAX_CHILDREN children created.
- **Settlement routes through barrier**: the settled/cancelled paths call
  `settle_task_terminal` (assert it's invoked with the right status).
- **Fan-in aggregation** (pure): `aggregate_child_results` formats
  success + failure blocks in order.
- **Resume injection** (`execute_continue`): a checkpoint with
  `awaiting_children` + all children settled → a `tool_result` for the
  spawn `tool_call_id` is appended before the loop runs.
- **Spawn tool descriptor**: name/schema correct; `execute` raises.
- **Step-fn spawn branch**: a stubbed Anthropic stream yielding a
  `spawnSubagent` tool_use → `RunStepOutcome(done=False, spawn=…)`, no
  execution (mirror the gated-tool provider test).
- **`HandoffEvent`** round-trips through the union + emitter.
- **`_parse_spawn_specs`** (pure): drops malformed entries, clamps count.

Live smoke (deferred — needs `ANTHROPIC_API_KEY` + a real Postgres):
a real model calls `spawnSubagent` with 3 subgoals; 3 children run
concurrently; the parent resumes and synthesises; one child forced to
fail surfaces as a failure block, not a parent crash; cancelling the
parent cancels in-flight children. **This is the only path the unit
tests can't prove** (the model deciding to spawn + true cross-task
concurrency).

## Honest caveats

- Unit tests mock the DB + the model (repo convention), so they prove the
  control flow + the SQL/messages each path produces — **not** live
  concurrency or transactional atomicity. The barrier's race-freeness
  (PR-1) + the end-to-end spawn loop need the live smoke above.
- This is a large PR (~12 components across runner / provider / executor
  / store / jobs / events / tool / config + the Next cancel route). The
  plan decomposes it into bite-sized tasks; reviews run per task.

## Scope boundary

- **PR-2 (this spec):** everything above — the full spawn loop in
  agent-py, unit-tested; live smoke deferred.
- **Server-side persona resolution (follow-up):** resolve
  `personaSlug` → a child's own `model` + `workspaceSystemPrompt` +
  `allowedSkillIds` server-side, so children are truly persona-pinned
  (not just subgoal-pinned). Requires confirming/exposing the `agents`
  data as a server-readable table. Deferred from PR-2 to avoid blocking
  on that dependency.
- **PR-3:** client surfacing — the canvas node tree on spawn + the
  task-strip child group + child-run drill-in.
- **agent-ts mirror:** deferred to its real-step phase (its job schema is
  drifted; flagged in PR-1).
