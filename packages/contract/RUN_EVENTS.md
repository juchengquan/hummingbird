# Run events: internal model → AG-UI 1.0

**Normative.** How a Hummingbird backend turns its internal run events
into the AG-UI 1.0 events of the runs operations (`startRun`,
`streamRunEvents` in [`openapi.yaml`](openapi.yaml)), what each run status
means, how a stream is replayed from a cursor, and what log compaction
keeps. Decisions: Q8, Q13, Q16, Q17, Q24, Q27–Q31 of
[`docs/PLAN-frontend-backend-split.md`](../../docs/PLAN-frontend-backend-split.md).
Wave 3b-A implements the encoder and the stream mechanics from this
page; a second backend (Q11) implements the same page.

Three layers, each with one job:

```
harness adapter ──emits──▶ internal events ──append──▶ run event log (numbered: seq 1, 2, …)
                                                         │
                       stream (start / rejoin) ◀─encode──┘   AG-UI events, SSE id = cursor
```

- **Internal events** are the source of truth (Q13): agent-py's
  `TaskEvent` union (`services/agent-py/src/agent_py/events.py`). Every
  harness adapter emits them; nothing outside the backend sees them.
- **The run event log** stores them, one entry per event, `seq` 1, 2, …
  per run (`task_events`, or memory for anonymous runs).
- **The encoder** is stateful per stream and deterministic: the same
  log always encodes to the same AG-UI events, ids included. It is the
  only place AG-UI shapes are built, so a later AG-UI version, or
  another wire protocol, swaps it alone.

Notation: `R` is the run id, `s` the `seq` of the entry being encoded,
`"R:s"` the string id formed from them (e.g.
`"8a6e0804-…-f9071a:12"`). `hb.` abbreviates the namespace
`hummingbird.` in CUSTOM event names and activity types — on the wire
it is always spelled out (`hummingbird.gap`).

## 1. Run status

One status per run, derived from the run row; three vocabularies:

| `tasks.status` (DB, internal `RunStatus`) | condition | contract `RunStatus` | closing AG-UI event |
|---|---|---|---|
| `queued` | | `queued` | — |
| `running` | | `running` | — |
| `paused` | the run has open interrupts | `interrupted` | `RUN_FINISHED { outcome: { type: "interrupt", interrupts } }` |
| `paused` | no open interrupts (a background parent waiting on its sub-agent runs: `checkpoint.awaiting_children`) | `running` | — |
| `done` | | `succeeded` | `RUN_FINISHED { outcome: { type: "success" }, result, usage? }` |
| `failed` | | `failed` | `RUN_ERROR { message, code, usage? }` |
| `cancelled` | | `cancelled` | `RUN_FINISHED { outcome: { type: "cancelled" } }` |

- **Open interrupts** of a run: `tasks.outcome.interrupts` when
  `outcome.type = "interrupt"` (written by the backend when the run is
  interrupted, migration 0041); for rows without `outcome` (written by
  the pre-0041 executor), every `approval` entry with `phase: request`
  whose `approvalId` has no later `phase: response` entry, built as in
  § 4.
- `interrupted` is an end state for that run: answering it starts a
  **new** run (Q24) whose `forwardedProps.previousRunId` is this one.
  Rows the legacy respond route resumed in place (`paused` → `running`
  on the same row) are still read correctly, because the closing event
  is built from the row status at the moment the stream ends (§ 6), not
  from the `status: paused` entry.
- `finishedAt` is set for `succeeded`, `failed`, `cancelled` and
  `interrupted`.
- Background runs only reach `queued`. Interactive runs are created
  `running` (0041 `create_run`).

## 2. Ids

Every id the encoder mints is derived from the log, so live encoding,
replay and the compaction snapshot agree:

