# Plan: Agent API as a separate service (language-agnostic)

Status: **planning** — no code yet, **tech stack undecided**. This is
an architecture/decision doc. It defines *what* the agent backend must
do and *where the service boundary sits*, deliberately without picking
a language — the implementation could be a separate **TypeScript**
service (Hono / Nitro / Express) or **Python** (FastAPI), and the
contract is identical either way.

Companion to two existing infra plans:
- `PLAN-backend-extraction.md` — the **contract-first groundwork**
  (Phase 1 shipped: `apiClient` + Zod schemas + `docs/API.md`). That
  plan framed the move as "Python-ready"; this plan generalises it —
  the language is now an open decision, and "separate TS service" is a
  first-class option.
- `PLAN-replace-supabase-with-postgres.md` — the **data layer**. Orthogonal:
  the agent service talks to whatever the data layer is; swapping
  Supabase↔Postgres doesn't change the agent contract.

## Why split the agent backend out at all

Today inference + tool-calling live in Next.js route handlers
(`app/api/chat`, `app/api/ai/*`, `app/api/mcp/*`, …). That's fine for a
turn-based chat. Three forces push toward a separate service:

1. **Runtime mismatch.** Agent loops are long-lived and bursty;
   Next.js on serverless caps execution (Vercel: 60s Hobby / 300s
   Pro). A dedicated long-running process (container, not function)
   removes that ceiling.
2. **Independent scaling + deploy cadence.** The agent loop's resource
   profile (long CPU-idle waits on model + tool I/O) is nothing like
   the frontend's. Separate service = scale and ship them apart.
3. **Language optionality.** Once it's a service behind a stable
   contract, the language is a private implementation detail. The team
   can pick TS (share types/Zod with the frontend, zero context-switch)
   or Python (richer ML/agent ecosystem) on the merits — not be forced
   by colocation.

**This plan does not argue for the split itself** — `PLAN-backend-
extraction.md` already says "hold until you have something to point
at." It defines the **target shape** so that when the split happens,
it's a deployment change, not a redesign.

## The service boundary

What moves into the Agent service vs stays in the Next.js app:

| Stays in Next.js / browser | Moves to the Agent service |
|---|---|
| All React + Zustand + IndexedDB | Model inference (streaming) |
| Browser → data-layer sync (direct) | The agent loop (multi-step tool calling) |
| Supabase/Postgres auth UI + callback | Tool execution: webSearch, webFetch, imageGen, searchFiles |
| The two `/share/*` SSR pages (can become thin proxies) | MCP client (discovery + invocation + cloud-cred decryption) |
| `apiClient` (the typed fetch wrapper) | File extraction (pdf/docx/csv/xlsx/html) |
| | Summarise / compress |
| | Durable run state (for long-running tasks) |

The seam is **`lib/client/api-client.ts`** — every backend call already
funnels through it (Phase 1 of backend-extraction). Flipping
`NEXT_PUBLIC_API_BASE_URL` repoints the whole app at the new service.

## Part A — Parity baseline (must reproduce or the frontend breaks)

The frontend already depends on these. The contract is pinned in
`docs/API.md` + `lib/shared/api-schemas.ts` and must survive verbatim:

1. **SSE streaming protocol** — frames `text` / `reasoning` /
   `tool_call` / `tool_result` / `suggestions` / `error` / `done`,
   with the current ordering, abort, and idle-timeout semantics
   (the chat route has a 90s idle watchdog + client-disconnect cancel).
2. **Provider routing** — the `config/models.json` + `config/providers.json`
   model (gateway / anthropic-compatible / openai-compatible). The
   service reads the same config files or an equivalent. Keeping them
   as the shared source of truth avoids drift.
3. **The four server-side tools** — webSearch (Tavily / Brave / Exa),
   webFetch, imageGen (Minimax T2I/I2I), searchFiles (FTS retrieval).
   Each is a tool the agent loop can invoke; each has a "configured?"
   gate keyed on env.
4. **MCP** — server registry, tool discovery, invocation, and the
   cloud-mode credential decryption (`MCP_ENCRYPTION_KEY` + the
   SECURITY DEFINER decrypt RPC). The fiddliest surface to port.
5. **Editor AI** — `/api/ai/command` + `/api/ai/copilot`. Very
   Plate-flavored payloads; candidates to **leave in Next.js** even
   after the rest moves (flagged as a decision below).
