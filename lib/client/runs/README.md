# `lib/client/runs/` — chat on agent-py's runs API

Phase 3 of [`docs/PLAN-frontend-backend-split.md`](../../../docs/PLAN-frontend-backend-split.md)
(Q32–Q39): chat turns as AG-UI runs on agent-py's `/v1/runs`, behind the
**"agent-py (runs)"** backend option (`chatBackend: "python-runs"`, store
v35). Wave 4a built this folder; wave 4b wires it in. Wire rules:
[`packages/contract/RUN_EVENTS.md`](../../../packages/contract/RUN_EVENTS.md)
and the `runs` operations of `packages/contract/openapi.yaml`.

```
apiClient.runs.* ── transport.ts ── RunStream (SSE + cursor + reconnect + X-Run-Token)
                                       │
session.ts ── HummingbirdRunAgent (agent.ts, @ag-ui/client: enforce → verify → apply)
                                       │ onVerified(item)
              reduceRunEvent (reducer.ts) ── ops ──▶ RunSink (4b-A: the assistant message)
```

| Module | What |
|---|---|
| `config.ts` | `RUNS_CHAT_ENABLED` — hides the option until 4b-A flips it |
| `types.ts` | `RunsTarget`, contract types (`Run`, `StartRunRequest`, `RunForwardedProps`, …), AG-UI re-exports |
| `transport.ts` | `startRun`, `rejoinRun`, `getRun`, `cancelRun`, `resumeRun` = `apiClient.runs.{start,rejoin,status,cancel,resume}` |
| `sse.ts` | SSE parser that keeps each message's `id:` (the cursor) |
| `errors.ts` | `RunsError`; `messageErrorFor(code)` → chat's `MessageError` |
| `run-tokens.ts` | anonymous runs' `X-Run-Token`, per run, in localStorage |
| `active-run.ts` | per-conversation active-run pointer (codec: `lib/shared/runs/active-run.ts`) |
| `build-input.ts` | `buildRunInput(chat inputs)` → `RunAgentInput` |
| `interrupts.ts` | `PendingInterrupt`, `InterruptAnswer`, `buildResume` |
| `chat-bridge.ts` | the 4b-A ↔ 4b-B seam: `useInterruptedTurns` (ephemeral paused turns) + `registerChatRunBridge` / `getChatRunBridge` (`answerInterrupts`) |
| `interrupt-answers.ts` | 4b-B, pure: interrupt → card question, card answer → `InterruptAnswer`, `submitTurnAnswers` (via the bridge), failure classes, answered ui parts |
| `restore-interrupted.ts` | 4b-B: rebuild interrupted turns after a reload (pointer + `status`); `use-restore-interrupted-turns.ts` mounts it from the chat panel |
| `reducer.ts` | the pure AG-UI → store step |
| `agent.ts` | `HummingbirdRunAgent extends AbstractAgent` with our transport |
| `session.ts` | `startRunSession` / `rejoinRunSession` / `resumeRunSession`, `RunSink`, `applyRunOps` |
| `fixtures/` | recorded agent-py streams + a store-message model (tests only) |

Ids: `lib/shared/runs/ids.ts` (`mintRunId`, `threadIdFor(conversationId)`),
cursors: `lib/shared/runs/cursor.ts`.

## How `@ag-ui/client` is used, and why

`@ag-ui/client` / `@ag-ui/core` **1.0.5** (exact; the version agent-py's
streams were checked against). We subclass `AbstractAgent` and give it our
transport (`run()` / `connect()` read a `RunStream`) instead of using
`HttpAgent`, which can't track the SSE cursor, rejoin, reconnect or send
`X-Run-Token` (Q37). Subclassing — rather than piping events through
`verifyEvents` / `defaultApplyEvents` by hand — runs the pipeline exactly
as the library composes it in `runAgent` / `connectAgent` (compatibility
boundary → `enforceEvents` → `transformChunks` → `verifyEvents` → apply),
plus its interrupt bookkeeping (`pendingInterrupts`, and the
resume-coverage / expiry check in `onInitialize`), without copying
private wiring.

