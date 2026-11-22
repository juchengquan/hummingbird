# Plan: Frontend / backend split

Status: **Waves 1–5 (Phases 0–2, chat on runs, backend catch-up) shipped (#294–#300).** Decided in a design interview
on 2026-11-21. Supersedes the open parts of
[`PLAN-backend-extraction.md`](PLAN-backend-extraction.md), whose Phase 1
(single `apiClient` + Zod schemas + `docs/API.md`) shipped and is the
starting point here.

## Why

Today the same backend logic lives in three places — the Next.js routes
(`app/api/**` + `lib/server/**`), `services/agent-py` and
`services/agent-ts` — and every fix has to be made, reviewed and tested
three times. The goals:

1. **One backend owns the logic.** The frontend becomes a client of it.
2. **Frontend and backend deploy separately**, each on its own schedule.
3. **A standard, harness-agnostic contract** between them, so the agent
   loop can move onto an agent harness (LangChain `deepagents`, the
   Claude Agent SDK) without the frontend noticing.
4. Separate codebases later, once the contract package is the only thing
   the two sides share.

## Where we start (coupling survey, 2026-11-21)

- **API layer: already decoupled.** Every frontend→backend call goes
  through `lib/client/api-client.ts`; wire shapes are Zod schemas in
  `lib/shared/api-schemas.ts` + the SSE protocol in `docs/API.md`. Six
  surfaces (chat, summarize, extract, URL fetch, MCP proxy, image-URL
  refresh) exist in all three backends, chosen per account.
- **Data layer: tightly coupled.** The browser is the system of record
  (Zustand + localStorage + IndexedDB). Cloud sync (`lib/client/sync/`,
  ~3k lines) writes ~18 tables straight through `supabase-js` under RLS;
  the memory panel and account instructions do too; files upload to
  Supabase Storage from the browser; task events arrive over Realtime.
- **18 of 25 API routes exist only in Next.js:** all task routes
  (create / cancel / children / respond / stream / sweep / schedules /
  jobs tick), embed, memory extract, editor AI (`ai/command`,
  `ai/complete`), extract-table, share, files refresh-url, csp-report.
- **Next.js also does server work:** OAuth callback (session cookie),
  share pages rendered with the service-role key, the per-request CSP
  nonce (`proxy.ts`), the sandbox frame headers, and a Vercel Cron that
  enqueues scheduled tasks every minute.
- **agent-ts is not independent:** 11 files import the Next app's
  `lib/server` / `lib/shared`, and its Docker build copies `lib/` in.
- **agent-py already executes every background task** (start, respond,
  child fan-out/fan-in, cancel checks, lease reaping) but owns no task
  HTTP route, and has no data-access code for conversations, messages,
  workspaces, files, profiles, memories, shares or schedules.

## Decisions

| # | Decision |
|---|---|
| **Goals and constraints** | |
| Q1 | One backend owns the logic; frontend and backend deploy separately; standardized contract; separate repos possibly later |
| Q2 | Local-first and anonymous mode stay supported |
| Q3 | Supabase stays the platform (auth, Postgres, Storage). **Revisit later** — avoid deepening lock-in where that is cheap |
| Q4 | Incremental: the app works after every PR; no big-bang rewrite |
| **Shape of the split** | |
| Q5 | Browser sync keeps writing to Supabase directly (it is replication, not business logic), behind a narrow sync-target interface so it could later point at a backend API |
| Q6 | `services/agent-py` is *the* backend |
| Q11 | A TypeScript backend stays possible as a **second implementation of the published contract**, gated by a shared, language-neutral conformance suite. Today's agent-ts is frozen (no new endpoints) and stops importing the Next app's `lib/` |
| Q9 | The frontend server holds no secrets and touches no database: share pages fetch from the backend, the scheduler moves into agent-py, all API routes leave Next.js |
| Q12 | Next.js stays as the frontend framework, frontend-only (static export / SPA not in scope) |
| Q25 | The sign-in session lives only in the browser (supabase-js, client-side callback); no server cookies |
| Q10 | One repo: `packages/contract` + the frontend + `services/agent-py`. Separate builds, deploys and versions. Moving the Next app into `apps/web` is a mechanical step deferred to Phase 5 (it would conflict with every PR before then) |
| Q21 | Backend served on the **same origin** through a reverse proxy (`/v1/*` → agent-py, everything else → Next). Bearer JWT on every request, so splitting origins later is free. **Revisit later** |
| **The contract** | |
| Q8 | The frontend never knows which harness runs. Harness adapters translate into the internal event model |
| Q13 | **AG-UI 1.0** is the wire encoding for agent runs. The backend's own internal event model stays the source of truth; AG-UI is an encoder that can be swapped |
| Q14 | A2A only later, as an optional edge of the backend (see [`PLAN-a2a-interop.md`](PLAN-a2a-interop.md)), never the frontend↔backend wire |
| Q19 | **Spec-first.** Hand-written OpenAPI 3.1 + the pinned AG-UI JSON Schema live in `packages/contract`; Pydantic models and TypeScript types are generated from it; the conformance suite reads the same spec. The Zod schemas are generated from it or retired |
| Q22 | Paths carry a major version (`/v1`); within a version changes are additive and clients ignore unknown event types; a breaking change ships as `/v2` alongside `/v1`. This is transitional: once the migration is done, old surfaces are removed outright |
| Q23 | Editor AI (`ai/command`, `ai/complete`) stays a plain streaming endpoint in the AI SDK stream format Plate consumes — the one exception to Q13 |
| **Runs** | |
| Q7 | Run lifecycle as specified below: AG-UI events + a run resource modelled on the LangChain Agent Protocol, with our extensions |
| Q15 | The browser owns the conversation history and sends it with each run (AG-UI `RunAgentInput.messages`); the backend checkpoint covers one run only |
| Q16 | Anonymous runs keep their event log in backend memory for a short time (~15 min); background runs require sign-in |
| Q17 | Every event is kept while a run is live; on finish the log is compacted to messages, tool calls/results, interrupts and the result (deltas dropped after ~24 h); background runs keep their compacted log as long as the task exists. **Until Phase 5 background runs are not compacted**: the old task routes and the tasks panel fold the full log |
| Q18 | Frontend uses `@ag-ui/client` wrapped in our own hook feeding the Zustand message store — not CopilotKit, not `useChat` + a converter |
| Q20 | Anonymous runs are addressed with a per-run secret token (`runToken`); the backend enforces anonymous per-IP rate/budget limits (today's `REQUIRE_AUTH_FOR_AI` moves there) |
| Q24 | Answering an interrupt starts a **new run on the same thread** with `resume[]` (AG-UI semantics). A background "task" is a thread of runs |
| Q27 | Runs reuse the existing `tasks` / `task_events` / `task_jobs` tables during the migration: a run is a `tasks` row (with `mode`), the thread is the conversation. The old task routes and the runs API read the same rows, so nothing is copied or written twice. Old surfaces only see `mode = 'background'`. **Phase 5 renames and reshapes** them into the long-run model (below) |
| Q28 | Interactive runs execute in the API process that received `POST /v1/runs`, streaming to the caller while writing every event to the log; background runs go through `task_jobs` + the poller. If the process dies mid-turn the run is failed (reaper), not handed to another worker |
| Q29 | Rejoin reads the event log: readers in the run's own process get events in memory; readers elsewhere poll the log (~250 ms). Postgres LISTEN/NOTIFY only if polling becomes a problem |
| Q30 | The run event log is a **replay buffer, not the transcript**: text deltas are stored coalesced (flushed every ~100–250 ms), compacted on finish (Q17), and deleted after a retention window while the run row stays. `messages` remains the durable record of a conversation. Partition `run_events` by time only once volume calls for it |
| Q31 | **Harness state stays outside the contract.** A harness's own persistence (LangGraph checkpointers, Claude Agent SDK sessions) is stored opaquely, keyed by run/thread — in `checkpoint` jsonb or harness-owned tables in their own schema — and never shapes `runs` or the API, so swapping harnesses touches neither the contract nor the frontend |
| **Frontend switch (Phase 3)** | |
| Q32 | Chat moves to `/v1/runs` at parity with today's agent-py `/v1/chat` (which already drops attachments, local MCP, code interpreter, citation checks, reasoning effort, memory opt-out, reference images). Catching up with the Next chat route is a **separate backend track** running alongside, and must finish before Phase 5 |
| Q33 | A fourth backend option, **"agent-py (runs)"**, beside `ts` / `python` / `ts-service` (store migration v35, off by default). Once stable, "agent-py" means runs and the old `/v1/chat` path goes in Phase 5. The switch stays per browser (localStorage) for now |
| Q34 | Signed-out users may pick the runs option too (anonymous runs with `runToken`); otherwise they stay on the Next route until Phase 5 |
| Q35 | On runs, `renderUI` and `askUser` **pause the turn** (interrupt) and the answer resumes it (Q24), using the task strip's answer cards. Typing a new message instead cancels the paused run and starts a new one; mini-forms that pre-filled the composer become answer cards |
| Q36 | **Stop cancels the run on the server**; after a reload the browser rejoins an in-progress run (active run id saved per conversation, as tasks do). A reload replays the run from the start and folds it onto the saved message, because AG-UI's verifier rejects a stream that starts mid-message; reconnects within a live session resume from the cursor. A closed tab no longer stops the answer. An anonymous run's interrupt expires with its ~15-min memory log (resume then fails `invalid_state`) |
| Q37 | `@ag-ui/client`'s event checks and state handling with **our own transport** (cursor rejoin, `Last-Event-ID`, `X-Run-Token` — `HttpAgent` can't do these). The AG-UI → store step is a pure function tested against agent-py's recorded run streams |
| Q38 | The tasks panel moves in a later wave, after chat: it needs background answers as new runs, children via `parentRunId`, and cancel through runs first |
| Q39 | A small Playwright smoke test (browser → agent-py with the stub harness: send, stop, reload + rejoin, answer an interrupt) ships with the chat switch |
| Q40 | While an agent service serves chat (`python` / `ts-service` signed in, `python-runs` always), the model picker offers only the models it accepts (the `anthropic/*` allowlist, no Auto), and a selected model it can't run is switched to its default with a visible note — not a 400 on every message, and never silently |
| Q41 | A background run's answers start the new run from the paused run's checkpoint plus the `resume[]` answers (the Q24 way); the paused run stays `interrupted`. Each paused task is answered one way only: after a runs resume, `/api/tasks/:id/respond` refuses it (409), and a task answered the old way can't be resumed through `/v1/runs` (409). The old route works unchanged until Phase 5 |
| Q42 | Local MCP credentials go to **interactive** runs only, in a request field agent-py never stores or logs (not `forwardedProps`), re-sent on each resume. Background runs refuse local MCP, as the Next task routes do. agent-py gets `MCP_ALLOW_PRIVATE_HOSTS` with Next's semantics |
| Q43 | The code interpreter stays Next-only until a short trial shows how microsandbox runs beside agent-py (a separate service agent-py calls over HTTP, or another way); the trial writes findings, not code |
| Q44 | `/v1/runs` keeps its 16 MB body cap. Large inputs go by reference: cloud files by id (agent-py checks the owner itself — its Storage client bypasses RLS), bookmarks as capped text, inline bytes only for a signed-out user's small files |
| Q45 | Local MCP credentials ride in AG-UI `state` (`hummingbird.localMcp`), never a header (Caddy access logs record custom headers); the server list without credentials goes in `forwardedProps`. agent-py holds them in a `repr=False` field and a test checks they never reach `tasks` rows or logs |
| Q46 | Research mode is a `research: true` run option (`mode` already means interactive / background) and agent-py gets the research task prompt Next's `buildTaskSystemPrompt` had — fixing research tasks on the old route too, which share the executor |
| Q47 | The rendered file header carries the file id for cloud files, on Next and runs, so `searchFiles` can be called (RAG mode can't work without it today) |
| Q48 | The per-task allowed MCP servers list is enforced everywhere it applies: agent-py background and interactive runs, and Next's chat route (nothing reads it today) |
| Q49 | Background runs on `/v1/runs` refuse `attachments` (400 `invalid_request`) like local MCP — the Next task routes take none and the wave-6 tasks panel sends none; lifted when a need appears, never silently ignored |
| Q50 | The persona MCP picker lists local-mode servers too, marked as not available in tasks: the allow-list filters both modes (Q48) and an empty list stays "no MCP", so personas made before this tick their local servers once |
| Q51 | A resume keeps the paused run's MCP allow-list on both sides: the browser saves it (ids only) with the run pointer, so blocked servers and their credentials aren't sent from a reload or another tab; agent-py saves it with the paused run and lets a resume narrow it, never widen it (no saved state → no MCP) |

## Run contract (v1)

Copies published designs: events and start input from **AG-UI 1.0**,
the run resource and replay model from the **LangChain Agent Protocol**,
the replay cursor from **OpenAI Responses background mode**. Our own
additions are marked ✚.

| Operation | Shape |
|---|---|
| Start | `POST /v1/runs` — body is AG-UI `RunAgentInput` (`threadId`, `runId`, `messages`, `tools`, `context`, `state`, `resume`, `forwardedProps`); ✚ `mode: interactive \| background` and our other options ride in `forwardedProps`, because `RunAgentInput` is a closed schema (no body means interactive). Interactive → `200` + SSE stream; background → `202 { runId, status }`. **The client mints `runId`** (AG-UI rule); a repeated `runId` is an idempotent retry, not a new run. Anonymous runs also return `runToken` |
| Rejoin ✚ | `GET /v1/runs/{id}/events?after=<seq>` (SSE). The sequence number rides in the SSE `id:` field (AG-UI consumers ignore it; our hook reads it). Past the compaction point the stream sends a `gap` (`CUSTOM` event) followed by `MESSAGES_SNAPSHOT` |
| Status | `GET /v1/runs/{id}` → `{ status: queued \| running \| interrupted \| succeeded \| failed \| cancelled, openInterrupts, result, parentRunId }` |
| Interrupt / resume | Run ends with `RUN_FINISHED { outcome: { type: "interrupt", interrupts: [...] } }`; the answer is a new `POST /v1/runs` on the same thread with `resume[]` covering every open interrupt (Q24) |
| Cancel | `POST /v1/runs/{id}/cancel` — idempotent; the stream closes with `RUN_FINISHED { outcome: cancelled }` |
| List ✚ | `GET /v1/runs?threadId=&status=&parentRunId=&pageToken=` (A2A-style token paging); the tasks panel reads threads from here |
| Sub-agents | Inline in the parent's log as AG-UI `SUBAGENT_*` events; `parentRunId` only for sub-agents that run as separate background runs |

**Long-run data model (Q27, reached in Phase 5).**

| Today | Long run |
|---|---|
| `conversations` | stays the thread |
| `tasks` | `runs`: one row per run, interactive or background — `mode`, `thread_id`, `parent_run_id`, previous run in the thread, status, timestamps |
| `task_events` | `run_events`, numbered per run |
| `task_jobs` | `run_jobs`, the queue for background runs only |
| background-only columns (`goal NOT NULL`, `step`, `max_steps`) | a `mode`-specific `input` jsonb or a small side table for background tasks |

Table renames are atomic metadata changes in Postgres; a short-lived view
covers any outside reader of the old names.

No published protocol defines replay from an event offset (AG-UI
explicitly can't re-enter a stream; A2A warns clients may miss updates;
LangGraph's Agent Server keeps 2 minutes), so the numbered, persisted
event log is ours — generalised from today's `task_events`.

## Phases

Each phase ships as small PRs; nothing is removed until its replacement
has shipped behind the existing per-account backend switch.

0. **Foundations** — `packages/contract` skeleton + codegen + drift check
   + conformance harness; fix the two endpoints the client already
   dispatches remotely but no service implements (`/v1/extract-table`,
   `/v1/files/refresh-url`); decouple + freeze agent-ts; local
   same-origin reverse proxy.
1. **Plain endpoints to agent-py** (no run model needed): share
   create/revoke + public read (share pages fetch it), schedules CRUD +
   an agent-py scheduler loop replacing the Vercel Cron, embed, memory
   extract, csp-report. Proves the contract pipeline on low-risk routes.
2. **Run model in agent-py** — numbered run event log with compaction +
   in-memory log for anonymous runs; internal event model + AG-UI
   encoder; harness-adapter interface with today's agent loop as the
   first adapter; background tasks become threads of runs.
3. **Frontend switches** — `@ag-ui/client` hook for chat behind a new
   "agent-py (runs)" backend option (Q33); then the tasks panel onto
   threads/runs (Q38). In parallel, the backend catches up with the Next
   chat route's features (Q32).

   **Backend catch-up (Q32).** Wave 4b-D sent image / document
   attachments, reasoning effort and generated images (`tool_image`) on
   runs. Still to do before Phase 5:
   - [x] attached-file context as Next builds it — the text budget across
     files, and the meta notes for RAG-mode files ("available via
     `searchFiles`") instead of dropping them (5b-B: `runs/context.py`,
     pinned to Next's renderer by a shared fixture; signed-in files go by
     id, images included, Q44)
   - [x] MCP resources and URL bookmarks as attachments (5b-B; every
     attachment taints the turn)
   - [x] local MCP servers (browser-held credentials) — wave 5b-D:
     `runs/local_mcp.py` (interactive runs; background refused, Q42),
     `MCP_ALLOW_PRIVATE_HOSTS` in agent-py
   - [ ] code interpreter — `runCode`, `sandboxFiles`, `code_result`
     parts (generated files have no producer on runs until then)
   - [x] reference image for image generation
   - [x] `localFilesOnly` for generated images
   - [x] citation checks
   - [x] memory — the per-conversation opt-out, facts in the prompt, the
     remember / forget tools
   - [x] the per-IP image-generation budget
   - [x] reasoning effort and the attachment checks in the background
     executor (5b-A: `reasoningEffort` → extended thinking; a background
     start refuses `attachments`, Q49, and its message parts go through
     the same `check_attachments` as an interactive one)
   - [x] background runs on `/v1/runs`: resume carries the answers into
     the executor (Q41, 0043); starts keep `workspaceId`, `requireApprovalFor`,
     research mode and the allowed MCP servers (5b-A)
   - [x] `auto` model routing, so Auto can return to the agent backends
   - [x] MCP Apps — wave 5b-D (`mcp_tools.build_mcp_tool`, cloud and
     local servers)
   - [x] the per-IP web-tool window
   - [x] RAG-mode files: `searchFiles` needs a file id no prompt carries —
     check whether it works on Next before porting (it didn't: Q47 — the
     header now says `fileId: …` on Next and runs, and the RAG / truncation
     notes name it)
4. **Editor AI to the backend** (Q23).
5. **Removal** — all Next API routes, AI/admin keys from the frontend
   env, the old `/v1/chat`, agent-ts's old routes, the server session;
   move the Next app into `apps/web`; rename and reshape the run tables
   into the long-run model (Q27).
6. **Later, separately** — harness trials (deepagents, Claude Agent SDK)
   as adapters; a TypeScript backend against the conformance suite; the
   revisits (Supabase Q3, same origin Q21, A2A Q14).

## Execution waves

| Wave | Parallel work | Depends on |
|---|---|---|
| 1 (Phase 0) | **A** contract foundation · **B** the two missing remote endpoints · **C** agent-ts decoupling + freeze · **D** reverse proxy + docs | — |
| 2 (Phase 1) | **A** flat `{code, message}` error envelope in agent-py (drop the spec's legacy `{detail}` variant) · **B** sharing (create / revoke / public read; share pages read from the backend when one is configured) · **C** schedules CRUD + an env-gated agent-py scheduler loop (safe alongside the Vercel Cron: same guarded `next_run_at` claim) · **D** embed + memory extract + csp-report | Wave 1 merged |
| 3a (Phase 2) | one agent, sequential: the runs operations in `packages/contract`; the internal-event → AG-UI mapping; the `tasks` migration (Q27) with every old reader limited to background runs; the Python interfaces 3b codes against (event log, encoder, harness adapter, run repository) | Wave 2 merged |
| 3b (Phase 2) | **A** AG-UI encoder + stream mechanics (seq in SSE `id:`, replay, `gap` + `MESSAGES_SNAPSHOT`, in-memory log for anonymous runs, compaction) · **B** runs API (start with idempotent client `runId`, status, cancel, list, `runToken`) + conformance cases · **C** harness-adapter interface with today's loop as the first adapter; chat emits internal events | Wave 3a merged |
| 4a (Phase 3) | one agent: the "agent-py (runs)" option + store migration v35; `@ag-ui/client` / `@ag-ui/core`; `lib/client/runs/` — transport (start, rejoin from a cursor, cancel, run-token storage) and the pure AG-UI → store step tested on recorded streams; the interfaces 4b codes against | Wave 3b merged |
| 4b (Phase 3) | **A** hook into `use-chat-send` (send, Stop → cancel, reload → rejoin, memory taint, sync hold) · **B** chat answer cards + resume (Q35) · **C** Playwright smoke (Q39) · **D** backend catch-up, first slice: image/document attachments, reasoning effort, generated images/files from the native harness | Wave 4a merged |
| 5a (Phase 3) | one agent, the seams: every new run option in the contract (0.4.0) and through agent-py's run input; prompt-section and toolset-contributor hooks in the native harness; a per-run context slot that works for anonymous runs; `mcp_app` on tool results; the citation verifier client in a shared module; the matching `build-input.ts` fields passed on send and resume. Plus the Q43 trial findings ([`TRIAL-code-interpreter-on-agent-py.md`](TRIAL-code-interpreter-on-agent-py.md)) | Wave 4 merged |
| 5b (Phase 3) | **A** background runs (Q41 resume + 0043 mutual exclusion, start parity, research mode Q46, the Q49 refusal, skills / reasoning effort in the executor, Q48, Run progress fields, early pending question) · **B** context on runs (file budget + notes with ids Q47, MCP resources, bookmarks as taint, cloud files by id Q44) · **C** memory, citation checks, reference image, `localFilesOnly`, per-IP limits, `auto` · **D** local MCP (Q42/Q45), `MCP_ALLOW_PRIVATE_HOSTS`, MCP Apps | 5a |
| 6 (Phase 3) | the tasks panel onto runs (Q38) | Wave 5's background-runs work merged |

Each wave merges into one integration branch and ships as one PR
against `dev`.

**Wave 5b hooks (left by 5a).** Contract 0.4.0's run options are parsed
into `RunOptions` (`services/agent-py/src/agent_py/runs/options.py`);
local MCP credentials arrive in `RunInput.local_mcp_credentials`
(`runs/credentials.py`). Each workstream plugs into the native harness
by adding entries to `runs/harness_hooks.py` (its docstring has the
table): **B** a prompt section + taint seed in `runs/context.py`; **C**
prompt sections (memory, remix) and a tool contributor (remember /
forget), the `resolve_model` hook (`auto`), the `post_success` hook
(citations, over `verify_client.py`), and the per-IP budgets through
`NativeHarness(consume_budget=…)` → `RunToolContext.consume_budget`;
**D** a tool contributor for local MCP and `ToolInvocationResult.mcp_app`
for MCP Apps; **A** the background executor (`run_input.background_checkpoint`
already carries `allowedMcpServerIds` and `reasoningEffort`). The exact
spots are marked `TODO(5b-A|B|C|D)`; the client side passes the new
fields through `lib/client/runs/build-input.ts` on send and resume.

## Revisit later

- **Supabase** as the platform (Q3).
- **Same origin** vs a separate API origin (Q21).
- **A2A** at the backend edge (Q14).
- **The backend switch** is per browser (Q33); make it a synced account setting.
- **MCP 2026-07-28** dropped sessions and SSE resumability — check
  `lib/server/mcp/` and agent-py's MCP client against it.

## Sources (protocol research, 2026-11-21)

- AG-UI 1.0: <https://docs.ag-ui.com/introduction>,
  run input <https://docs.ag-ui.com/spec/draft/basic/run-input>,
  HTTP/SSE transport <https://docs.ag-ui.com/spec/draft/basic/transports/http-sse.md>,
  interrupts <https://docs.ag-ui.com/concepts/interrupts>
- LangChain Agent Protocol: <https://github.com/langchain-ai/agent-protocol>;
  Agent Server join-stream <https://docs.langchain.com/langsmith/agent-server-api/thread-runs/join-run-stream.md>
- A2A 1.0: <https://a2a-protocol.org/latest/specification/>
- OpenAI background mode: <https://developers.openai.com/api/docs/guides/background>
- Claude Managed Agents events: <https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
- deepagents AG-UI: <https://docs.langchain.com/oss/python/deepagents/ag-ui>
- Claude Agent SDK streaming: <https://code.claude.com/docs/en/agent-sdk/streaming-output>