6. **Extraction, summarize/compress, auth (JWT verify), per-IP rate
   limits.**

If the service is TS, items 1–6 are largely a *move* (the AI SDK, the
skill registry, the MCP client already exist). If Python, they're a
*reimplementation* against the same contract.

## Part B — What makes it an *Agent* API (beyond today)

The capabilities that turn "chat backend" into "agent substrate":

1. **First-class agent loop.** Multi-step tool-calling with a
   configurable step budget, explicit stop conditions, and interleaved
   reasoning/tool/text streaming. Today the chat route does a basic
   `stepCountIs(N)`; the agent surface needs this tunable and
   inspectable.
2. **Tool registry / dispatch.** The portable equivalent of the
   `ServerSkill` interface (`lib/server/skills/registry.ts`): register
   a tool once, the loop discovers it. Whatever the language, keep this
   shape so adding a tool stays one registration.
3. **Durable run state.** The defining feature. A run persists each
   step (the `tasks` + `task_events` tables from
   `PLAN-long-running-tasks.md`) so it survives client disconnect /
   reload / a function recycle. This is what separates an agent service
   from a streaming chat endpoint.
4. **Cancellation + resumability.** Cancel mid-step; resume from the
   last checkpoint. Idempotent step replay (a half-finished step on
   resume must not double-emit events or double-call a tool).
5. **Budgets + guardrails.** Per-user / per-day cost caps (agentic
   loops burn 10–50× a normal turn) and a hard step ceiling. Both are
   thin today; they become load-bearing the moment loops run
   unattended.
6. **Observability.** Structured logging of tool calls, token usage,
   latency, and cost per run. Needed to debug and to enforce the
   budgets above.

Parity (Part A) is ~80% of the *porting effort*; the agent capabilities
(Part B) are ~80% of the *value*. A team could even prototype Part B
(esp. durable run state) in the **current** TS backend first to
de-risk the agent design before committing to any service split or
language change.

## API contract & interfaces

Two layers: the **external HTTP surface** the service exposes (what
the frontend and any other client calls), and the **internal
interfaces** the service implements behind that surface. The external
wire format is already pinned in [`docs/API.md`](API.md) +
`lib/shared/api-schemas.ts` — treat that as normative and don't
re-spec it here; this section adds what a *standalone* service needs
that a colocated one doesn't, plus the internal abstractions.

### External HTTP surface

Endpoints the agent service owns (paths unchanged so `apiClient` only
needs the base-URL flip):

| Endpoint | Method | Shape | Notes |
|---|---|---|---|
| `/api/chat` | POST | SSE stream (custom frame protocol) | The core agent turn. Frame types in `docs/API.md`. |
| `/api/ai/command` | POST | AI SDK UI message stream | Plate editor. Different stream format. |
| `/api/ai/copilot` | POST | AI SDK completion stream | Plate editor. |
| `/api/extract` | POST | `multipart/form-data` → `ExtractionResponse` | File text extraction. |
| `/api/summarize` | POST | JSON → `{summary,…}` | Summary / compress modes. |
| `/api/mcp/server` · `/api/mcp/:id/:action` | POST | JSON | MCP discovery + invocation. |
| `/api/url/fetch` | POST | JSON | webFetch backing route. |

`/api/share/*` is **not** an agent endpoint — it's a data-layer
concern (mints/revokes tokens against the DB) and stays with whatever
owns auth + Postgres. Listed in `docs/API.md` for completeness only.

**What a standalone service adds (not needed while colocated):**