The reducer is fed from inside that pipeline: `observeRunStream` calls
`subscriber.next(event)` — the checks run synchronously — and hands the
item (event + cursor) to the reducer only if the pipeline didn't reject
it. So the store only ever sees verified events, in order, with cursors.
The agent's `messages` (its apply state) hold only this run's output and
come back in `RunSessionResult.messages`; tests assert they agree with the
reducer's view on every recorded stream.

Two consequences shaped the design:

- **Rejoin always replays from `"0"`.** A tail from a mid-run cursor
  starts with a `TEXT_MESSAGE_CONTENT` whose `START` it never sent; the
  verifier rejects it (tested). Replaying also keeps the message exact —
  the persisted message and the saved cursor are written at different
  moments. `rejoinRunSession` folds quietly up to the saved cursor and
  then emits **one** `reset` (no flicker), then streams live. Within a
  session, a broken connection is resumed from the cursor by the transport
  itself, invisibly to the pipeline (it drops the repeated `RUN_STARTED`).
- **A run must close its scopes.** The verifier rejects `RUN_FINISHED`
  inside an open step; agent-py's encoder now closes the open step /
  sub-agents before the closing event (a cancel can settle the row before
  the harness writes `step_end` — fixed in this wave, RUN_EVENTS.md § 6.4).

Bundle: `transport.ts` (via `apiClient`) is ~8 KB min / 3 KB gz and
imports `@ag-ui/*` for types only. `session.ts` pulls `@ag-ui/client`,
`@ag-ui/core`, `rxjs`, `fast-json-patch` (~150 KB min / ~41 KB gz on top
of zod, which the app already ships; `@ag-ui/client` imports `zod/v4`).
**Import `session.ts` lazily** (`await import("@/client/runs/session")`)
on the runs path only, so other users never download it.

## Transport — `apiClient.runs.*`

All throw `RunsError { kind: "http" | "network" | "aborted" | "protocol",
status, code }` (unlike the rest of `apiClient`); `err.toMessageError(model)`
gives the bubble. `target` is `await resolveRunsTarget()`
(`lib/client/api/backend-resolver.ts`): `null` unless the option is
selected and agent-py configured; `authToken: null` when signed out.

```ts
start(body: StartRunRequest, opts: RunStreamOptions): Promise<RunStream>
rejoin(runId, opts: RunStreamOptions & { after?: RunCursor }): Promise<RunStream>
status(runId, opts: RunRequestOptions): Promise<Run>          // GET /v1/runs/{id}
cancel(runId, opts: RunRequestOptions): Promise<Run>          // POST …/cancel (idempotent)
resume({ input, previousRunId, resume }, opts): Promise<RunStream>

interface RunRequestOptions { target: RunsTarget; signal?; runToken?; tokens?; fetch? }
interface RunStreamOptions extends RunRequestOptions {
  onCursor?(cursor): void; maxReconnects?: number /* 3 */; reconnectDelayMs?: number /* 500 */
}
interface RunStream extends AsyncIterable<{ event: AgUiEvent; cursor: RunCursor | null }> {
  runId; runToken: string | null; cursor: RunCursor; close(): void
}
```

