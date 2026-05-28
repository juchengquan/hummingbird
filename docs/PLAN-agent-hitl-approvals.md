# Plan: Human-in-the-loop approvals for agent tasks

Status: **📋 proposed (architecture).** The `approval` event kind and the
`paused` status are already reserved in the event IR
(`lib/shared/agent/events.ts`); nothing drives them yet. This doc
designs the foundational change needed to make them work — pausing a run
for a human decision and resuming it later — and proposes a v1 that
ships **without** a job queue.

## Goal

Before the agent runs a sensitive tool (a destructive MCP action, a
spend, an irreversible write), it should **pause and ask the human**:
"Approve / Reject this action?" — and only continue once answered, with
the tool either executed or skipped.

## Why it doesn't fit today

A task runs **entirely inside one serverless invocation**: `POST
/api/tasks` opens a stream and `runAgentLoop` drives the whole loop to a
terminal event, holding the function open the whole time. "Wait for a
human" would mean holding that function open for minutes or hours, which
the execution cap (60 s / 300 s / 900 s) forbids and which wastes
compute.

So a run must be able to **suspend** (free the function, persist its
state) and **resume in a *fresh* invocation** later — durable execution.
That state-survival is the foundational change; approvals are the first
consumer of it.

## What we already have (and what's missing)

| Have | Missing for HITL |
|---|---|
| `task_events` append-only log + `seq` cursor | A durable **checkpoint** of the model `messages` history so a new invocation can continue |
| `tasks.status` incl. `paused`; `approval` event kind | Folding `approval` into the view + a `pendingApproval` field |
| Per-step checkpointing (`stopWhen: stepCountIs(1)`) | Detecting an approval-gated tool call and **suspending** instead of looping |
| Resume endpoint (replay + tail) | An **approve** endpoint that records the decision and **continues** the run |
| `RunEmitter` (seq from 1) | Seeding the emitter's `seq`/`step` from persisted state on continuation |

The event taxonomy already anticipated this — the work is wiring, not a
protocol redesign.

## Design

### 1. Durable checkpoint (the foundation)

Persist enough to reconstruct a run in a new invocation:

- **`messages`** — the running `ModelMessage[]` (assistant turns + tool
  calls/results). This is the one thing the event log can't rebuild
  losslessly (it stores UI summaries, not raw tool I/O).
- **`step`** — the step number to resume at.
- **run config** — `model`, `workspaceSystemPrompt`, enabled `skills`,
  `workspaceId` — so the continuation can rebuild the same tool map and
  system prompt. Non-secret; persisted server-side.

Storage: a `tasks.checkpoint jsonb` column (v1) — or a `task_checkpoints`
side table if blobs get large. Written at the suspend point (and,
optionally later, at every step — see *Phasing*). Local-mode MCP
credentials are **not** persisted (secrets stay in the browser); the
client re-sends them on approve (see §5).

`RunEmitter` gains `startSeq` / `startStep` options so a continuation
invocation continues the sequence instead of restarting at 1 (today it
hard-starts at 0 — a concrete change).

### 2. Marking a tool "needs approval"

A policy predicate `needsApproval(toolName, args): boolean`, resolved
per workspace/server. v1 sources:

- MCP server tools flagged sensitive (a `requiresApproval` flag on the
  server/tool config), and/or
- a workspace setting "approve all MCP writes".

The approval-gated tools are registered **without an `execute`** — the
idiomatic AI-SDK HITL pattern. The model emits the tool *call*; the SDK
does not run it (`finishReason: 'tool-calls'`, no result message). That
turns the existing per-step boundary into the natural suspend point.

### 3. Suspending (in the runner)

`makeStreamTextStep` already consumes `fullStream` and checkpoints after
each step. Extend it to:

1. Capture tool-call parts during the step.
2. After the stream, if any call targets an approval-gated tool with no
   executed result, return `{ done: false, pendingApproval: { approvalId,
   toolCallId, tool, args } }` instead of a normal outcome.

`runAgentLoop`, on a `pendingApproval` outcome:

1. Persist the checkpoint (messages incl. the un-executed assistant tool
   call, step, config).
2. `emitter.approval({ approvalId, phase: 'request', tool, args })` and
   `emitter.status('paused')`.
3. **Return** — the function exits. The run is suspended; no function is
   held open during the human's wait.

(`reconcileStaleRuns` only touches `queued`/`running`, so a `paused` run
is never falsely failed — already correct.)

### 4. The view: pending approval

