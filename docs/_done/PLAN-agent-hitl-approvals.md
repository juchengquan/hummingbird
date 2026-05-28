# Plan: Human-in-the-loop approvals for agent tasks

Status: **✅ shipped.** Phases 1–5 merged in
[#76](https://github.com/juchengquan/hummingbird/pull/76):
durable checkpoint + emitter seed (Phase 1), suspend mechanism +
respond endpoint + gated-tool policy (Phase 2+3), client respond
plumbing + approval card (Phase 4), `askUser` tool + multi-choice /
free-input cards (Phase 5). Phase 6 (queue-backed continuation
without a browser) is the foundational change tracked separately in
`PLAN-agent-task-queue.md`.

## Goal

Before the agent runs a sensitive tool (a destructive MCP action, a
spend, an irreversible write), it should **pause and ask the human**:
"Approve / Reject this action?" — and only continue once answered, with
the tool either executed or skipped.

But human-in-the-loop is **not always yes/no**. The agent may need the
human to **pick one of several options** ("which file should I edit?",
"which of these 3 candidates?"), choose **several**, or **supply a
value** ("what's the ticket number?"). All of these are the same
underlying move — *suspend, ask, resume with the answer* — so the design
treats binary approval as one **kind** of a general **human-input
request** (see §2a).

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
| `tasks.status` incl. `paused`; `approval` event kind | Generalizing it to an input request + folding a `pendingInput` view field |
| Per-step checkpointing (`stopWhen: stepCountIs(1)`) | Detecting an approval-gated tool call and **suspending** instead of looping |
| Resume endpoint (replay + tail) | A **respond** endpoint that records the answer and **continues** the run |
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
client re-sends them when it responds (see §5).

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

### 2a. Beyond yes/no — request kinds

The suspend/resume machinery is identical for every kind of human input;
only the **request payload** (what we ask) and the **response payload**
(what comes back) differ. A pause carries a normalized **input request**:

| Kind | Raised by | Request payload | Response | How the answer re-enters the run |
|---|---|---|---|---|
| `approval` | a gated **existing** tool (e.g. an MCP write) | the tool + its args | `approved` (+ optional edited `args`) | approved → run the real tool → its result; rejected → a synthetic "declined" result |
| `choice` | an **`askUser`** tool the model calls | `prompt` + `options[]` (+ `multi`) | `selection[]` (option ids) | the chosen option(s) become the `askUser` tool result the model reads |
| `input` | an **`askUser`** tool the model calls | `prompt` (+ optional JSON schema) | `value` | the value becomes the `askUser` tool result |

The unifying trick: **`choice` / `input` are just another no-execute
tool** (`askUser`) whose "execution" is the human's answer. So the agent
*decides* it needs human input by calling `askUser({ prompt, options })`
— exactly the same suspend mechanism as a gated tool. The runner doesn't
special-case them: any no-execute tool call that the policy says "needs a
human" suspends; the tool's name/args determine which kind of card to
render and how to form the result on resume.

This means multi-choice needs **no new control flow** — only (a) a
normalized request descriptor on the pause event so the client knows
what to render, and (b) per-kind result construction on resume.

### 3. Suspending (in the runner)

`makeStreamTextStep` already consumes `fullStream` and checkpoints after
each step. Extend it to:

1. Capture tool-call parts during the step.
2. After the stream, if any call targets a tool the policy gates (an
   approval-gated tool, or `askUser`) with no executed result, return
   `{ done: false, pendingInput: { requestId, kind, toolCallId, tool,
   prompt?, options? } }` instead of a normal outcome.

`runAgentLoop`, on a `pendingInput` outcome:

1. Persist the checkpoint (messages incl. the un-executed assistant tool
   call, step, config).
2. Emit the normalized **input request** (`requestId`, `kind`, `tool`,
   `prompt`, `options?`, `toolCallId`) and `emitter.status('paused')`.
3. **Return** — the function exits. The run is suspended; no function is
   held open during the human's wait.

(`reconcileStaleRuns` only touches `queued`/`running`, so a `paused` run
is never falsely failed — already correct.)

### 4. The view: pending input

Fold the request/response events in `reduceRun` (today a no-op for
`approval`): add `pendingInput: { requestId, kind, tool, prompt,
options?, args? } | null` to `TaskRunView`, set on the request, cleared
on the response. The Tasks panel renders the card matching `kind` when
`status === 'paused'` and `pendingInput` is set.

### 5. Responding → continuation

`POST /api/tasks/:id/respond` — body `{ requestId, approved?,
selection?, value?, args?, mcpServers? }` (only the fields the request's
`kind` needs):

1. Validate the run is `paused` with this pending `requestId`.
2. Emit the response event (`approved` / `selection` / `value`).
3. Load the checkpoint (messages, step, config). Rebuild the tool map
   (cloud MCP from `workspaceId`; local MCP from the re-sent
   `mcpServers`).
4. Produce the pending tool's **result message** per kind:
   - `approval` approved → execute the real tool now
     (`buildMcpTool(...).execute(args)`, args optionally edited) → its
     result; rejected → a synthetic "user declined this action" result.
   - `choice` / `input` → the `selection` / `value` becomes the
     `askUser` tool result the model reads next.
   Append it to `messages`.
5. Set `status: 'running'`, construct a `RunEmitter` seeded with the
   persisted `seq`/`step`, and **continue `runAgentLoop`** from the
   checkpoint — returning the AI-SDK stream exactly like `POST
   /api/tasks`.

The client, after the human answers in the panel, calls
`apiClient.tasks.respond(...)` and **consumes the returned stream** — the
panel flips back to `running` and the run finishes (or hits the next
request). On reject-and-abort, the continuation can settle `cancelled`
instead.

Because the human's click starts a **fresh** function, **no queue is
needed for v1** — the browser drives the continuation. (A queue is only
required to continue runs *without* the user's browser; see *Phasing*.)

### 6. UI

- `TaskStrip`: when `paused` + `pendingInput`, render the card for the
  request `kind`:
  - `approval` → tool name + args + **Approve / Reject** (Reject
    optionally "stop the task"); arg-editing is a v1.1 nicety.
  - `choice` → the prompt + radio buttons (or checkboxes when `multi`)
    over `options`, with a **Submit**.
  - `input` → the prompt + a text field (+ **Submit**).
- `useTaskRun` / `TaskRunProvider`: a single `respond(requestId,
  answer)` that POSTs and consumes the continuation stream (same fold
  path as start/resume). The active-task pointer already lets a reload
  land back on the paused run and show the right card.

## Data / API surface

- **Migration**: `tasks.checkpoint jsonb null` (+ optionally
  `task_checkpoints` if needed).
- **Event model**: generalize the reserved `approval` event into a
  **human-input request/response** — request carries `requestId`,
  `kind` (`approval`|`choice`|`input`), `prompt?`, `options?`, `multi?`,
  `tool?`, `toolCallId`; response carries `approved?` / `selection?` /
  `value?`. (Additive — keep `approval` as the binary specialization, or
  add a sibling `input_request` kind. Binary ships first.)
- **`askUser` tool**: a built-in no-execute tool the model calls to raise
  a `choice` / `input` request (`{ prompt, options?, multi? }`).
- **Schema**: `RespondRequestSchema` (`requestId`, optional `approved` /
  `selection` / `value` / `args` / `mcpServers`).
- **Route**: `POST /api/tasks/:id/respond` (returns the continuation
  stream).
- **Emitter**: input-request/response methods + `startSeq`/`startStep`
  options.
- **Runner**: `pendingInput` outcome + `needsApproval` policy +
  no-execute registration for gated tools and `askUser`.
- **Projection**: fold request/response → `pendingInput`.
- **Client**: `apiClient.tasks.respond`; provider `respond()`.

## Phasing

1. **Checkpoint + emitter seeding** — the foundation (also unlocks
   "continue a dropped run on reload" as a bonus if checkpointed every
   step).
2. **Suspend/resume plumbing** — runner `pendingInput`, `respond` route,
   continuation. Built generic from the start (the request descriptor
   carries `kind`), but only the **binary `approval`** path is exercised.
3. **Policy + gated MCP tools** — `needsApproval`, no-execute
   registration, a workspace/server "requires approval" flag.
4. **UI** — approval card + provider `respond()`.
5. **`choice` / `input` via `askUser`** — the multi-choice / free-input
   kinds. Mostly the `askUser` tool + the two extra card renderers +
   per-kind result construction; the control flow from phases 1–4 is
   reused unchanged. Small, lands on top.
6. **(Later) Queue-backed continuation** — when continuations must run
   without the browser (true background HITL, auto-retries), swap the
   browser-driven continuation for Inngest / pg-boss. The checkpoint
   model is queue-agnostic, so this is a runtime swap, not a redesign.
   Ties into `PLAN-long-running-tasks.md` Phase 5.

## Open questions / risks

- **Checkpoint size.** Full `messages` with large tool outputs could be
  heavy as JSONB. Mitigation: side table, compression, or trimming old
  turns. Measure before optimizing.
- **One vs many pending requests.** v1 suspends on the *first* gated /
  `askUser` call per step (one request at a time). Batching is later.
- **Stale pause.** A run paused indefinitely (human never answers) sits
  `paused` forever. Acceptable (it's intentional), but consider an
  expiry that auto-rejects after N days.
- **Re-sending local MCP creds on respond.** The continuation needs them
  for local-mode tools; the client re-supplies. Cloud-mode is
  server-looked-up and needs nothing.
- **Trust boundary.** Response payloads (edited args, free-text values)
  are user input — validate before executing a sensitive tool.

## Relationship to other plans

This is the concrete cash-out of the "HITL approvals (deferred —
architectural)" item in `PLAN-agent-tasks-followups.md`. The durable
checkpoint it introduces is the same foundation `PLAN-long-running-tasks.md`
Phase 5 (real queue) builds on — HITL just needs the *suspend/resume*
half, not the *background worker* half, so it can ship first.