Auth: `Authorization: Bearer` when signed in; otherwise the run's
`X-Run-Token` — saved from the start response, presented on a retry
(same `runId`), on a resume (the previous run's token), and on
status / cancel / rejoin; dropped when the run ends for good (kept while
interrupted), on a 404, or after an hour.

Error codes worth handling: `409 run_id_conflict` (never expected: run ids
are fresh UUIDv4s), `409 run_already_resumed` (someone answered first —
refresh with `status`), `409 invalid_state` (stale interrupts), `429
rate_limit`, `401 auth_required`, `400 unknown_model` (only `anthropic/*`
models with an `anthropicModelId` are allowed, as on `/v1/chat`), `404`
(anonymous run forgotten). `messageErrorFor` maps known codes and aliases
`upstream` / `unavailable` → `provider`; the rest → `unknown` + `detail`.

## Reducer + sink

```ts
reduceRunEvent(state: RunTurnState, event: AgUiEvent): { state; ops: RunTurnOp[] }
type RunTurnOp =
  | { type: "frame"; frame: NormalisedFrame }     // exactly a /v1/chat frame (translateFrame's envelope)
  | { type: "reset"; frames: NormalisedFrame[] }  // clear the message's output, then apply
  | { type: "rewind"; after: number }             // handled by the session
  | { type: "finished"; outcome: RunOutcome }     // handled by the session → done
type RunOutcome =
  | { type: "success"; result: RunResult; memoryTainted: boolean }
  | { type: "interrupt"; interrupts: PendingInterrupt[] }
  | { type: "cancelled" }
  | { type: "error"; code: string; message: string; error: MessageError }

interface RunSink { frame(frame: NormalisedFrame): void; clear(): void }
applyRunOps(sink, ops)
```

Mapping table: the docstring of `reducer.ts`. Text of every text message
appends to one placeholder with no separator (as `/v1/chat`); tool calls
are announced at `TOOL_CALL_END` with parsed args; results carry
`{summary, results}`; `ACTIVITY_SNAPSHOT` content goes through the
translator's `translateDataPart` (`plan` / `artifact_ref` are kept in the
view only); `gap` + `MESSAGES_SNAPSHOT` become a `reset`; memory taint is
`outcome.memoryTainted`.

## Sessions

```ts
startRunSession(body: StartRunRequest, opts: RunSessionOptions): RunSession
rejoinRunSession({ runId, threadId, quietUntil? }, opts): RunSession
resumeRunSession({ input, previousRunId, interrupts, answers }, opts): RunSession

interface RunSessionOptions {
  target: RunsTarget; sink: RunSink
  onStarted?({ runId, threadId, runToken }): void   // first RUN_STARTED
  onCursor?(cursor): void
}
interface RunSession {
  runId; threadId
  done: Promise<{ outcome: RunOutcome | null; state: RunTurnState; messages; cursor }>  // never rejects; null = detached
  cancel(): Promise<{ ok: true } | { ok: false; error: RunsError }>                      // Stop
  detach(): void                                                                       // stop reading; run continues
}
```

## For wave 4b-A — wiring `use-chat-send`

1. In `callChatAPI`, after the existing request assembly:
   `const target = await (await import("@/client/api/backend-resolver")).resolveRunsTarget()`.
   `null` → today's path, unchanged. Otherwise the runs path (and flip
   `RUNS_CHAT_ENABLED` to `true` in the same change). Signed-out users get
   a target too — skip the `authToken` / mock-fallback logic for them.
2. Extract the stream loop's per-frame `if (parsed.type === …)` chain into
   a `handleFrame(parsed)` closure (no behaviour change); `/v1/chat` keeps
   calling it from `translateFrame`. The runs `RunSink` is
   `{ frame: handleFrame, clear }`, where `clear` calls the new store
   mutator `clearMessageOutput(placeholder.id)` and resets the local
   `toolCalls` buffer, `liveToolCalls[placeholder.id]` and the reasoning
   timers.
   **Artifacts on reset:** a `reset` re-applies `tool_image` / `tool_file`
   frames; keep the ids of the generated images / files the message had
   before the clear and don't `createArtifact` for those again.
3. Send: `const body = buildRunInput({ conversationId: targetConvId, history,
   model: modelForCall, systemPrompt: workspaceSystemPrompt, skills:
   enabledSkills, workspaceId: activeWorkspaceId || undefined })`, then
   `const session = (await import("@/client/runs/session")).startRunSession(body, { target, sink, onStarted, onCursor })`.
   (Parity Q32: attachments, MCP servers, sandbox files, reasoning effort,
   reference images and the memory opt-out are not sent. The contract caps
   `systemPrompt` at 20 000 chars and `skills` at 10 — `422` past them.)
   Parts can arrive before any text (`routed_model` is a run's first
   event), so create the placeholder before starting, not on the first
   text frame; "empty response" is then `!hasOutput(result.state.view)`.