| Id | Value |
|---|---|
| text message (`TEXT_MESSAGE_*.messageId`) | `"R:s"`, `s` = the token entry that opened the block |
| reasoning message (`REASONING_START` / `REASONING_MESSAGE_*`) | `"R:s"`, `s` = the token entry that opened the block (same string for the span and its single message) |
| tool-only assistant message (`TOOL_CALL_START.parentMessageId` when the step has no text) | `"R:s"`, `s` = the first `tool_input` of the step |
| tool message (`TOOL_CALL_RESULT.messageId`) | `"R:s"`, `s` = the `tool_output` entry |
| tool call (`toolCallId`) | the internal `tool_call_id`, verbatim |
| activity message (`ACTIVITY_SNAPSHOT.messageId`) | per kind, § 3.3 |
| sub-agent (`subagentRunId`) | the handoff's `child_task_id`; without one, `"R:s"` of its `enter` entry |
| interrupt (`Interrupt.id`) | the approval's `approvalId` (today: the gated tool call's id) |
| step (`stepName`) | `"step-<n>"`, `n` = the entry's `step` |

## 3. Event mapping

### 3.1 Blocks: text and reasoning

The encoder holds at most one **open block** — a text message or a
reasoning message — plus the current step's **parent message id** (the
assistant message tool calls attach to).

| Entry | AG-UI events, in order |
|---|---|
| `token`, `channel: "text"`, non-empty `text` | close an open reasoning block; if no text block is open: `TEXT_MESSAGE_START { messageId: "R:s", role: "assistant" }` and set the step's parent message id to `"R:s"`; then `TEXT_MESSAGE_CONTENT { messageId, delta: text }` |
| `token`, `channel: "reasoning"`, non-empty `text` | close an open text block; if no reasoning block is open: `REASONING_START { messageId: "R:s" }`, `REASONING_MESSAGE_START { messageId: "R:s", role: "reasoning" }`; then `REASONING_MESSAGE_CONTENT { messageId, delta: text }` |
| `token` with empty `text` | nothing (and closes nothing) |
| **any other entry** | first close the open block, if any — **even when the entry itself encodes to nothing**. The one exception is a resume marker, which drops the open block without closing it (§ 3.2) |

Closing a text block: `TEXT_MESSAGE_END { messageId }`. Closing a
reasoning block: `REASONING_MESSAGE_END { messageId }`,
`REASONING_END { messageId }`.

The parent message id is reset to none by every `step_start`.

### 3.2 Everything else