- **Auth** — colocated routes read the Supabase session cookie. A
  separate service should accept `Authorization: Bearer <JWT>` and
  verify it (Supabase JWT secret, or the data layer's equivalent).
  Pick bearer-vs-cookie once; it interacts with the deploy-shape
  decision and `PLAN-replace-supabase-with-postgres.md`'s auth choice.
- **Health/readiness** — `GET /healthz` (process up) and `GET /readyz`
  (deps reachable: model gateway, DB, MCP). Needed for container
  orchestration; the Next.js app never needed these.
- **Versioning** — pin the contract under `/v1` (or an
  `Accept-Version` header) so the service and frontend can deploy on
  independent cadences without a breaking-change footgun.
- **CORS** — only if deployed on a separate subdomain rather than a
  same-origin rewrite. Same-origin avoids it entirely (recommended).
- **Request correlation** — accept/emit an `X-Request-Id` and thread
  it through logs + the run-state events for cross-service tracing.

### Streaming contract

Two formats exist today and both must be served (or unified):

1. **Custom SSE frame protocol** for `/api/chat` — `text` /
   `reasoning` / `tool_call` / `tool_result` / `suggestions` /
   `error` / `done`, with ordering + abort rules in `docs/API.md`.
2. **AI SDK UI message / completion stream** for the two editor
   routes — parsed by Plate's `useChat` / `useCompletion`.

A rewrite is the cheap moment to **unify on the AI SDK stream
format** (decision below); it natively carries tool-call/step/
reasoning semantics and would let the chat panel adopt
`@ai-sdk/react`'s `useChat()`. Until then, the contract is "serve
both, byte-for-byte."

### Internal interfaces the service implements

Language-agnostic signatures (TS-flavored pseudocode; a Python
service mirrors them as protocols/ABCs). These already exist as
concrete TS in the current backend — the table notes where, so a TS
service reuses them and a Python service has a reference impl.

```ts
// 1. Provider resolution — modelId → a callable model.
//    Backed by config/models.json + config/providers.json.
interface ProviderResolver {
  selectModel(modelId: string, opts?: { apiKeyOverride?: string }): LanguageModel
  isProviderConfigured(name: string): boolean
}
// current impl: lib/server/model-provider.ts + lib/server/providers-config.ts

// 2. Tool / skill — one registration, the agent loop discovers it.
interface ServerSkill {
  id: SkillId
  toolName: string
  buildTool(requestEntry: SkillRequestEntry | undefined, ctx: SkillRuntimeContext): Tool | null
  promptFragment(requestEntry: SkillRequestEntry | undefined): string | null
}
// current impl: lib/server/skills/registry.ts (SERVER_SKILLS)

// 3. Agent loop — the multi-step driver. Streams frames; respects
//    a step budget + cancellation; persists each step via RunStore.
interface AgentLoop {
  run(input: {
    messages: ModelMessage[]
    modelId: string
    skills: SkillRequestEntry[]
    mcpServers?: McpServerRef[]
    maxSteps: number
    signal: AbortSignal
    runId?: string            // when durable (long-running tasks)
  }): AsyncIterable<ChatFrame>  // the SSE frames above
}
// partial impl today: the streamText loop in app/api/chat/route.ts

// 4. Durable run state — the defining agent-service capability.
interface RunStore {
  createRun(input: { userId: string; goal: string; maxSteps: number }): Promise<Run>
  appendEvent(runId: string, event: RunEvent): Promise<void>  // idempotent by (runId, step, kind)
  getRun(runId: string): Promise<Run | null>
  listEvents(runId: string, sinceStep?: number): Promise<RunEvent[]>  // resume replay
  cancel(runId: string): Promise<void>
  isCancelled(runId: string): Promise<boolean>
}
// new — schema = tasks + task_events from PLAN-long-running-tasks.md

// 5. MCP client — discovery, invocation, cloud-cred decryption.
interface McpClient {
  listTools(server: McpServerRef): Promise<McpTool[]>
  callTool(server: McpServerRef, name: string, args: unknown): Promise<McpToolResult>
  readResource(server: McpServerRef, uri: string): Promise<McpResource>
  resolveCredential(server: McpServerRef): Promise<McpCredential>  // local OR decrypt cloud
}
// current impl: lib/server/mcp/* (the cloud path uses MCP_ENCRYPTION_KEY)

// 6. Extraction, auth, rate limiting — boundary services.
interface Extractor { extract(file: Blob, name: string): Promise<ExtractionResult> }
interface AuthVerifier { verify(token: string): Promise<{ userId: string } | null> }
interface RateLimiter { consume(key: string): { allowed: boolean; retryAfterSec: number } }
// current impls: lib/server/extract* · (cookie session today) · lib/server/rate-limit.ts
```

### Data dependencies

The service reads/writes a small slice of the data layer directly
(not via the browser sync path):

- **Reads** `messages` (history reconstruction; `files.full_text` for
  the `searchFiles` tool), MCP server rows + encrypted creds.
- **Writes** `tasks` / `task_events` (run state), generated-image
  Storage objects (imageGen).
- **Scoping** — every read/write is `user_id`-scoped. With Supabase
  that's RLS; on plain Postgres the service enforces it in-query (see
  the Option B caveat in `PLAN-replace-supabase-with-postgres.md` and
  `PLAN-local-rag.md`). This is the single highest-risk surface for a
  cross-user leak when RLS isn't doing it for free.