4. Stop → `session.cancel()`. Keep a per-conversation map of sessions next
   to `abortControllersRef` (`stop()` cancels the active conversation's;
   a deleted conversation's session is `detach()`ed). Unmount → `detach()`.
5. Outcome (`await session.done`): `success` → today's finalisation
   (auto-archive, `toPersistedToolCalls`, reasoning duration) and memory
   extraction with `{ tainted: outcome.memoryTainted }`; `!hasOutput(state.view)`
   → today's "empty response" bubble; `error` → `surfaceError(outcome.error)`
   (add `model`), with `outcome.code === "network"` before any output as
   the auto-retry case — retry with the **same** `body` (an idempotent
   retry); `cancelled` → as an abort today (drop an empty placeholder);
   `interrupt` → persist done tool calls as on success, then hand
   `outcome.interrupts` to 4b-B; `null` (detached) → leave the message.
6. Sync hold: `setConversationStreaming(conv, true)` before starting /
   rejoining; on `done`, release it only if this conversation's session
   is still this one (the same "still my controller" guard as today).
7. Pointer (Q36): `onStarted` → `saveActiveRun({ runId, threadId,
   conversationId, messageId: placeholder.id, status: "running", cursor:
   "0", anonymous: !target.authToken, model })` (the placeholder exists
   already, step 3); `onCursor` →
   throttled (~1 s) `updateActiveRun(conv, runId, { cursor })`; outcome
   `interrupt` → `updateActiveRun(…, { status: "interrupted" })`; any other
   outcome → `clearActiveRun(conv, runId)`.
8. Reload: on mount, for each `listActiveRuns()` with `status: "running"`
   whose message still exists: hold the sync, `rejoinRunSession({ runId,
   threadId, quietUntil: cursor }, { target, sink })` into that message
   (it resets once caught up), then step 5. `status: "interrupted"` →
   4b-B. A run the backend forgot (`outcome.code === "not_found"`) →
   `clearActiveRun` and leave the message as persisted.

## For wave 4b-B — answer cards + resume

- The pending interrupts: `outcome.interrupts` (live) or
  `pendingInterrupts(await apiClient.runs.status(runId, { target }))`
  (after a reload). Shape — `PendingInterrupt` in `interrupts.ts`: `id`,
  `reason` (`approval` | `choice` | `input` | `ui-part`), `message?`,
  `toolCallId?`, `tool?` + `args?`, `options?` + `multi?` (choice),
  `uiKind?` + `uiProps?` (ui-part: render the generative-UI part as the
  card), `expiresAt?`, `raw`. Recorded examples:
  `fixtures/agent-py/memory-interrupt-{signed_in,choice,ui}.sse`.
- Answers: `InterruptAnswer` — `{ approved, args? }`, `{ selection }`,
  `{ value }`, `{ uiAnswer }`, or `{ cancelled: true }`.
- Resume: `resumeRunSession({ input: buildRunInput({ conversationId,
  history: <the interrupted run's history, up to its user message>, model,
  … }), previousRunId, interrupts, answers }, { target, sink })` — a fresh
  `runId`, same thread. Every open interrupt needs an answer
  (`buildResume` throws otherwise; an expired one can only be cancelled).
  Anonymous: the previous run's token is presented automatically.
  agent-py continues the turn from the interrupted run's stored checkpoint
  (Q31). Without it — an anonymous run past its ~15 min memory TTL — the
  text-only history carries no tool calls, so the resume fails
  `invalid_state`; show "this question expired" and offer to resend.
- Continue the **same** assistant message: seed the sink's tool-call
  buffer with the message's persisted `toolCalls` (as `done`) — the resume
  run's stream starts with a `tool_call` + `tool_result` for each answered
  call (the reducer announces calls it didn't see start), and its text
  appends to the existing content. Update the pointer to the new run id.
- Typing a new message while interrupted (Q35): `apiClient.runs.cancel(
  previousRunId, { target })`, `clearActiveRun`, then send normally.
- `409 run_already_resumed` → another tab answered: re-read `status`.

### Built (4b-B)

- **Cards** — `components/agent/interrupt-cards/answer-cards.tsx`
  (approval / choice / input / ui-part), shared with the task strip;
  model + respond bodies in `lib/shared/agent/answer-cards.ts`. Chat
  renders them under the paused message (`components/chat/interrupted-turn-cards.tsx`,
  mounted by `chat-message.tsx` from `useInterruptedTurn(activeConversationId)`).
  Once every open interrupt has an answer they go to
  `getChatRunBridge().answerInterrupts(turn, answers)`; the cards stay
  disabled ("Sending your answer…") until it resolves. On success the
  answered `ui-part`s are written to the message's `uiParts` (inert, as
  on `/api/chat`) and the turn is cleared if the bridge hasn't already.
- **Failures** — `run_already_resumed` → "answered in another tab", the
  run is re-read and a run that moved on / 404 loses card + pointer;
  `invalid_state` → "expired" + **Resend message** (= the error bubble's
  retry: delete the paused message and resend the history before it);
  others → inline error + Retry. An interrupt past `expiresAt` (or of an
  unknown reason) can only be dismissed (`{ cancelled: true }`). No bridge
  → disabled with a hint, sent once it registers.
- **renderUI (Q35)** — a `ui-part` interrupt is the registry's component
  as the card; its answer is `{ uiAnswer, value?, selection? }` (the
  respond route's body minus `requestId`: agent-py shows the model
  `value`, the formatted text). `MessageUiParts` hides the parts an open
  turn owns, so a runs part never auto-sends or prefills the composer.
  A read-only `info-table` part gets a **Continue** button.
- **Reload** — `useRestoreInterruptedTurns(hydrated)` (chat panel):
  `interrupted` pointers whose message exists → `status` → turn; 404 /
  not interrupted → `clearActiveRun`; network errors / a changed
  identity (signed in ↔ out) leave the pointer alone.

## For wave 4b-C — Playwright smoke

- Backend: `RUNS_STUB_HARNESS=true` agent-py (`docker compose up proxy
  agent-py` with `NEXT_PUBLIC_AGENT_PY_URL=/`, or agent-py on :8000 with
  `CORS_ALLOWED_ORIGINS=http://localhost:3000`). Signed out is enough
  (anonymous runs); no `SUPABASE_*` needed for that.
- Enable the option: after 4b-A, `RUNS_CHAT_ENABLED` is `true` and the
  toggle shows ("agent-py (runs)" for signed-out users). Or seed it before
  load: `localStorage["hummingbird-storage"] = JSON.stringify({ state: {
  …, chatBackend: "python-runs" }, version: 35 })` (merge into an
  existing value).
- Steer the stub per run by rewriting the request with `page.route("**/v1/runs",
  …)`: add `forwardedProps.conformance = { outcome: "succeed" | "fail" |
  "interrupt", steps: 1..20, stepDelayMs: 0..10000 }` (and drop
  `forwardedProps.model` unless the chosen model is an allow-listed
  `anthropic/*` one — otherwise `400 unknown_model`).
- Assert: **send** → the bubble reads `Stub reply to: <text>` (plus
  ` (step N)` per extra step); **stop** (`steps: 5, stepDelayMs: 2000`,
  click Stop after the first text) → `POST /v1/runs/{id}/cancel`, the
  bubble keeps the partial text, no error; **reload + rejoin** (`steps: 3,
  stepDelayMs: 1000`, reload mid-run) → `GET /v1/runs/{id}/events`, the
  final text is complete and not duplicated; **interrupt** (`outcome:
  "interrupt"`) → an approval card for `Approve the stub action?`
  (interrupt id `<runId>:approve`); answering → a second `POST /v1/runs`
  with `resume[0].interruptId` = that id and `previousRunId`, and the
  bubble gains `Resumed: <runId>:approve=resolved`.

## Fixtures

`fixtures/agent-py/*.sse` are recorded from agent-py by
`bun run fixtures:runs` (`scripts/record-runs-fixtures.sh`): `memory-*`
from `services/agent-py/tests/test_runs_e2e.py` (the real app over HTTP),
`stream-*` from `tests/test_runs_client_fixtures.py` (the real encoder +
stream over crafted logs: reasoning, every part, gap, purge, rewind,
failures). Re-record after changing agent-py's runs output;
`reducer.test.ts` fails if a recorded stream has no case.
