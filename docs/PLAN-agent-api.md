# Plan: Agent API as a separate service

Status: **🪜 Phased — Phases 0 through 4-4b shipped. Phases 5
(default-on + decommission) and 6 (tidy + archive) explicitly
deferred — both Python and TS stacks stay live; the user picks
backend via the Phase 4-2 selector.**

Companion plans:
- [`PLAN-agent-ts.md`](./PLAN-agent-ts.md) — phased plan for a TS
  twin of `services/agent-py/` (`services/agent-ts/`). Same
  architecture, same selector mechanism, different runtime.

## Shipped

Option C (Python service) green-lit, end-to-end live in
`services/agent-py/`:

| Phase | Slice | What landed |
|---|---|---|
| 0 | Scaffolding | FastAPI + JWT auth + OpenAPI codegen |
| 1 | Read-only poller | `task_jobs` claim/release loop in dry-run |
| 2a | Executor pattern | TaskEvent IR, RunEmitter, RunStore, runner, per-user feature flag |
| 2b-1 | Anthropic streaming | Real `messages.stream` + `ANTHROPIC_BASE_URL` override |
| 2b-2 | Tool wiring | Tool descriptor + registry + `webFetch` |
| 3a | `continue` action | Chunk-break yield + resume |
| 3b | `respond` action | HITL suspend → approve / reject → resume |
| 3c-1 | `webSearch` | Tavily backend, env-gated |
| 3c-2 | `searchFiles` | FTS over user files under RLS impersonation |
| 3d-1 | `generateImage` | Minimax T2I/I2I client + tool |
| 3d-2 | Image persistence | Supabase Storage upload + signed URL |
| 3e | File extraction | PDF/DOCX/XLSX/HTML/code/text + `POST /v1/extract` |
| 3f-1 | MCP client | Streamable-HTTP wrapper + cloud-cred decryption |
| 3f-2 | MCP tools | Cloud-mode MCP discovered + registered as `mcp__<server>__<tool>` |
| 3g | AI SDK format | `?format=ai-sdk` on `/v1/chat` emits v5 UI message stream |
| 4-1 | Python `/v1/chat` | SSE text streaming, JWT-protected |
| 4-2 | Frontend selector | Account-menu toggle, `NEXT_PUBLIC_AGENT_PY_URL` gate |
| 4-3 | Chat tools | `enable_tools` + tool-call/result frames in both formats |
| 4-4a | URL + image refresh | `POST /v1/url/fetch`, `POST /v1/images/refresh-url` |
| 4-4b | Summarize + MCP proxy | `POST /v1/summarize`, `POST /v1/mcp/{server}/{action}` |

## Explicitly deferred