Fold the `approval` event in `reduceRun` (today a no-op): add
`pendingApproval: { approvalId, tool, args } | null` to `TaskRunView`,
set on `phase: 'request'`, cleared on `phase: 'response'`. The Tasks
panel renders an **Approve / Reject** card when `status === 'paused'`
and `pendingApproval` is set.

### 5. Approving / rejecting → continuation

`POST /api/tasks/:id/approve` — body `{ approvalId, approved, args?,
mcpServers? }`:

1. Validate the run is `paused` with this pending `approvalId`.
2. Emit `approval({ approvalId, phase: 'response', approved })`.
3. Load the checkpoint (messages, step, config). Rebuild the tool map
   (cloud MCP from `workspaceId`; local MCP from the re-sent
   `mcpServers`).
4. Produce the gated tool's **result message**:
   - approved → execute the tool now (`buildMcpTool(...).execute(args)`,
     args optionally edited) → real result.
   - rejected → a synthetic tool result ("the user declined this
     action") so the model adapts.
   Append it to `messages`.
5. Set `status: 'running'`, construct a `RunEmitter` seeded with the
   persisted `seq`/`step`, and **continue `runAgentLoop`** from the
   checkpoint — returning the AI-SDK stream exactly like `POST
   /api/tasks`.

The client, after the human clicks Approve in the panel, calls
`apiClient.tasks.approve(...)` and **consumes the returned stream** —
the panel flips back to `running` and the run finishes (or hits the next
approval). On reject-and-abort, the continuation can settle `cancelled`
instead.

Because the human's click starts a **fresh** function, **no queue is
needed for v1** — the browser drives the continuation. (A queue is only
required to continue runs *without* the user's browser; see *Phasing*.)

### 6. UI

- `TaskStrip`: when `paused` + `pendingApproval`, render the gated
  tool name + args and **Approve / Reject** buttons (Reject optionally
  with "stop the task"). Arg-editing is a v1.1 nicety.
- `useTaskRun` / `TaskRunProvider`: an `approve(approvalId, approved)`
  that POSTs and consumes the continuation stream (same fold path as
  start/resume). The active-task pointer already lets a reload land back
  on the paused run and show the approval card.

## Data / API surface

- **Migration**: `tasks.checkpoint jsonb null` (+ optionally
  `task_checkpoints` if needed).
- **Schema**: `ApproveRequestSchema` (`approvalId`, `approved`, optional
  `args`, optional `mcpServers`).
- **Route**: `POST /api/tasks/:id/approve` (returns the continuation
  stream).
- **Emitter**: `approval()` method + `startSeq`/`startStep` options.
- **Runner**: `pendingApproval` outcome + `needsApproval` policy +
  no-execute registration for gated tools.
- **Projection**: fold `approval` → `pendingApproval`.
- **Client**: `apiClient.tasks.approve`; provider `approve()`.

## Phasing

1. **Checkpoint + emitter seeding** — the foundation (also unlocks
   "continue a dropped run on reload" as a bonus if checkpointed every
   step).
2. **Suspend/resume plumbing** — runner `pendingApproval`, approve route,
   continuation.
3. **Policy + gated MCP tools** — `needsApproval`, no-execute
   registration, a workspace/server "requires approval" flag.
4. **UI** — approval card + provider `approve()`.
5. **(Later) Queue-backed continuation** — when continuations must run
   without the browser (true background HITL, auto-retries), swap the
   browser-driven continuation for Inngest / pg-boss. The checkpoint
   model is queue-agnostic, so this is a runtime swap, not a redesign.
   Ties into `PLAN-long-running-tasks.md` Phase 5.

## Open questions / risks

- **Checkpoint size.** Full `messages` with large tool outputs could be
  heavy as JSONB. Mitigation: side table, compression, or trimming old
  turns. Measure before optimizing.
- **One vs many pending approvals.** v1 suspends on the *first* gated
  call per step (one approval at a time). Batch approval is later.
- **Stale pause.** A run paused indefinitely (human never answers) sits
  `paused` forever. Acceptable (it's intentional), but consider an
  expiry that auto-rejects after N days.
- **Re-sending local MCP creds on approve.** The continuation needs them
  for local-mode tools; the client re-supplies. Cloud-mode is
  server-looked-up and needs nothing.
- **Trust boundary.** Approve payloads (edited args) are user input —
  validate before executing a sensitive tool.

## Relationship to other plans

This is the concrete cash-out of the "HITL approvals (deferred —
architectural)" item in `PLAN-agent-tasks-followups.md`. The durable
checkpoint it introduces is the same foundation `PLAN-long-running-tasks.md`
Phase 5 (real queue) builds on — HITL just needs the *suspend/resume*
half, not the *background worker* half, so it can ship first.
