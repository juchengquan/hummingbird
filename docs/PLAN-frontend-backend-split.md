# Plan: Frontend / backend split

Status: **Waves 1–2 (Phases 0–1) shipped (#294, #295). Wave 3a (Phase 2 foundation) in progress.** Decided in a design interview
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
| Q17 | Every event is kept while a run is live; on finish the log is compacted to messages, tool calls/results, interrupts and the result (deltas dropped after ~24 h); background runs keep their compacted log as long as the task exists |
| Q18 | Frontend uses `@ag-ui/client` wrapped in our own hook feeding the Zustand message store — not CopilotKit, not `useChat` + a converter |
| Q20 | Anonymous runs are addressed with a per-run secret token (`runToken`); the backend enforces anonymous per-IP rate/budget limits (today's `REQUIRE_AUTH_FOR_AI` moves there) |
| Q24 | Answering an interrupt starts a **new run on the same thread** with `resume[]` (AG-UI semantics). A background "task" is a thread of runs |
| Q27 | Runs reuse the existing `tasks` / `task_events` / `task_jobs` tables during the migration: a run is a `tasks` row (with `mode`), the thread is the conversation. The old task routes and the runs API read the same rows, so nothing is copied or written twice. Old surfaces only see `mode = 'background'`. **Phase 5 renames and reshapes** them into the long-run model (below) |
| Q28 | Interactive runs execute in the API process that received `POST /v1/runs`, streaming to the caller while writing every event to the log; background runs go through `task_jobs` + the poller. If the process dies mid-turn the run is failed (reaper), not handed to another worker |
| Q29 | Rejoin reads the event log: readers in the run's own process get events in memory; readers elsewhere poll the log (~250 ms). Postgres LISTEN/NOTIFY only if polling becomes a problem |
| Q30 | The run event log is a **replay buffer, not the transcript**: text deltas are stored coalesced (flushed every ~100–250 ms), compacted on finish (Q17), and deleted after a retention window while the run row stays. `messages` remains the durable record of a conversation. Partition `run_events` by time only once volume calls for it |
| Q31 | **Harness state stays outside the contract.** A harness's own persistence (LangGraph checkpointers, Claude Agent SDK sessions) is stored opaquely, keyed by run/thread — in `checkpoint` jsonb or harness-owned tables in their own schema — and never shapes `runs` or the API, so swapping harnesses touches neither the contract nor the frontend |

## Run contract (v1)

Copies published designs: events and start input from **AG-UI 1.0**,
the run resource and replay model from the **LangChain Agent Protocol**,
the replay cursor from **OpenAI Responses background mode**. Our own
additions are marked ✚.

| Operation | Shape |
|---|---|
| Start | `POST /v1/runs` — body is AG-UI `RunAgentInput` (`threadId`, `runId`, `messages`, `tools`, `context`, `state`, `resume`, `forwardedProps`) ✚ plus `mode: interactive \| background`. Interactive → `200` + SSE stream; background → `202 { runId, status }`. **The client mints `runId`** (AG-UI rule); a repeated `runId` is an idempotent retry, not a new run. Anonymous runs also return `runToken` |
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
3. **Frontend switches** — `@ag-ui/client` hook for chat behind the
   per-account switch; then the tasks panel onto threads/runs.
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

Each wave merges into one integration branch and ships as one PR
against `dev`.

## Revisit later

- **Supabase** as the platform (Q3).
- **Same origin** vs a separate API origin (Q21).
- **A2A** at the backend edge (Q14).
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