- **Phase 5 — Default-on + decommission** (originally "Python
  canonical for all users; TS worker + agent routes deleted").
  Per the project's standing policy **both stacks stay live and
  the user selects backend per-account**, so the cutover lever
  isn't pulled. Stays in §Phase 5 below as a written option, not
  a roadmap item.
- **Phase 6 — Tidy + archive**. Premature while both stacks are
  live. When (if) Phase 5 ever flips, Phase 6 follows.

## Open follow-ups (smaller refinements documented in PR threads)

- `POST /v1/mcp/server` CRUD endpoint + `mcp_upsert_server_with_credentials`
  write path.
- Per-IP rate buckets + idle watchdog on `/v1/chat`.
- Real DNS-rebinding test against actual DNS (currently mocked).

### Shipped

- **Frontend `useChat()` adoption** — `lib/client/hooks/use-chat-send.ts`
  translates AI SDK v5 frames into the consumer's internal envelope;
  every backend (Next.js inline route, agent-py, agent-ts) emits AI
  SDK v5 natively. See `PLAN-useChat-adoption.md`.
- **`workspaceId` field on `POST /v1/chat`** — agent-py threads
  `workspace_id` into `ToolContext`, unlocking `searchFiles` + cloud-
  mode MCP for chat tools. agent-ts accepts the field but doesn't
  use it (no cloud-MCP wiring on that side, and `searchFiles` is
  per-user RLS only).
- **Per-skill config** (`webSearchConfig`, `webFetchConfig`,
  `imageGenConfig`) honoured by `/v1/chat`. Both agent-py
  (`_collect_skill_configs` → `SkillConfigs`) and agent-ts
  (`buildToolSet({skills})`) reduce the request's per-skill list
  into the tool factories the same way the Next.js inline route does.
- **Provider-categorised errors** (`rate_limit`, `auth`,
  `context_window`, `upstream`) on `/v1/chat`. Both agent-py and
  agent-ts emit a `code` field on AI SDK v5 `error` frames; the
  consumer translates it into the typed `MessageError.code` so
  `ErrorBubble` can pick its surface (cooldown for rate_limit,
  hide Retry for auth, suggest a larger-context fallback for
  context_window). The shared `categorizeError` in
  `lib/shared/api-errors.ts` was extended with `context_window`
  for parity on the Next.js inline route. See
  `categorize_provider_error` / `categorizeProviderError`.
- **Frontend selector for non-chat endpoints** — the four endpoints
  that mirror to agent-py / agent-ts (`/v1/url/fetch`,
  `/v1/summarize`, `/v1/mcp/{server}/{action}`,
  `/v1/images/refresh-url`) now honour the chat-backend store
  selector via the resolver in `lib/client/api/backend-resolver.ts`.
  Default `dispatch: 'auto'` reads the store + Supabase JWT lazily;
  callers can opt out with `dispatch: 'in-next'` or pin a context
  via `dispatch: 'remote'`. Refresh-url converts `storagePath` →
  `storage_path` on the remote path (the in-Next route keeps
  camelCase).

> **Note on phase numbering.** The original plan called Phase 2 a
> single 1-week slice (executor + 3 tools + provider port). It split
> in flight into a structural Phase 2a (executor pattern with a stub
> step fn), and a Phase 2b that lands the real model call + tools.
> Phase 2b then split again into 2b-1 (real model streaming, no
> tools) and 2b-2 (the tool registry + first three tools +
> tool-related event kinds). The PRs landed in that order so each
> was reviewable independently. Total effort is unchanged.

> **Prior status (kept for context).** The plan's precondition — "prove
> the agent loop + durable run state in the current TS backend first"
> — shipped via the long-running-task / HITL / queue stack
> (`_done/PLAN-agent-event-model.md`, `_done/PLAN-agent-hitl-approvals.md`,
> `_done/PLAN-agent-task-queue.md`). The whole agent substrate works
> in-process today. So this plan is no longer about *whether* the
> design is sound — it's about *whether and how* to move it out of
> Next.js.

Companion plans:
- `PLAN-backend-extraction.md` — contract-first groundwork. **Phase 1
  shipped** (apiClient + Zod schemas + `docs/API.md`). That plan
  framed the move as Python-specific; this plan generalises it and
  treats the language as one decision among others.
- `PLAN-replace-supabase-with-postgres.md` — data layer. Orthogonal to
  the agent split — the agent service talks to whatever the data
  layer is.

---

## What we're solving for

Four forces, any one of which is enough to motivate a split:

| Force | What it looks like in practice |
|---|---|
| **A. Python ecosystem** | DSPy, LangGraph, vLLM, custom retrievers, evaluation libraries — the active agent-research surface is overwhelmingly Python-first. Staying in TS means living without it. |
| **B. Independent deploy / scale** | The agent worker is long-running, bursty, idle-on-I/O. The chat UI is short, latency-sensitive, edge-friendly. Right now a frontend deploy restarts the worker; a worker crash shows up as a Next.js error budget. Splitting decouples both. |
| **C. Reduce Vercel / Next coupling** | 60s Hobby / 300s Pro execution caps (worked around via chunking + queue, but the workaround leaks into the code). Cold starts on the agent path. Edge-vs-Node confusion. Vendor lock-in on cron + KV. A long-running container removes all of these at once. |
| **D. Exploration** | You want concrete options to evaluate. No specific pain forces it; the writeup is meant to **make the trade-offs legible** so the eventual go-ahead is informed, not impulsive. |

This plan is structured so any combination of those forces lands on the
same first move.

---

## The 4 options on the table

| Option | What it is | Repo shape | Deploy shape | Languages |
|---|---|---|---|---|
| **A. Stay in-process** | Add isolation inside Next.js (worker threads, child processes, or just better separation). Keep the queue + chunking that already work. | Monorepo, single deploy | Vercel | TS only |
| **B. TS service** | Hono / Nitro / Express in `services/agent-ts/`. Same repo, separate deploy. Imports `lib/shared/` directly — zero contract drift. | Monorepo, two deploys | Vercel (frontend) + container (agent) | TS only |
| **C. Python service** | FastAPI in `services/agent-py/`. Separate deploy + container. Pydantic models mirror Zod via OpenAPI codegen. | Monorepo, two deploys | Vercel (frontend) + container (agent) | TS + Python (polyglot) |
| **D. Hybrid** | Chat turn (`/api/chat`) stays in Next.js as today; only the long-running task worker moves out. Agent loop runs in the new service; the chat panel still calls Next, which proxies to the agent service or runs the turn inline. | Monorepo, two deploys | Vercel (frontend + chat) + container (agent worker) | TS + (TS or Python for the worker) |

### Decision matrix — how each option scores against the four drivers

`+` = clearly addresses, `~` = partial, `–` = does not address, `+!` = uniquely well-suited.

| | A. Stay in-process | B. TS service | C. Python service | D. Hybrid |
|---|---|---|---|---|
| Python ecosystem (A) | – | – | **+!** | + (if worker is Py) |
| Independent deploy / scale (B) | – | + | + | + |
| Reduce Vercel coupling (C) | ~ | + | + | + |
| Time-to-first-value | **+!** (already done) | + (~2-3 wk) | ~ (4-6 wk) | + (~3 wk) |
| Operational complexity | **+!** | ~ (2 services) | – (2 services + 2 languages) | ~ |
| Contract drift risk | **+!** (no boundary) | **+!** (shared types) | – (OpenAPI codegen needed) | depends on worker lang |
| Reversibility | **+!** | + | ~ | + |
| Cost (hosting only) | $0 | host-dependent (self-host: $0; managed PaaS: typically $5-15/mo) | host-dependent (same as B) | host-dependent (same as B) |
| Future Python ML deps | – | – | **+!** | + (if Py) |

**Where each option wins:**

- **A wins on:** doing nothing. If you don't actually want any of A/B/C, this is the right answer.
- **B wins on:** lowest porting cost + zero contract-drift risk + fast time-to-first-value if you want the operational benefits but not Python.
- **C wins on:** Python ecosystem access. Pays for everything else with extra work — both up-front (port the runner, runner.ts is ~370 LOC of real logic; MCP client, ~500 LOC; tool registry, ~400 LOC) and ongoing (two languages to maintain, contract codegen).
- **D wins on:** keeping the cheap turn-based path simple (it's not the source of the pain) while moving only the part that actually wants a container. Half the porting work. Half the operational complexity.

---

## Recommendation

**Option C (Python service)** if you confirm driver A (Python ecosystem)
is a real ongoing pull, not a one-off curiosity. Otherwise **Option D
(hybrid) with a TS worker.**

The reasoning, given the prompt was "all four drivers":

1. **Driver A (Python ecosystem) is the discriminator.** B/C/D all
   solve drivers B/C/D equivalently well. Only C (and D-with-Python)
   solve A. If A isn't real, you're paying polyglot costs for nothing.
2. **D (hybrid) is the under-rated middle.** Chat turns are 90% of the
   call volume and 10% of the value of splitting. The worker is 10% of
   the call volume and 100% of the value (long-running, scales
   differently, hits the 60s cap). Splitting only the worker captures
   most of the win for half the work.
3. **A (stay in-process) is the honest default for the next 30 days.**
   You have a working agent stack, no users complaining about scale,
   no Python dep you're avoiding. The cost of waiting another month is
   close to zero; the cost of building the wrong thing is 4-6 weeks.

If you say "yes, I want Python and I want it deployed separately and I
want to start now," the rest of this plan walks you through Option C
end-to-end. **If you instead say "let me try Option D first," see
[§What changes for the other options](#what-changes-for-the-other-options)
at the bottom.**

---

## The service boundary (target shape for Option C)

What moves into the Python service vs stays in the Next.js app:

| Stays in Next.js / browser | Moves to the Agent service |
|---|---|
| All React + Zustand + IndexedDB | Model inference (streaming) |
| Browser → data-layer sync (direct) | The agent loop (`runAgentLoop` + `makeStreamTextStep`) |
| Supabase auth UI + callback | Tool execution: webSearch, webFetch, imageGen, searchFiles |
| `/api/share/*` (data-layer concern) | MCP client (discovery + invocation + cloud-cred decryption) |
| `apiClient` (the typed fetch wrapper) | File extraction (pdf/docx/csv/xlsx/html) |
| `/api/auth/callback` (Supabase) | Summarise / compress |
| `/api/ai/*` editor routes (**deferred** — see §6 below) | Durable run state writes (`tasks` / `task_events` / `task_checkpoint`) |
| `/api/tasks` POST as a thin enqueuer | Worker (`processNextJob` loop) |

The seam is **`lib/client/api-client.ts`**. Every backend call already
funnels through it. Flipping `NEXT_PUBLIC_API_BASE_URL` repoints the
whole app at the new service.

The data layer (Supabase Postgres + Storage + Realtime) is **shared**:
both the Next.js app and the Python service connect to the same
project. RLS is the enforcer.

---

## Wire contracts (pinned)

### HTTP — already specified

The external surface is documented in [`docs/API.md`](API.md) +
`lib/shared/api-schemas.ts`. The Python service serves these paths
byte-for-byte. The contract is normative; no respec here. New
deployment-specific additions:

| Concern | Decision |
|---|---|
| Auth | `Authorization: Bearer <jwt>` — verify with Supabase JWT secret. (Cookie auth stays for the Next.js routes that remain.) |
| Health | `GET /healthz` (process up) + `GET /readyz` (deps reachable). For container orchestration. |
| Versioning | `/v1/...` prefix. Frontend pins to v1; service can ship v2 independently. |
| CORS | None — same-origin via Vercel rewrite. (Subdomain option deferred.) |
| Correlation | Accept + emit `X-Request-Id`; thread through structured logs + `task_events.metadata`. |

### Streaming — adopt the AI SDK UI message stream format

A rewrite is the cheap moment to switch off the custom SSE protocol
and adopt the AI SDK UI message stream. The Python service emits the
official format; the chat panel adopts `@ai-sdk/react`'s `useChat()`
on the same flag flip. The benefits:

- One streaming protocol across `/api/chat` and the editor routes.
- Native tool-call / step / reasoning frames.
- Battle-tested clients.

The downside is **the chat panel changes** — the custom SSE consumer
in `lib/client/agent/stream.ts` becomes redundant; the gallery,
tool-call rendering, and abort flow all touch `useChat()` instead. PR
sized at ~1-2 days, deferred to Phase 3.

### Data dependencies

The Python service reads / writes a small Postgres slice directly via
`supabase-py` (or `asyncpg`):

| Operation | Tables | Notes |
|---|---|---|
| Reads message history | `messages` | For run reconstruction. |
| Reads MCP creds | `mcp_servers` | Plus the SECURITY DEFINER decrypt RPC. |
| Reads files | `files`, `file_sections`, Storage | For `searchFiles` skill. |
| Writes run state | `tasks`, `task_events`, `task_checkpoint`, `task_jobs` | Idempotent on `(task_id, seq)`. |
| Writes generated images | Storage bucket `user-files/{userId}/generated/...` | Mints signed URLs same TTL as today. |

**RLS is load-bearing.** Every connection scopes to the caller's
`user_id` via a Supabase session, NOT via a service-role bypass except
for the worker dispatch path (mirrors today's `getSupabaseAdminClient`
in `lib/server/agent/worker.ts`).

### Contract sync (Zod ↔ Pydantic)

The hard part of polyglot. Three approaches; pick one in Phase 0:

| Approach | Pros | Cons |
|---|---|---|
| **OpenAPI emit from FastAPI + codegen to TS** | Single source of truth on the Python side. CI catches drift on PR. | TS types may be uglier than hand-written Zod. |
| **OpenAPI emit from Zod + codegen to Pydantic** | Frontend stays the source. | Less mature tooling (zod-to-openapi works; pydantic generation is awkward). |
| **Fixture round-trip in CI** | Simple. No codegen pipeline. | Catches behaviour drift but not type drift. The two implementations can diverge silently if a field is never exercised by a fixture. |

**Recommendation:** option 1 (FastAPI emits OpenAPI; TS codegen via
`openapi-typescript`). Mature, two-line CI step, well-trodden path.

---

## Phases

Six phases, ~4-6 weeks of focused effort end-to-end. Every phase is
behind a per-user feature flag and reversible by flag flip until
Phase 6.

### Phase 0 — Scaffolding ✅ shipped

**Shipped:** a Python service that boots, authenticates, and responds
to `/healthz`. No agent logic, no production traffic.

Lives at `services/agent-py/`. Stack: Python 3.12 · FastAPI · uv ·
PyJWT · pytest · ruff · mypy. CI gate added (`agent-py` +
`agent-py-types-drift` jobs in `.github/workflows/ci.yml`).

**Scope:**
- `services/agent-py/` directory in this repo (monorepo for now;
  split to its own repo is Phase 7).
- `Dockerfile` + `pyproject.toml` (uv or poetry).
- FastAPI skeleton with `GET /healthz` + `GET /readyz`.
- Auth middleware: verify Supabase JWT (`PyJWT` + the JWT secret).
- `docker-compose.yml` at repo root for local dev: spins up Next.js +
  the Python service together.
- **Deploy target: TBD.** The plan is host-agnostic at the application
  layer — the container only needs to (a) expose HTTP, (b) reach
  Supabase, and (c) keep running for as long as a single task does
  (no per-request execution cap). Concrete options to weigh later:
  self-host on Hetzner / a home server / k8s, or a managed PaaS
  (Fly.io, Railway, Render, Modal, etc.). The Phase 0 ship is the
  Dockerfile + a `docker run` command that works anywhere; the
  hosting decision can land between Phase 0 and Phase 1.
- OpenAPI emission already on by default in FastAPI; add `openapi-typescript`
  to the Next.js build to regenerate `lib/shared/api-schemas.generated.ts`
  in CI. Lint fails if it drifts.
- `CLAUDE.md` update: how to run the two services locally.

**Risks:**
- Local dev workflow adds a second process. Mitigation: the compose file.
- JWT secret rotation. Mitigation: env var; document in deploy guide.

**Rollback:** delete the directory. No production traffic yet.

**Verification:** `curl localhost:8000/healthz` returns 200 in dev;
container builds in CI; OpenAPI codegen runs.

### Phase 1 — Read-only queue replica ✅ shipped

**Shipped:** the Python service polls `task_jobs` alongside the TS
worker, but **logs only — never executes.** Proves connectivity, RLS,
job-claim semantics.

Lives under `services/agent-py/`:
- `db.py` — asyncpg pool lifecycle.
- `jobs.py` — `claim_next_job` using `FOR UPDATE SKIP LOCKED` (single
  statement; cleaner than the TS PostgREST two-step pattern) +
  `release_job_to_queue` for the Phase 1 dry-run release.
- `poller.py` — async tick loop wired into the FastAPI lifespan.
  Cancellation propagates cleanly on shutdown; transient errors don't
  kill the loop.
- `WORKER_DRY_RUN` (default `true`) and `POLL_INTERVAL_SECONDS`
  (default `5.0`) added to `Settings`.
- `/readyz` extended to report `supabase_db_configured` +
  `db_pool_open`.
- 17 new unit tests (db lifecycle / jobs SQL contract / poller
  control flow / cancellation).

Verification in production: watch for `lifespan.poller.started` →
`poller.claimed` / `poller.released` pairs at the configured
interval. `task_jobs` rows never stay in `running` after release
(predicate-guarded UPDATE). The TS worker stays canonical; Python
release puts the row back so TS picks it up on its next tick.

**Rollback:** stop polling (cancel the asyncio task; `lifespan`
handles this on container shutdown). No state change.

### Phase 2a — Executor pattern + feature flag ✅ shipped

**Shipped:** the executor end-to-end plumbing for `start` actions on
flagged users. Step fn is a stub; real model + tools land in Phase 2b.

Lives at `services/agent-py/`:
- `events.py` — TaskEvent IR (status / step_start / step_end / token
  / result) matching `lib/shared/agent/events.ts` so rows from
  either producer flow through the same projection reducer.
- `emitter.py` — RunEmitter with monotonic `seq` + settle-once.
- `store.py` — `append_event` (idempotent on `(task_id, seq)`),
  `update_run`, `set_task_handler` (`metadata.handler = 'python'`),
  `is_run_cancelled` cancel probe.
- `runner.py` — `run_agent_loop`: status → start_step → step →
  end_step → cancel-check; settles on done or `max_steps`.
- `feature_flag.py` — reads
  `auth.users.raw_user_meta_data->>'agent_backend'`. Defensive on
  every shape; any DB error falls back to "not flagged" (Phase 2
  invariant: never silently route TO Python on error).
- `executor.py` — `execute_start(pool, payload)`: stamps handler,
  runs loop, updates task row terminal, returns ExecutorOutcome.
- `jobs.py` extended with `mark_job_done` + `mark_job_failed`.
- `poller.py` dispatch tree: dry-run → release; live + unflagged →
  release; live + flagged + non-`start` → release; live + flagged
  + `start` → execute then mark_done/failed.
- 35 new unit tests (events / emitter / runner / feature_flag /
  executor / poller dispatch decision tree).

**Verification:** in production, set
`raw_user_meta_data->>'agent_backend' = 'python'` on a test user;
their next `start` task is handled by Python. `tasks.metadata.handler`
reads `'python'` for that row. The stub step fn emits a canned event
stream so the UI sees a real (if placeholder) projection.

### Phase 2b — Real model + tools (1 week)

**Ships:** swap the stub `_stub_step_fn` for an Anthropic SDK call;
add the first tool (`webFetch`) and the tool registry shape; surface
streaming tokens + tool calls into the event log.

**Scope:**
- Port `makeStreamTextStep` from `lib/server/agent/runner.ts` to
  Python. The runner control flow doesn't change — only the
  default `make_step_fn` factory swaps.
- Port the tool registry shape from
  `lib/server/skills/registry.ts`. Add `webFetch` as the first tool.
  `webSearch` (Tavily) and `searchFiles` slot in alongside without
  changing the registry shape.
- Add `token` + `tool_input` + `tool_output` + `step_error` to the
  TaskEvent union — already declared in events.py, just need
  emitter methods + payload mapping.
- Tool authentication: optional env keys for the Python service.

**Risks:**
- Behaviour drift between TS and Python runners. Mitigation: fixture
  round-trip — record real TS runs, replay inputs through Python,
  diff event streams. Land the fixture suite here.
- Streaming format quirks. Mitigation: pin one flagship model
  (Claude Sonnet) first.

**Rollback:** revert the `make_step_fn` change; stub returns. Flag
flips still gate per-user routing.

### Phase 3 — `continue` / `respond` + MCP parity (2 weeks)

**Ships:** Python handles all task actions for flagged users with the
full tool set, including MCP.

**Scope:**
- Port `imageGen`: Minimax T2I/I2I + the persistence path (download
  → Supabase Storage → signed URL). Mirrors `lib/server/image-storage.ts`.
- Port the MCP client: discovery, invocation, cloud-cred decryption.
  This is the **fiddliest port** — the `MCP_ENCRYPTION_KEY` + the
  SECURITY DEFINER decrypt RPC moves over. ~500 LOC of TS →
  ~700 LOC of Python.
- Port `continue` + `respond` actions (the HITL paths).
- Port `signGeneratedImageUrl` (the small-followups #4 we just landed).
- Port file extraction (`pypdf` / `python-docx` / `openpyxl` / `lxml`).
- Adopt the AI SDK UI message stream format. Frontend chat panel
  switches to `@ai-sdk/react`'s `useChat()` for the streaming
  consumer. Custom SSE consumer in `lib/client/agent/stream.ts`
  becomes redundant for `/api/chat`; keep it for legacy until Phase 5.

**Risks:**
- MCP cred decryption. Wrong → users can't use cloud-mode MCP
  servers. Mitigation: side-by-side test in CI; flag rollout gradual.
- Streaming format switch is user-visible (UI rendering changes).
  Mitigation: ship behind a separate flag; A/B for a week.
- File extraction parity. Different libraries → subtly different
  text. Mitigation: fixture suite from real uploads, diff with
  tolerance.

**Rollback:** revert tool ports one at a time via per-tool flags.

**Verification:** the full feature set works for flagged users. The
parity fixture suite covers 30+ representative runs.

### Phase 4 — Chat turn ports + frontend cutover (1 week)

**Ships:** `/api/chat` is served by Python for flagged users. The
Next.js `/api/chat/route.ts` becomes a thin proxy (or returns 503 if
Python is down).

**Scope:**
- Implement `/api/chat` in Python. Reuses the agent loop from Phase
  2-3, just without the durable-state writes (chat turns are
  ephemeral by design).
- Same-origin routing — the frontend hits `/api/chat` as today.
  Either: (a) the Next.js route handler proxies to the Python
  service over HTTP (works on any host, including self-hosted
  behind a reverse proxy), or (b) if deployed on Vercel, a
  Vercel rewrite forwards the path directly without a Next.js
  function in the middle (one less hop). Conditional on the
  feature flag; flag off → Next.js handles inline.
- Covers: `/api/chat`, `/api/tasks/*`, `/api/extract`,
  `/api/summarize`, `/api/mcp/*`, `/api/url/fetch`, `/api/images/*`.
- `lib/client/api-client.ts` doesn't change (paths are the same).
  Frontend doesn't know it's talking to Python.

**Risks:**
- SSE buffering through whatever sits between the browser and the
  Python service (Vercel rewrite, an Nginx in front of a self-host,
  a CDN with default buffering). Streaming requires chunked transfer
  + flushed writes; verify on the chosen host before flagging users.
- Cookie auth ↔ JWT bearer. The chat route currently reads the
  Supabase session cookie. The Python service expects a bearer token.
  Mitigation: whatever does the proxying injects the cookie's JWT as
  a bearer header.

**Rollback:** flip flag off; the proxy / rewrite stops; Next.js handles.

**Verification:** flagged users have full chat parity. Streaming
matches TS output within tolerance. Browser tab open for an hour
exercising all paths (text, tool calls, attachments, MCP, abort, retry).

### Phase 5 — Default-on, then decommission (1 week) — ⏸ deferred

> **Status: explicitly deferred.** Project policy is "keep both
> stacks live; the user selects backend via the Phase 4-2 toggle."
> The plan below is retained as a written option, not a roadmap
> item. Revisit only if the selector eventually gets retired (which
> isn't planned).

**Ships:** Python is canonical for all users. TS worker + agent
routes are deleted.

**Scope:**
- Flag flip: default to Python. Monitor for 1 week.
- Drop:
  - `lib/server/agent/runner.ts` + `worker.ts` (~960 LOC)
  - `lib/server/agent/store.ts` + `jobs.ts` + `checkpoint.ts` + `schedules.ts`
  - `lib/server/skills/*` (tool registry)
  - `lib/server/mcp/*` (MCP client)
  - `app/api/chat/route.ts` agent loop (route becomes a 410 Gone or
    is removed entirely)
  - `app/api/tasks/route.ts` worker bootstrap (route stays as the
    queue submitter; no inline `processNextJob` call)
- Keep:
  - `app/api/share/*` (data-layer concern)
  - `app/api/auth/callback` (Supabase magic-link)
  - `app/api/ai/*` editor routes (deferred — see §6)
  - `lib/shared/agent/*` (events, codec — used by both sides)

**Risks:**
- One-way door. Mitigation: 2-week observation window before deleting
  TS code. If anything fails, can re-flag back; the code is in git.
- The cron + queue tick. Vercel's cron currently hits
  `/api/tasks/jobs/tick`. Replace with Python service's own cron
  (Fly's cron or a scheduled task), OR keep the Vercel cron and have
  it call the Python service's tick endpoint.

**Rollback:** revert the deletion commit. The previous flag-flipped
state is fully working.

**Verification:** all users on Python. No TS worker logs for 1 week.

### Phase 6 — Tidy + docs (1-2 days) — ⏸ deferred

> **Status: explicitly deferred.** Phase 6 is the cleanup pass
> that follows a decommission. With Phase 5 deferred indefinitely,
> archiving this plan would be premature — the doc still
> describes a live, in-use stack.

**Ships:** the new normal documented; obsolete plans archived.

**Scope:**
- Update `CLAUDE.md` (architecture section, local dev workflow).
- Move this plan to `docs/_done/`.
- Move `PLAN-backend-extraction.md` to `docs/_done/` (Phase 2 is now
  this plan).
- Update `docs/API.md` to note the Python implementation.
- Final cost / latency / token-usage comparison vs the TS baseline
  in the PR description.

---

## Per-phase risks summary

| Phase | Top risk | Mitigation |
|---|---|---|
| 0 | Local dev workflow gets heavier | `docker-compose.yml` + `CLAUDE.md` |
| 1 | Dual job claim race | `FOR UPDATE SKIP LOCKED` |
| 2 | Runner behaviour drift | Fixture round-trip suite |
| 3 | MCP cred decryption | Side-by-side CI tests |
| 3 | Streaming format change is user-visible | Separate flag, A/B test |
| 4 | SSE buffering through the proxy / CDN sitting in front of the agent service | Verify on the chosen host before users |
| 5 | One-way door on deletion | 2-week observation window |

---

## Rollback at each phase

| Phase | Rollback | Time to revert |
|---|---|---|
| 0 | Delete `services/agent-py/` | Minutes |
| 1 | Stop the Python service polling | Minutes |
| 2 | Flag off the affected users | Seconds |
| 3 | Per-tool flag off | Seconds per tool |
| 4 | Flag off the rewrite | Seconds |
| 5 | Revert the deletion commit + re-enable cron | ~1 hour |

Phases 0-4 are all flag-flip reversible. Phase 5 is the only one-way
door, and only after a 2-week parity observation.

---

## Cost

**Hosting (incremental):** host-dependent — picked between Phase 0
and Phase 1, not committed to up front. Concrete weighings for context:
- Self-host (Hetzner / home server / existing k8s): **$0 incremental**
  if there's spare capacity; the only added cost is the operational
  surface (monitoring, restarts, certs). Same fixed cost as the box
  itself.
- Managed PaaS (Fly.io, Railway, Render, etc.): typically **$5-15/mo**
  for a small always-on container at the scale this plan targets.
  Most have a free tier that covers Phase 0-1.
- GPU-adjacent (Modal): pay-per-use. Worth considering only if you
  later want to run local inference; not load-bearing for any phase
  of this plan.

**Engineering:**
- 4-6 weeks of focused effort end-to-end.
- Ongoing: ~10% overhead from maintaining two languages (porting bug
  fixes both ways; updating two sets of dependencies).

**Anti-cost:**
- Frees up the Vercel function-execution budget you currently spend
  on the worker bootstrap.

---

## What changes for the other options

### If you pick **Option A (stay in-process)**

- Stop here. The phases above don't apply.
- Optional: an *internal* refactor extracting `lib/server/agent/runner.ts`
  + `worker.ts` + `store.ts` behind a `LocalAgentDriver` interface so
  if you later change your mind, the seam exists. 1-2 days.

### If you pick **Option B (TS service)**

- Phases 0, 1, 2, 4, 5 collapse dramatically:
  - Phase 0 (scaffolding): same, but Hono / Nitro in `services/agent-ts/`.
    No OpenAPI codegen — direct `lib/shared/` import.
  - Phase 1 (read-only replica): same.
  - Phase 2 (one action): a *move* of `runAgentLoop` to the new service,
    not a port. ~1 day instead of 1 week.
  - Phase 3 (parity): trivial — the tool registry + MCP client already
    work; they just import from `lib/server/*` in the new repo.
  - Phase 4 (chat turn): same shape; faster.
  - Phase 5 (cutover): same.
- Estimated total: **2-3 weeks** instead of 4-6.
- You don't get Python ecosystem access.

### If you pick **Option D (hybrid)**

- Phases 0-3 apply only to the **task worker**, not `/api/chat`.
- Skip Phase 4 (chat turn stays in Next.js).
- Phase 5 deletes only `lib/server/agent/worker.ts` + the task
  routes' worker bootstrap, not the chat route or `runner.ts`.
- Estimated total: **3-4 weeks**.
- Get most of drivers B+C; partial driver A (worker can be Python).
- Trade-off: now you have **two agent loops** to maintain — the
  Next.js chat-turn loop and the Python long-running loop. Drift
  risk is real.

---

## Decisions still to make before Phase 0

1. **Python framework** — FastAPI (recommended; mature, OpenAPI
   built-in) vs Litestar (newer, similar shape).
2. **Provider SDK** — LiteLLM (one interface, many providers; less
   provider-specific) vs direct `anthropic` / `openai` SDKs (more
   control, better streaming). Recommendation: **direct SDKs** for
   Phase 2-3 (parity matters); revisit if it becomes a pain.
3. **Contract sync** — OpenAPI codegen direction (recommended:
   FastAPI emits, TS consumes).
4. **Editor AI routes (`/api/ai/command`, `/api/ai/copilot`)** — port
   or keep in Next.js? Recommendation: **keep in Next.js** for at
   least Phase 1-3. They're tightly Plate-coupled and rarely the
   bottleneck. Re-evaluate after Phase 5.

**Deliberately deferred** (decide between Phase 0 and Phase 1, not
up front):

- **Same-origin vs subdomain.** Same-origin (a proxy / rewrite that
  keeps the browser hitting `app.example.com/api/*`) avoids CORS and
  cookie-domain pain. Subdomain (`api.example.com`) is fine if a
  reverse proxy isn't an option. The choice is host-specific and
  doesn't change the code. Falls out of the host decision below.

---

## Host decision (decided between Phase 0 and Phase 1)

Phase 0 is host-agnostic by design — the Dockerfile runs anywhere.
Phase 1 is the moment the service starts polling `task_jobs` in
production, so it needs a real home. This section is the
decision record.

### What the host has to provide

| Requirement | Why |
|---|---|
| Long-running container (no per-request cap) | The whole reason to split — we're escaping Vercel's 60s/300s cap. |
| Stable single instance | Phase 1-4 traffic is one polling worker plus per-user task streams. The `task_jobs` queue handles concurrency; horizontal scaling is Phase 5+. |
| Outbound HTTPS to Supabase | Read `messages`, write `task_events`, decrypt MCP creds. |
| Inbound HTTPS, SSE-friendly | The chat panel will eventually stream from the service. SSE requires `proxy_buffering off` (or equivalent). |
| 256-512 MB RAM | Python 3.12 + FastAPI + AI SDK clients fit comfortably. Phase 2-3 may push to 512 MB. |
| Reasonably close to Supabase region | Every read/write hop matters during agent loops. |
| Predictable ops surface | This is a side project, not a SaaS — fewer moving parts is the win. |

### Options considered

**Serverless (Lambda, Cloud Run scale-to-zero, Vercel functions):**
**Rejected.** Cold starts on the agent path defeat the purpose;
scale-to-zero means the polling worker stops. Could configure
min-instance=1, but at that point you're paying serverless prices
for a persistent VM.

**Modal:** Rejected. Pay-per-use is excellent for batch ML, awkward
for a persistent web service that wants to be always-warm.

**Heroku:** Functional but expensive and stagnant vs. modern
alternatives.

**The real shortlist:**

| | Self-host: home server / NAS | Self-host: Hetzner CX11 | PaaS: Fly.io | PaaS: Railway |
|---|---|---|---|---|
| **Marginal cost** | $0 (electricity already paid) | ~€4.5/mo (~$5) | $0 free tier → ~$5/mo at modest traffic | $5/mo Hobby |
| **Ops surface** | High — you're on-call for power, internet, OS updates | Medium — VM updates, firewall, certs | Very low — `fly deploy` ships it | Very low — `git push` ships it |
| **Latency to Supabase** | Depends on home connection + Supabase region | Excellent in EU; good worldwide | Anycast — good everywhere | Good (US-based) |
| **SSE** | Native (you control the proxy) | Native (you control the proxy) | Native, documented support | Native |
| **Platform risk** | None (you own it) | None (commodity VM) | Moderate (Fly has rewritten pricing twice recently) | Low |
| **Upgrade path** | Move the container off-prem when traffic warrants it | Resize CX11 → CX21 in place; migrate to dedicated if needed | Scale `fly machines` count | Bump plan |
| **Reversibility** | Highest — it's just `docker compose up` | High — same | High | High |

### Recommendation

**Pick self-host on a small Hetzner Cloud VM (CX22 or smaller), with
the home-server / NAS as a parallel option if you already have one
with stable uptime.**

Reasoning, tied to the actual situation:

1. **Cost.** Hetzner CX22 is roughly €4.5/mo for 2 vCPU / 4 GB / 40 GB
   SSD. Cheaper than every PaaS in the shortlist, comfortably
   over-provisioned for Phase 1-4, EU-based (latency is good against
   Supabase EU projects).
2. **Stated preference.** You said earlier: *"more likely we can have
   it hosted locally or other places that we can decide later."*
   Self-host respects that lean — the deploy target stays under your
   control, no platform-pricing risk, no PaaS lock-in to unwind later.
3. **Ops surface is manageable.** This is one stateless container.
   Updates via `docker pull && docker compose up -d`. No state to
   back up. Failure means re-run the container — the durable run
   state lives in Supabase, not on the host.
4. **No long-term lock-in.** If self-host turns out to be painful, the
   Dockerfile redeploys to any PaaS in the shortlist with zero code
   change.

**Home server / NAS substitutes cleanly** if (a) the box has good
uptime, (b) the home internet connection is stable enough that
intermittent outages won't strand running tasks for the duration of
the outage, and (c) you're comfortable exposing it to the internet via
a tunnel (Tailscale / Cloudflare Tunnel) or a port-forward + Caddy.
For Phase 1 (which only polls Supabase outbound) you don't strictly
need inbound at all — Phase 4 is when the chat panel reaches the
service, by which time you can decide.

### What "Hetzner CX22" actually looks like in practice

For sizing reference — Phase 1-4 will fit comfortably in the smallest
plan tier; this is a placeholder for the kind of VM the deploy uses,
not a hard pick of provider.

```
1. Provision a VM (Ubuntu 24.04 LTS, the smallest tier offered).
2. Install Docker + Docker Compose.
3. Clone the repo (or pull a pre-built image). docker compose up agent-py.
4. Put Caddy or Nginx in front for TLS + reverse proxy.
   IMPORTANT: `proxy_buffering off` for the SSE routes.
5. Tailscale or a firewall to limit inbound until Phase 4 needs it.
6. Monit / restart-on-failure via the `restart: unless-stopped`
   compose policy.
```

Caddy config sketch (for whenever the chat panel needs to reach the
service in Phase 4):

```caddy
agent.example.com {
  reverse_proxy localhost:8000 {
    flush_interval -1     # SSE: never buffer
    transport http {
      keepalive_idle 75s
    }
  }
}
```

### What the choice gives up

- **Multi-region** out of the box — would need a PaaS or a managed
  multi-region setup. Not relevant for Phase 1-4; revisit when there
  are users in distinct regions.
- **Easy A/B-of-regions** — same.
- **One-command scale-up** — Hetzner's resize is a reboot; PaaS would
  be a click. Acceptable for a side project.

### When to revisit

- **If the worker becomes user-facing latency-critical.** A PaaS with
  edge-routed inbound (Fly.io, Cloudflare) starts to pay for itself.
- **If you onboard non-EU users** and Supabase + self-host are both
  EU-based — latency to the user matters more than latency to the DB.
- **If ops becomes the bottleneck.** If a Saturday morning gets
  swallowed by patching the host, that's the signal to flip to PaaS.

Until any of those triggers fires, the self-host stays.

### Same-origin vs subdomain (falls out of the host decision)

With self-host: **subdomain** (`agent.example.com`) is easiest. CORS
config is one Caddy directive; the Next.js frontend sends cookies on
its own origin only and the Python service uses bearer tokens.

If a same-origin rewrite is preferred later (no CORS at all), it
needs Vercel rewrites in front, which means the Next.js deploy
forwards `/api/*` to the agent service — works fine but adds an
extra hop. Defer until there's a reason to want it.

---

## How to start (once decided)

If you green-light Option C:

1. Open a `services/agent-py/` directory.
2. Add a Dockerfile + `pyproject.toml`.
3. Scaffold FastAPI with `GET /healthz` + JWT middleware.
4. Add the OpenAPI codegen step to CI.
5. Confirm `docker run` works against a local Supabase project. Pick
   the host (self-host or PaaS) between this step and Phase 1.
6. Open a tracking PR titled "agent-py Phase 0 — scaffolding".

That's Phase 0. Phase 1 starts the moment scaffolding lands.