| Internal entry | AG-UI events | Notes |
|---|---|---|
| `status` `queued` / `running`, no resume marker | — | `RUN_STARTED` is stream framing (§ 6), not an entry |
| `status` `running` with `resumedFromSeq` (or legacy `restarted`) — a **resume marker** | `CUSTOM hb.rewind { after }` | `after` = `resumedFromSeq` (legacy `restarted` without it: `1`). The marker does **not** close the open block: the encoder drops it (no `*_END` events — live, the block was opened by the dead attempt and the client discards its start on the rewind, so an `END` at the marker's seq would end a message the client no longer holds; on replay nothing is open here). It also forgets its parent message id and whatever it tracked from entries with `seq > after` (open sub-agents, the open step, the last `result`). See § 6.5 |
| `status` `paused` / `cancelled` / `done` / `failed` | — | the closing event comes from the run row (§ 6.4) |
| `step_start` | `STEP_STARTED { stepName: "step-<step>" }` | resets the parent message id |
| `step_end` | `STEP_FINISHED { stepName: "step-<step>" }` | |
| `tool_input` | `TOOL_CALL_START { toolCallId, toolCallName: toolName, parentMessageId }`, `TOOL_CALL_ARGS { toolCallId, delta: JSON(args) }`, `TOOL_CALL_END { toolCallId }` | `parentMessageId` = the step's parent message id; when none, set it to `"R:s"` first (a tool-only assistant message). `JSON()` is compact JSON (`separators=(",", ":")`), keys in insertion order, non-ASCII characters not escaped — byte for byte `JSON.stringify` |
| `tool_output` | `TOOL_CALL_RESULT { messageId: "R:s", toolCallId, role: "tool", content, metadata: { "hummingbird": { "toolName", "isError"? } } }` | `content` = `JSON({ "summary": summary, "results": results })`, `results` omitted when absent — the exact string chat's `tool-output-available.output` carries today. `isError: true` only when the tool failed (then `summary` is the error text) |
| `step_error` | `CUSTOM hb.step_error { message, willRetry }` | non-fatal |
| `handoff` `enter` | `SUBAGENT_STARTED { subagentRunId, name: agent, metadata?: { hummingbird: { subgoal } } }` | the pinned schema's `SUBAGENT_STARTED` has no `description`, so the subgoal rides in the event's `metadata` (only when set). Today every sub-agent is a separate background run (`parentRunId`), so nothing is attributed to it inline |
| `handoff` `exit` | `SUBAGENT_FINISHED { subagentRunId }` | `subagentRunId`: by `child_task_id`; without one, the most recent unmatched `enter` of the same `agent`. An `exit` matching no `enter` encodes to nothing |
| `approval` `request` | — | the interrupt is reported by the closing `RUN_FINISHED` (§ 4) |
| `approval` `response` | `CUSTOM hb.interrupt_resolved { interruptId: approvalId, payload }` | `payload` as in § 4.2. Only legacy in-place resumes write these into the same run's log; a Q24 resume run's answers are its request's `resume[]`, and what they produced shows as its `TOOL_CALL_RESULT`s (§ 4.2) |
| `compact` | `CUSTOM hb.context_compacted { summary? }` | model-context compaction, not log compaction |
| part kinds (§ 3.3) | `ACTIVITY_SNAPSHOT { messageId, activityType, content, replace: true }` | |
| `result` with `verification` (background runs) | `ACTIVITY_SNAPSHOT` as for a `verification` entry | the rest of `result` feeds the closing event (§ 6.4) |
| `result` otherwise | — | |
| `messages_snapshot` | `MESSAGES_SNAPSHOT { messages }` | only ever reached after a `gap` (§ 6.3) |
| an unknown kind | — | a reader of an older build skips it and still closes the open block |

### 3.3 Parts → `ACTIVITY_SNAPSHOT`

Everything the UI attaches to the turn besides text and tool calls is
an AG-UI **activity**: it keeps its place in the message sequence,
survives compaction as an `ActivityMessage` (§ 7), and a later snapshot
with the same `messageId` replaces the earlier one. `content` is
exactly the `data` object of the AI SDK frame chat sends today, so the
frontend's existing parsers (`lib/client/chat/sse-frame-translator.ts`)
apply unchanged.

| Internal kind | `activityType` | `messageId` | `content` (today's frame) |
|---|---|---|---|
| `tool_image` | `hummingbird.tool_image` | `"R:tool_image:<toolCallId>"` | `{ id: toolCallId, mode, images }` (`data-tool-image`) |
| `tool_file` | `hummingbird.tool_file` | `"R:tool_file:<toolCallId>"` | `{ id: toolCallId, files }` (`data-tool-file`) |
| `code_result` | `hummingbird.code_result` | `"R:code_result:<toolCallId>"` | `{ id: toolCallId, stdout, stderr, results }` (`data-code-result`) |
| `ui_part` | `hummingbird.ui_part` | `"R:ui_part:<toolCallId>"` | `{ id: toolCallId, kind: uiKind, props }` (`data-ui`) |
| `mcp_app` | `hummingbird.mcp_app` | `"R:mcp_app:<toolCallId>"` | `{ id: toolCallId, serverId, html, resourceUri?, truncated? }` (`data-mcp-app`) |
| `verification` | `hummingbird.verification` | `"R:verification"` | `{ checks, summary }` (`data-verification`) |
| `suggestions` | `hummingbird.suggestions` | `"R:suggestions"` | `{ values }` (`data-suggestions`) |
| `routed_model` | `hummingbird.routed_model` | `"R:routed_model"` | `{ model }` (`data-routed-model`) |
| `plan` | `hummingbird.plan` | `"R:plan"` | `{ items: [{ id, text, status }] }` (the whole list, every time) |
| `artifact_ref` | `hummingbird.artifact_ref` | `"R:artifact:<artifactId>"` | `{ artifactId }` |

A tool's parts follow its `TOOL_CALL_RESULT`. agent-py's native harness
emits `tool_image` for `generateImage` (`mode` `t2i` / `i2i`; each image
`{ id: "<toolCallId>-<i>", url, storagePath?, width, height, format,
prompt, mode }`, as the Next route's `data-tool-image`), and `tool_file`
for any tool that returns files.

`ActivityMessage`s are display state: a client that sends history back
in a later `RunAgentInput.messages` may include them, and the backend
never passes them to the model.

### 3.4 `CUSTOM` events

Used only for signals that are not conversation content. Names are
namespaced `hummingbird.`; a consumer ignores names it does not know.

| `name` | `value` | When |
|---|---|---|
| `hummingbird.gap` | `RunGapEventValue` (`openapi.yaml`) `{ after, resumeAt, reason }` | the cursor points before retained events (§ 6.3); always followed by `MESSAGES_SNAPSHOT` |
| `hummingbird.rewind` | `RunRewindEventValue` `{ after }` | a resume marker (§ 6.5) |
| `hummingbird.step_error` | `{ message, willRetry }` | non-fatal step failure |
| `hummingbird.interrupt_resolved` | `{ interruptId, payload }` | legacy in-place answer (§ 3.2) |
| `hummingbird.context_compacted` | `{ summary? }` (key omitted when absent) | model-context compaction |

Memory taint is not an event: it is a property of the finished run,
`RUN_FINISHED.result.memoryTainted` (`RunResult`), so it survives
compaction for free.

## 4. Interrupts

### 4.1 `Interrupt`

When a run is interrupted, each open approval request becomes one
AG-UI `Interrupt` (in the closing `RUN_FINISHED` outcome, in
`Run.openInterrupts`, and in `tasks.outcome.interrupts` — the same
objects):

| `Interrupt` field | From the `approval` request entry |
|---|---|
| `id` | `approvalId` |
| `reason` | `requestKind` (`"approval"` when absent): `approval`, `choice`, `input` or `ui-part` |
| `message` | `prompt`, when set |
| `toolCallId` | `toolCallId`, when set |
| `responseSchema` | by `reason`, below |
| `metadata.hummingbird` | `{ tool, args, options?, multi?, uiKind?, uiProps? }` (set keys only) |

| `reason` | `responseSchema` (JSON Schema of `ResumeEntry.payload`) |
|---|---|
| `approval` | `{ "type": "object", "required": ["approved"], "properties": { "approved": { "type": "boolean" }, "args": {} } }` |
| `choice` | `{ "type": "object", "required": ["selection"], "properties": { "selection": { "type": "array", "items": { "type": "string" } } } }` |
| `input` | `{ "type": "object", "required": ["value"], "properties": { "value": { "type": "string" } } }` |
| `ui-part` | `{ "type": "object", "required": ["uiAnswer"], "properties": { "uiAnswer": { "type": "object" } } }` |

### 4.2 Answering (Q24)

A new `startRun` on the same thread with `forwardedProps.previousRunId`
= the interrupted run and one `ResumeEntry` per open interrupt:

- `status: "resolved"`, `payload` = the answer, shaped as the old respond
  route's body without `requestId` / `mcpServers`: `{ approved, args? }`,
  `{ selection }`, `{ value }` or `{ uiAnswer }` (validated against the
  interrupt's `responseSchema`).
- `status: "cancelled"` abandons the interrupt — for `approval` the same
  as `{ approved: false }`; for the others the tool gets a "the user
  declined to answer" result.

`hb.interrupt_resolved.payload` has the same shape.

**The resume run's stream.** The resume run continues the interrupted
turn: before any model output it emits, in a step of its own, one
`tool_output` per answered interrupt (the approved tool's result, the
"declined" text, or the answer itself) → `TOOL_CALL_RESULT {
toolCallId }`. That call's `TOOL_CALL_START` / `ARGS` / `END` were in
the **previous** run's stream (its `tool_input`), never in this one.
AG-UI allows it — a `TOOL_CALL_RESULT` needs no open tool call: the
`@ag-ui/client` 1.0.5 verifier and apply pipeline accept the resume
stream both after the interrupted run's stream on the same client and
on a fresh client — so a client appends the tool message to the
history it already holds (where the assistant message with that tool
call is). The answers' `TOOL_CALL_RESULT`s are the only events of a
resume run that refer to another run's ids.

**One live resume per interrupted run.** The interrupted run stays
`interrupted`; while another run that answers it is running,
interrupted or succeeded, a new resume is `409 run_already_resumed` —
two answers would both continue the same turn, and an approved tool
would run twice. The rule is enforced where runs are stored
(`tasks_one_live_resume`, migration 0042; the memory store applies the
same rule), so two concurrent requests to different processes cannot
both start. A resume that failed or was cancelled frees the slot: the
interrupts can be answered again with a new `runId`. A retry of the
resume itself (same `runId`) is the usual idempotent replay.

**What the model continues from (Q31).** The interrupted run stores its
harness state with its outcome (`tasks.checkpoint`, or the memory
store's copy for a run without a database); the resume run reads it
as its own owner and continues the turn from it — the tool results the
model saw, in full, not the summaries the client holds. Without one
(an anonymous run past its TTL, an interactive run whose log was purged
— the checkpoint goes with it, § 7 — or another harness) the harness
rebuilds what it can from the client's `messages`.

## 5. Results, errors and usage

The closing event's data comes from the run row, falling back to the
log for pre-0041 rows (`outcome` null):

- `RUN_FINISHED.result` (succeeded) = `tasks.outcome.result` (a
  `RunResult`), else built from the `result` entry: `{ text: finalText,
  memoryTainted: true }` (keys only when set).
- `RUN_ERROR` (failed) = `tasks.outcome { code, message }`, else the
  `result` entry's `{ errorCode ?? "unknown", error ?? "Run failed." }`;
  a failed run with neither (orphaned, failed by a reaper) uses the
  reaper's code: `worker_lost` for an interactive run (its process
  died, Q28), `no_worker` for a background one, with the message
  `"Run failed."`.
- `usage` (both events) = the `result` entry's `usage`, each entry
  already an AG-UI `TokenUsage`; omitted when empty. "The `result`
  entry" is the last one encoded that no later resume marker
  superseded.
- `Run.result` / `Run.error` carry the same objects.

## 6. Streams

### 6.1 Framing

Every stream, `startRun` (interactive) and `streamRunEvents` alike:

1. `RUN_STARTED { threadId, runId, parentRunId? }` — no SSE `id`. A
   rejoining client ignores the repeat. (Only `RUN_STARTED`, `gap`, a
   purged run's empty `MESSAGES_SNAPSHOT` and the closing events lack
   an id; every event encoded from a log entry has one.)
2. When the cursor is in the compacted or purged range (§ 6.3): `gap`,
   then `MESSAGES_SNAPSHOT`.
3. The encoded entries after the cursor, replayed, then live.
4. The closing events (§ 6.4), then the response ends.

Each SSE message is `id: <cursor>\n` (omitted where 1. says) + `data:
<compact JSON of one AG-UI event>\n\n`. No `event:`
field. Comment lines (`: keep-alive`) may be sent at any time and carry
no id; agent-py sends one after ~15 s without a frame.

### 6.2 Cursor

An entry `s` that encodes to `n ≥ 1` events gives them ids `s.0`, `s.1`,
…, `s.(n-2)` and, for its **last** event, plain `s`. Ids strictly
increase within a stream; ordering is by `(seq, k)` with plain `s`
after every `s.k`.

Replaying after cursor `c`:

- `c = s` → start at the first entry with `seq > s`;
- `c = s.k` → re-encode entry `s` and send its events with index `> k`,
  then continue with `seq > s`;
- `c = 0` → the whole log.

A cursor whose entry `s` is superseded (§ 6.5 — the client saw it live
before a rewind) has nothing to re-encode: replay continues with the
first retained entry with `seq > s`, which is at the latest the marker.

The encoder is stateful (open block, parent message id, open
sub-agents), so before sending anything after `c` the stream **primes**
it: it encodes every retained entry up to and including `c`'s entry
(for `s.k`, the entry itself up to index `k`) and discards the output.
Priming makes a resumed stream byte-identical to the corresponding
tail of a full replay.

A cursor whose `seq` exceeds the log's highest `seq` (outside the
compacted or purged range) is `400 invalid_request`.

### 6.3 Gap

The log is compacted (§ 7) — its entries below a point replaced by one
`messages_snapshot` entry at `seq = C` — or purged (no entries left).

- Compacted and `c` is before `C` — `seq < C`, or `C.k` (a cursor the
  client got for the original entry `C` before it was folded): send `CUSTOM hummingbird.gap { after:
  c, resumeAt: C, reason: "compacted" }` (no id), then the
  `messages_snapshot` entry encoded as `MESSAGES_SNAPSHOT` (id `C`),
  then continue after `C`.
- Purged (the run is over and its log is empty): `CUSTOM
  hummingbird.gap { after: c, resumeAt: null, reason: "purged" }`, then
  `MESSAGES_SNAPSHOT { messages: [] }` (no id), then the closing events
  (built from the row, § 5).
- Otherwise no gap.

`MESSAGES_SNAPSHOT.messages` is **this run's output only**, not the
thread: a client replaces what it holds of this run's output with it
and keeps everything else (the history it sent, other runs). This is
narrower than AG-UI's conversation-wide snapshot and is why it is only
ever sent right after a `gap`.

### 6.4 Live tail and the closing events

After replay the stream follows the log: in the run's own process
the appender wakes its subscribers at once, elsewhere they poll the
log about every 250 ms (Q29). Either way a woken subscriber reads the
new entries from the log rather than taking the appender's objects, so
a live stream and a replay decode the same stored entries (Postgres
`jsonb` reorders object keys). While idle, the stream re-reads the run
row on each poll tick, and at once after an entry that ends a run
(`result`, a `status` of `paused` / `cancelled` / `done` / `failed`).

**The run row decides when the stream ends**, not an entry — a worker
can die after writing `result` but before settling the row, and a
reclaimed job's resume marker then supersedes that `result` (today's
`gateLiveTailBatch` rule, `lib/shared/agent/events.ts`). So:

- entries are encoded and sent as they arrive (terminal entries encode
  to nothing anyway, § 3.2, except a `result`'s verification activity —
  a resume marker after it rewinds it like any other event);
- once the row is terminal (`done` / `failed` / `cancelled`) or
  interrupted (`paused` with open interrupts), and every entry the log
  holds has been sent, the stream emits the **closing events** and
  ends: close the open block (if any — normally the terminal entry,
  being a non-token entry, has closed it already); end every sub-agent
  still open (`SUBAGENT_FINISHED`, innermost first) and the step still
  open (`STEP_FINISHED`) — a cancel or a reap settles the row before the
  harness writes its `step_end`, and AG-UI forbids `RUN_FINISHED` inside
  a step or sub-agent (the `@ag-ui/client` verifier rejects it); then
  the run's closing AG-UI event from § 1 with the data from § 5. A step
  or sub-agent opened by a rewound attempt (§ 6.5) is discarded with it,
  not closed. The encoder
  exposes this as a separate call (`finish`), because it depends on the
  row, not on an entry.
- **The closing events carry no SSE id** (like `RUN_STARTED` and
  `gap`): they belong to no log entry. A client that reconnects after
  receiving them gets them again — after the replay of nothing — which
  is harmless, since the run is over.
- A row that is `paused` without open interrupts (waiting on sub-agent
  runs) is still running: keep tailing.

### 6.5 Rewind (background runs)

A background run's worker may die mid-chunk; another worker resumes it
from its last checkpoint and writes a resume marker (`status: running`,
`resumedFromSeq: a`). Entries with `a < seq < marker` are the dead
attempt's output.

- **Replay** never sends superseded entries: before encoding, the
  stream drops them (`drop_superseded_events`) — but still sends the
  marker's `hb.rewind`, which then discards nothing.
- **Live**, the client may already hold them: on `hb.rewind { after: a
  }` it discards every event it received from this stream whose cursor
  `seq` is greater than `a` and smaller than the rewind's own. Resume
  checkpoints are taken at step boundaries, where no block is open, so
  nothing is left half-open on replay; live, the encoder drops the
  dead attempt's open block at the marker without closing it (§ 3.2).

Interactive runs never resume (Q28: a dead process fails the run), so
they never rewind.

## 7. Compaction (Q17, Q30)

The log is a replay buffer, not the transcript (`messages` is the
durable record). While a run is live every entry is kept (text deltas
already coalesced by the appender, ~100–250 ms). After it ends:

**When.** A run is compactable once it is terminal or interrupted
**and** at least the delta retention (~24 h) has passed since it ended.
Compaction applies to **interactive runs only** until Phase 5: the old
task routes (`/api/tasks/:id/stream`, the tasks panel's `reduceRun`
fold) read background runs' full logs and would break on a compacted
one. Once they are gone, background runs are compacted the same way
and keep the compacted log as long as the run row exists. Interactive
runs' compacted logs are deleted after a further retention window
(**purged**), the run row staying (Q30); the purge also clears the run's
`tasks.checkpoint` (an interrupted run's harness state holds full tool
outputs — conversation content like the log). Background runs keep
theirs.

**What.** Let `T` be the seq of the run's first **closing entry** — a
`result`, or a `status` of `cancelled`, `done`, `failed` or `paused`
(interrupted) — or, when there is none, `max seq + 1`. Superseded
entries (§ 6.5) are deleted. Every entry with `seq < T` is **folded**:
removed, and replaced by one `messages_snapshot` entry at `seq = C`,
the highest folded seq, whose `step` is that entry's `step`. Entries
`≥ T` are kept unchanged. One transaction. If nothing is below `T`,
there is nothing to do; if the only entry below `T` is already a
`messages_snapshot`, the log is compacted — compaction is idempotent.

**The fold** produces AG-UI messages in the order of the entry that
created each, with the ids of § 2, so they are exactly what a client
that watched the live stream holds:

| Folded entries | Message |
|---|---|
| a text block | `AssistantMessage { id, role: "assistant", content: <the block's text> }`, plus `toolCalls` for every `tool_input` whose `parentMessageId` is this id |
| a tool-only parent | `AssistantMessage { id, role: "assistant", toolCalls }` (no `content`) |
| `tool_input` | `ToolCall { id: toolCallId, type: "function", function: { name: toolName, arguments: JSON(args) } }` on its parent message |
| a reasoning block | `ReasoningMessage { id, role: "reasoning", content }` |
| `tool_output` | `ToolMessage { id: "R:s", role: "tool", toolCallId, content: <as TOOL_CALL_RESULT>, error: summary (only when isError), metadata: { hummingbird: { toolName } } }` |
| part entries | `ActivityMessage { id: messageId, role: "activity", activityType, content }` — one per `messageId`, at its first position, with the last content |
| a `result` (it is never below `T` — listed for completeness) | — |
| an earlier `messages_snapshot` | its messages, verbatim |
| everything else (`status`, `step_*`, `step_error`, `handoff`, `approval`, `compact`) | dropped |

What a compacted run still has: the snapshot (output), the closing
entries (`result`: final text, verification, memory taint, usage,
error; `status`), and the row (`outcome`: result / error / open
interrupts). What it loses: step boundaries, sub-agent markers,
step errors, the timing of deltas.

## 8. Anonymous runs (Q16, Q20)

Same events, same encoder, same stream rules. The log lives in the
backend process's memory (interactive runs execute there anyway, Q28)
and is dropped about 15 minutes after the run ends (it is sealed); it
is never compacted. The memory is bounded per run and in total; an
append past a cap fails, except for the entries that end a run, and
the run driver fails the run (`event_log_memory.py` documents the
caps) with `RUN_ERROR { code: "limit_reached" }`. Afterwards every
operation on the run answers 404. A process restart loses anonymous
runs. A backend without a database keeps signed-in interactive runs
the same way (memory, same TTL); their background runs are `503
unavailable`.

## 9. Example

An interactive run `R` that thinks, searches, then answers. Log →
stream (`RUN_STARTED` first, no id):

| seq | internal entry | SSE id | AG-UI event |
|---|---|---|---|
| 1 | `routed_model { model: "m" }` | `1` | `ACTIVITY_SNAPSHOT { messageId: "R:routed_model", activityType: "hummingbird.routed_model", content: { model: "m" }, replace: true }` |
| 2 | `step_start` (step 1) | `2` | `STEP_STARTED { stepName: "step-1" }` |
| 3 | `token { channel: "reasoning", text: "Look it up." }` | `3.0` / `3.1` / `3` | `REASONING_START { messageId: "R:3" }`, `REASONING_MESSAGE_START { messageId: "R:3", role: "reasoning" }`, `REASONING_MESSAGE_CONTENT { messageId: "R:3", delta: "Look it up." }` |
| 4 | `tool_input { tool_call_id: "tc1", tool_name: "webSearch", args: { query: "x" } }` | `4.0` … `4` | `REASONING_MESSAGE_END { messageId: "R:3" }`, `REASONING_END { messageId: "R:3" }`, `TOOL_CALL_START { toolCallId: "tc1", toolCallName: "webSearch", parentMessageId: "R:4" }`, `TOOL_CALL_ARGS { toolCallId: "tc1", delta: "{\"query\":\"x\"}" }`, `TOOL_CALL_END { toolCallId: "tc1" }` |
| 5 | `tool_output { tool_call_id: "tc1", summary: "1 result", results: […] }` | `5` | `TOOL_CALL_RESULT { messageId: "R:5", toolCallId: "tc1", role: "tool", content: "{\"summary\":\"1 result\",\"results\":[…]}", metadata: { hummingbird: { toolName: "webSearch" } } }` |
| 6 | `step_end` (step 1) | `6` | `STEP_FINISHED { stepName: "step-1" }` |
| 7 | `step_start` (step 2) | `7` | `STEP_STARTED { stepName: "step-2" }` |
| 8 | `token { text: "It is " }` | `8.0` / `8` | `TEXT_MESSAGE_START { messageId: "R:8", role: "assistant" }`, `TEXT_MESSAGE_CONTENT { messageId: "R:8", delta: "It is " }` |
| 9 | `token { text: "blue." }` | `9` | `TEXT_MESSAGE_CONTENT { messageId: "R:8", delta: "blue." }` |
| 10 | `step_end` (step 2) | `10.0` / `10` | `TEXT_MESSAGE_END { messageId: "R:8" }`, `STEP_FINISHED { stepName: "step-2" }` |
| 11 | `result { status: done, final_text: "It is blue.", memory_tainted: true }` | — | nothing; once the row is `done`, the closing event (no id): `RUN_FINISHED { threadId, runId: R, outcome: { type: "success" }, result: { text: "It is blue.", memoryTainted: true } }` |

Rejoin with `after=4.1` → `RUN_STARTED`, then `TOOL_CALL_START` (id
`4.2`) onward. After compaction (`T` = 11, `C` = 10) a replay from `0`
is: `RUN_STARTED`; `CUSTOM hummingbird.gap { after: "0", resumeAt: 10,
reason: "compacted" }`; `MESSAGES_SNAPSHOT` (id `10`) with
`ActivityMessage R:routed_model`, `ReasoningMessage R:3`,
`AssistantMessage R:4 { toolCalls: [tc1] }`, `ToolMessage R:5`,
`AssistantMessage R:8 { content: "It is blue." }`; then `RUN_FINISHED`
(no id).