### Contract sync between frontend and service

- **TS service** — import `lib/shared/api-schemas.ts` + `lib/shared/*`
  types directly. One source of truth, zero drift. Strongly favoured.
- **Polyglot (Python)** — generate from a shared OpenAPI doc on both
  sides, or round-trip a fixture set through both implementations in
  CI. Drift is the dominant risk; budget for the codegen pipeline.

## Decisions to make before building

1. **Language.** TS-as-separate-service (share `lib/shared/` types +
   Zod with the frontend, reuse the AI SDK / skill registry / MCP
   client almost verbatim — lowest porting cost) **vs** Python
   (FastAPI + the richer agent/ML ecosystem — higher porting cost,
   more agent tooling). Open. The rest of this plan is identical either
   way.
2. **Streaming format.** Keep the custom SSE frame protocol, or adopt
   the **AI SDK UI message stream** format. The AI SDK format carries
   tool-call / step / reasoning semantics natively and unlocks
   `@ai-sdk/react`'s `useChat()` on the frontend — attractive for an
   agent surface specifically. A rewrite is the cheap moment to switch.
3. **Run-state store.** Postgres tables (`tasks` / `task_events`) are
   the default. Whether a real queue (pg-boss / Inngest / Temporal)
   sits on top is a scaling decision deferrable to when concurrent
   runs per user are real.
4. **Editor AI routes.** Port them, or keep `command` / `copilot` in
   Next.js (they're Plate-coupled and rarely the bottleneck).
5. **MCP cred path.** Port the decrypt RPC + key handling, or keep MCP
   in Next.js and have the agent service call back for tool execution.
6. **Deployment shape.** Same-origin reverse proxy (no CORS / cookie
   pain — recommended) vs subdomain (needs CORS + cookie-domain config).
7. **Contract sync.** If TS: import `lib/shared/` directly (one source
   of truth, no drift). If Python: shared OpenAPI doc with codegen on
   both sides, or fixture round-trip tests in CI.

## Phasing

This plan is target-shape only; sequencing folds into the two
companion plans:

- **Step 0 (done):** `backend-extraction` Phase 1 — `apiClient` +
  schemas + `docs/API.md`. The seam exists.
- **Step 1:** Build durable run state + the agent loop **in the
  current TS backend** (this is `PLAN-long-running-tasks.md`). Proves
  the agent design with zero service/language risk.
- **Step 2:** Pick the language + streaming format (decisions above).
- **Step 3:** Stand up the separate service serving the same paths;
  flip `NEXT_PUBLIC_API_BASE_URL` (or a same-origin rewrite).
  Decommission the in-Next.js routes once parity is proven.
- **Step 4 (optional):** Split into its own repo once it has its own
  release cadence.

## Risks

- **Contract drift across the boundary** — worst with a polyglot
  (TS frontend / Python backend) split; near-zero with a TS service
  that imports `lib/shared/`. Weigh this heavily in the language
  decision.
- **Streaming through proxies** — same-origin rewrites must not buffer
  SSE; needs chunked transfer + heartbeats. Verify on the actual
  deploy target.
- **Auth model** — Supabase JS sets cookies; a separate service likely
  wants JWT-in-`Authorization`. Pick one early (interacts with
  `PLAN-replace-supabase-with-postgres.md`'s auth choice).
- **"Two services to run locally"** — dev workflow gets a second
  process. Document in `CLAUDE.md`; a Compose file or `concurrently`
  script when it lands.
- **Speculative infra** — building the service before the agent design
  is proven ages badly. Hence Step 1 (prove the loop in-place) before
  Step 3 (split it out).

## Recommendation

1. **Don't split yet.** Prove the agent loop + durable run state in the
   current TS backend (Step 1 = long-running-tasks). That's where the
   value and the design risk live, and it's language-neutral.
2. **When you do split, default to a TS service** unless a concrete
   Python-only dependency shows up. Sharing `lib/shared/` types + Zod
   + the existing AI SDK / skill / MCP code makes the split a *move*,
   not a *reimplementation* — the contract-drift risk that dominates a
   polyglot split simply doesn't exist.
3. **Adopt the AI SDK UI message stream format at the split** if you
   want `useChat()` on the frontend; otherwise keep the custom SSE
   protocol (already documented, already works).

The single highest-leverage next step is **Step 1**, which needs no
decision on language or service boundary at all.
