# Plan: Agent event model & streaming format

Status: **🪜 core + full vertical slice landing.** Core shipped in
[#66](https://github.com/juchengquan/hummingbird/pull/66) (pure IR +
projection + emitter + wire codec) and persistence in
[#68](https://github.com/juchengquan/hummingbird/pull/68); the runner →
route → resume → task-card UI → polish slices land together in the
agent-tasks PR — see *Implementation slices* below. Settles the message/event taxonomy and wire format
that long-running tasks (and the eventual agent-service split) depend
on. Split out of
`PLAN-long-running-tasks.md` because it's the *load-bearing* design:
the runner, persistence, resume, and UI all fall out of it, and the
agent-service plan (`PLAN-agent-api.md`) flagged "streaming format"
as an open decision this resolves.

## The problem in one paragraph

Today a `Message` (`lib/shared/types.ts`) is a **flat, single-turn
artifact**: one `content` string, one `reasoning` string, a flat
`toolCalls[]`, settled at the `done` SSE frame. A long-running task is
a **sequence of steps**, each its own (reasoning → tool calls →
observations → partial output) cycle, with lifecycle states (queued /
running / paused / cancelled / failed), a live plan/todo list, and the
need to **survive disconnect and resume**. Flattening a 25-step run
into one Message loses the structure; the current 7-frame SSE protocol
(`text`/`reasoning`/`tool_call`/`tool_result`/`suggestions`/`error`/
`done`, see `docs/API.md`) has no vocabulary for steps, plans,
lifecycle, or resumption.

The architectural shift: **today the Message *is* the record; for
tasks, an append-only event log is the record and every view (the
live task card, the settled assistant message, a sidebar badge) is a
*projection* of it.**

## What the agent SDKs teach us about the event taxonomy

We surveyed four mature SDKs — **not to adopt a framework** (we keep
the AI-SDK loop) but to mine their event vocabularies so our
`TaskEvent` type borrows battle-tested concepts. Findings:

### OpenAI Agents SDK — two-level events + handoffs + approvals

Three stream-event tiers: `RawResponsesStreamEvent` (raw token deltas,
passed straight through from the LLM), `RunItemStreamEvent` (semantic
items), and `AgentUpdatedStreamEvent` (which sub-agent is now
running). The run-item names are a ready-made checklist:
`message_output_created`, `tool_called`, `tool_output`,
`reasoning_item_created`, `handoff_requested`, `handoff_occurred`,
`mcp_approval_requested`, `mcp_approval_response`, `mcp_list_tools`.

**Takeaways:** (a) separate the *raw token stream* from *semantic
run-items* — the UI mostly wants the latter. (b) **handoffs**
(multi-agent / sub-agent) and **mcp_approval** (human-in-the-loop) are
first-class event types, not afterthoughts.

### Claude Agent SDK — small top-level set + a "compact boundary"

Top-level message types: `system` / `assistant` / `user` / `result` /
`stream_event`. Partial token streaming is opt-in (`include_partial_
messages`), surfacing raw Anthropic `content_block_delta` /
`content_block_start|stop` / `message_delta` events. Notably it emits
a **compact boundary** message when conversation history is compacted
mid-session.

**Takeaways:** (a) a small set of semantic message types with an
*opt-in* raw partial layer (don't force token-granularity on every
consumer). (b) an explicit `result` terminal carrying final
status + usage. (c) the **compact-boundary** event maps directly onto
our "compress older messages" feature — a long task that compacts
mid-run should emit a boundary event so the UI and the log agree.

### LangGraph — the client picks the granularity (stream modes)

Exposes execution via stream *modes*: `values` (full state snapshot),
`updates` (state deltas), `messages` (token-level), `custom`
(arbitrary progress/data the tools emit), plus `checkpoints` / `tasks`
/ `debug`. Consumers subscribe to the mode(s) they need.

**Takeaways:** (a) the **multi-mode** idea — a cheap `status`
subscription (sidebar badge, "step 7/12") vs a heavy `full-event`
subscription (the task card) is the same insight as our "status
channel ≠ event firehose" need. (b) `checkpoints` mode ↔ our
resume/cursor requirement; checkpointing is a first-class concept.

### LangChain Deep Agents — the plan/todo is *state*, not an event

A planning tool gives the agent a **todo list** rendered live; the
frontend reads a `todos[]` array straight from agent state and
re-renders each item as its status moves `pending → in_progress →
completed`. Also: a virtual file system (agent reads/writes files
instead of cramming context) and sub-agents for parallel/isolated
work.

**Takeaways:** (a) the **plan/todo is durable state the UI projects**,
not a transient frame — our event model needs a `plan` event carrying
the current todo list (or deltas), and the task view renders the
latest. This is exactly the "plan surface" gap. (b) sub-agents
reinforce OpenAI's handoff concept.

### Vercel AI SDK v5 — the closest off-the-shelf wire format

SSE-based UI message stream with **typed parts**: text deltas,
reasoning, a full tool lifecycle (`tool-input-start` →
`tool-input-delta` → `tool-input-available` → `tool-output-available`),
**`start-step` / `finish-step`** (one LLM call = one step), arbitrary
**`data-*`** custom parts, plus `error` and `finish`. Consumed
natively by `@ai-sdk/react`'s `useChat`. We **already use this format**
for the editor routes (`/api/ai/command`, `/api/ai/copilot`).

**Takeaways:** this already covers ~80% of what tasks need — step
boundaries, tool lifecycle, reasoning, and a typed extension point
(`data-*`) for everything agent-specific. And we already depend on it.

## Synthesis — the event taxonomy we actually need

Mapping the union onto our needs. Three tiers (à la OpenAI / LangGraph
modes):

| Tier | Purpose | Source format candidate |
|---|---|---|
| **Token** | Raw text/reasoning deltas | AI SDK `text-delta` / `reasoning` |
| **Run-item** | Semantic events the task card renders | AI SDK parts + `data-*` |
| **Status** | Cheap progress for badges / multiplexed views | a thin projection (poll or light SSE) |

Run-item events we need (✓ = native AI SDK part, ⊕ = `data-*` we add):

- ✓ `text` / `reasoning` deltas
- ✓ `tool-input-*` / `tool-output-available` (tool lifecycle)
- ✓ `start-step` / `finish-step` (step boundary)
- ✓ `error` (but see per-step caveat below) / `finish`
- ⊕ `data-run-status` — `queued|running|paused|cancelled|done|failed` + step counter
- ⊕ `data-plan` — the todo list `[{ id, text, status }]` (Deep Agents)
- ⊕ `data-step-error` — per-step failure + retry (distinct from the fatal `error`/`finish`)
- ⊕ `data-handoff` — sub-agent enter/exit (OpenAI; only if we add sub-agents)
- ⊕ `data-approval-request` / `data-approval-response` — human-in-the-loop gate (OpenAI mcp_approval)
- ⊕ `data-compact-boundary` — history compaction mid-run (Claude)
- ⊕ `data-artifact-ref` — a partial artifact produced/updated mid-run (links to the existing `artifacts` entity by `runId`)

### The persisted `TaskEvent` (source of truth)

The wire is ephemeral; the log is durable. Sketch (refine in
`PLAN-long-running-tasks.md`'s schema):

```ts
interface TaskEvent {
  runId: string
  seq: number            // monotonic per run — the resume cursor
  step: number           // which agent step produced it
  kind: 'token' | 'tool_input' | 'tool_output' | 'step_start'
       | 'step_end' | 'status' | 'plan' | 'step_error'
       | 'handoff' | 'approval' | 'compact' | 'artifact_ref' | 'result'
  payload: Json          // kind-specific
  createdAt: string
}
```

Every view is a fold over this log:
- **Live task card** ← replay from `seq` cursor + tail new events.
- **Settled assistant message** ← terminal projection (final text +
  toolCalls + generatedImages) written once on `result`. The existing
  flat `Message` stays the *settled* representation; the task card is
  the *in-flight* one.
- **Sidebar status badge** ← latest `status` event only.

## The format decision

| Option | What | Verdict |
|---|---|---|
| Keep the custom 7-frame SSE | Extend with new frame types per concept | Reinvents what AI SDK already standardized; no `useChat`; more to spec + test |
| **Adopt AI SDK v5 UI message stream** | Native parts + `data-*` for agent extensions | **Recommended** — ~80% native, typed extension point, we already use it for editor routes, unlocks `useChat()` on the chat panel |
| Adopt an agent SDK's protocol wholesale | e.g. OpenAI Agents stream events | Couples us to a framework we don't otherwise use; heavier than needed |

**Recommendation: adopt the AI SDK v5 UI message stream as the wire
format**, express the agent-specific events as typed `data-*` parts
(the ⊕ list above), and persist a normalized `TaskEvent` log as the
server-side source of truth that projects to all three views. This
aligns with `PLAN-agent-api.md`'s "unify on the AI SDK format" lean,
makes the chat-route and editor-route formats finally consistent, and
means the resume/replay logic is the only genuinely new wire concern.

## Multi-SDK adapter layer

If the backend runs different agent SDKs underneath (OpenAI Agents
SDK, Claude Agent SDK, LangGraph / Deep Agents, the bare AI-SDK loop
we have today), the `TaskEvent` taxonomy is the **canonical
intermediate representation (IR)**: each SDK gets a thin **adapter**
that maps its native stream → `TaskEvent`s, the log stays the system
of record, and the AI-SDK-v5 wire format is just one projection out.
The frontend never sees an OpenAI run-item or a Claude
`content_block_delta` — only our normalized events. That decoupling
is the point of the model.

```
OpenAI Agents SDK ─┐
Claude Agent SDK  ─┤   adapter[i]      append-only        projections
LangGraph         ─┼─▶ native → ─────▶ TaskEvent log ─┬─▶ AI-SDK wire (useChat)
Deep Agents       ─┤   TaskEvent       (source of      ├─▶ settled Message
bare AI-SDK loop  ─┘                    truth, seq)    └─▶ status badge
```

**It is an adapter, not a passthrough.** Four places need real
translation, not field-renaming — pin them before the first adapter
is wired:

1. **"Step" is SDK-specific; the IR owns the definition.** AI SDK = one
   LLM call; LangGraph = a graph node (possibly many calls or none);
   OpenAI Agents = a run-item. Each adapter conforms its native unit
   to *our* `step`, or `step` is incomparable across SDKs.

2. **The taxonomy is a superset; each adapter fills a subset.**
   Handoffs/sub-agents (OpenAI, Deep Agents) have no Claude-SDK
   equivalent; approvals (`mcp_approval`) don't exist elsewhere; plan/
   todo is Deep-Agents-shaped. **Contract rule: consumers degrade
   gracefully when an event `kind` never appears** — the UI must not
   assume any given kind shows up.

3. **State-shaped SDKs need state→event synthesis.** LangGraph
   `values`/`updates` and Deep Agents `todos[]` are state
   snapshots/deltas, not an event stream. The adapter diffs successive
   states into events — or emits snapshot-carrying events, which is
   why `data-plan` carries the full list each time (see Open
   questions) rather than deltas.

4. **We own `seq` for client replay even when the SDK checkpoints.**
   If an SDK runs its own loop with its own checkpointing (LangGraph
   checkpoints, OpenAI server-side run state), the adapter still
   assigns our monotonic `seq` and persists as events flow through.
   Two checkpoint systems can coexist, but **ours is authoritative for
   the client-facing stream** — the SDK's is an implementation detail
   of how *it* resumes its own loop.

Net: the model caters for multiple SDKs by construction, provided the
`TaskEvent` IR is treated as authoritative and each adapter is allowed
to (a) define its step mapping, (b) populate only the kinds it can,
and (c) synthesize events from state where the SDK is state-shaped.

## Resume / cursor protocol

The one thing no SDK format gives us for free: **reconnect-and-resume.**
- Each `TaskEvent` carries a monotonic `seq`.
- Reconnect: client sends `Last-Event-ID: <seq>` (native SSE header) →
  server replays `seq+1…` from the log, then tails live.
- A half-written step on crash/resume must not double-emit or
  double-call a tool — events are idempotent by `(runId, seq)`, and
  the runner checkpoints *after* each tool result, never mid-call.

## Open questions

1. **Migrate the existing `/api/chat` to the AI SDK format too, or
   only the new task route?** Unifying is cleaner long-term but
   touches the shipped chat panel parser. Could be staged: tasks adopt
   it first, chat migrates later.
2. **`data-plan` as full-list-each-time vs deltas.** Full list is
   simpler and plans are short (<20 items); recommend full-list.
3. **Sub-agents / handoffs in v1?** The taxonomy reserves the events;
   the runner can stay single-agent for v1 and add them later without
   a protocol change.
4. **Human-in-the-loop approvals in v1?** Same — reserve the events,
   defer the runner support unless a tool needs it (e.g. a
   destructive MCP action).

## Recommendation / next step

This doc resolves the format question for `PLAN-long-running-tasks.md`
and `PLAN-agent-api.md`. Concrete next step when tasks work begins:
**stand up the `TaskEvent` log + the AI SDK data-stream emitter in the
current TS backend** (no service split, no language decision needed),
prove it with a single linear task, then layer the runner and UI on
top. The `data-*` extension list above is the contract to build
against.

## Implementation slices

The model is being built bottom-up — pure core first, then the
stateful pieces, then the surfaces. Each slice lands on the one above.
Feature-level detail for the runner/route/UI lives in
`PLAN-long-running-tasks.md`; this list is the build order.

1. ✅ **Event-model core** — IR + projection (`reduceRun`/`projectRun`)
   + `RunEmitter` + wire codec, all pure, in `lib/shared/agent/`.
   Shipped in [#66](https://github.com/juchengquan/hummingbird/pull/66).
2. ✅ **Persistence** — `tasks` + `task_events` tables, migration, RLS
   (own-your-rows); the `RunEmitter` sink writes here. Shipped in
   [#68](https://github.com/juchengquan/hummingbird/pull/68)
   (`lib/server/agent/persistence.ts`).
3. ✅ **Runner loop** — step driver (`streamText` + `stepCountIs(1)`
   per step) that drives `RunEmitter`, checkpoints after each tool
   result, polls cancel between steps. Single-agent, linear v1.
   `lib/server/agent/runner.ts` + `store.ts`.
4. ✅ **Task route** — `POST /api/tasks` (create + run + emit the
   AI-SDK `data-agent-event` stream) and `POST /api/tasks/:id/cancel`.
   `app/api/tasks/`.
5. ✅ **Resume endpoint** — `GET /api/tasks/:id/stream` honouring
   `Last-Event-ID`: replay `task_events` from `seq+1`, then poll-tail
   live (no pub/sub in v1; a terminal-row + wall-clock backstop bound
   an orphaned run).
6. ✅ **Task-card UI** — the in-flight surface (distinct from the chat
   bubble). `useTaskRun` mounts the stream through `reduceRun`
   (decoder: `lib/shared/agent/stream.ts`); `TaskStrip`
   (`components/agent/`) renders the `TaskRunView`: status + step
   counter, the live plan/todo, tool pills, streaming text/reasoning,
   and a Cancel button, collapsing to a badge on settle. Wiring the
   "Run as task" toggle into the chat panel (`PLAN-long-running-tasks.md`
   Phase 2) is the remaining browser-tested integration.
7. ✅ **Cross-surface polish** — resume pointer (`active-task` codec +
   localStorage), finish-while-away browser notification, and a
   `TaskStatusDot` for the sidebar. Mounting the dot on conversation
   rows + the reload auto-resume call are the remaining UI wiring.

Slices 2–7 each need infrastructure (DB / routes / UI), unlike the
pure core. **Decision gate before slice 4 (resolved):** the serverless
execution-cap risk (`PLAN-agent-api.md`) — confirm the deploy target
(Pro/Enterprise or self-host) before relying on the long-running route
in production; the resume endpoint (slice 5) mitigates but doesn't
remove it.
