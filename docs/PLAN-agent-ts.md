# Plan: TS twin of the Python agent service (`services/agent-ts/`)

Status: **📋 Draft.** Companion to
[`PLAN-agent-api.md`](./PLAN-agent-api.md), which shipped the
Python agent service (Option C in that doc's decision matrix).
This plan describes what it would take to ship a **TypeScript
twin** of `services/agent-py/` — same architecture, same wire
contracts, different runtime. That was Option B in the original
matrix; it stayed unshipped because the Python service covered
all four drivers (A: Python ecosystem; B/C/D: independent deploy,
reduced Vercel coupling, exploration).

## What we're solving for

The Python service already exists and works. So why a TS twin?

| Force | What it gets us |
|---|---|
| **A. Shared types, zero codegen** | `lib/shared/` types import directly into the service. No `openapi-typescript` codegen step. Schema drift is a `tsc` error, not a CI gate. |
| **B. Same-language ergonomics** | The whole frontend / API contract / agent core is one language. Easier for TS-fluent contributors; one toolchain (Bun + ESLint + Prettier + TypeScript). |
| **C. Re-use existing TS implementations** | `lib/server/agent/*`, `lib/server/skills/*`, `lib/server/mcp/*`, `lib/server/url/*` already exist on the Next.js side. The TS service can import them as-is rather than re-implementing in Python. Cuts the port work by ~80%. |
| **D. A/B parity comparisons** | Two services with identical wire contracts let us measure model output, token usage, and latency cost/diff between runtimes without "did the port introduce a bug?" as a confound. |

What this **doesn't** get us:

- The Python ecosystem (the driver that motivated `agent-py`).
  TS can't ship DSPy, vLLM, custom retrievers without a sidecar.
- Anything the Python service doesn't already cover. The TS twin
  is a parallel runtime, not a feature expansion.

Per the project's standing "both stacks live" policy, the TS
service is a **third backend option**, not a replacement for
either of the existing two. The Phase 4-2 selector grows a third
entry; the user picks per-account.

## Architecture mirror

The TS service is structurally identical to `services/agent-py/`
— same modules, same responsibilities, same wire shapes. The
table below maps Python file → TS equivalent:

| `services/agent-py/src/agent_py/…` | `services/agent-ts/src/…` | Notes |
|---|---|---|
| `main.py` (FastAPI app + routes) | `app.ts` (Hono routes) | Hono picked for parity-tooling; Fastify works equally well. |
| `auth.py` (JWT middleware) | `middleware/auth.ts` | Reuse `lib/server/supabase/jwt.ts` (already verifies HS256 against `SUPABASE_JWT_SECRET`). |
| `settings.py` (pydantic-settings) | `env.ts` (zod-validated env) | Same env-var names — single `.env` covers all three stacks. |
| `db.py` (asyncpg pool) | `db.ts` (`postgres` driver pool) | `postgres` not `node-postgres` — better TS types, simpler streaming. |
| `jobs.py`, `store.py`, `emitter.py`, `events.py`, `runner.py` | direct re-export from `lib/server/agent/` | The existing TS modules already match the IR shape. No port needed. |
| `executor.py` | `executor.ts` | Thin glue over the existing TS runner. Stamp `tasks.metadata.handler = 'ts-service'` so postmortems can tell apart the in-Next-process worker, the TS service, and `agent-py`. |
| `poller.py` | `poller.ts` | Same `FOR UPDATE SKIP LOCKED` loop. |
| `tools/registry.py`, `tools/web_fetch.py`, etc. | direct re-export from `lib/server/skills/*` | Tool descriptors already exist on the TS side. |
| `mcp_client.py`, `mcp_credentials.py`, `mcp_tools.py` | direct re-export from `lib/server/mcp/*` | Same observation. |
| `image_storage.py` | direct re-export from `lib/server/image-storage.ts` | Already exists. |
| `extraction.py` | direct re-export from `app/api/extract/route.ts` helpers (refactor to library) | TS extractor lives inline in the route today; lift to a library so the TS service can call it. |
| `url_fetch.py`, `url_validate.py` | direct re-export from `lib/server/url/*` | Already exists. |
| `summarise.py` | port (one-shot prompt builder + JSON parse) | Small; the TS chat route doesn't have this as a library today. |
| `chat.py` (SSE generators) | `chat.ts` | Two formatters: custom (existing TS chat consumer) and AI-SDK v5 (via the SDK's built-in `streamText().toUIMessageStream()`). |

**Key insight:** because the TS service shares a repo with the
Next.js app, it imports `lib/server/*` directly. The Python
service had to **port** ~3,500 LOC of TS to ~4,200 LOC of Python
(Phases 2b → 4-4b). The TS service should clock in around
**~600 LOC of glue** (route handlers, app wiring, env, executor
stamp) on top of the existing TS modules.

## Wire contract

Identical to the Python service. The frontend selector treats
all three backends interchangeably:

```
/v1/chat                                — POST, SSE (custom or AI-SDK)
/v1/extract                             — POST, multipart upload
/v1/url/fetch                           — POST, JSON
/v1/images/refresh-url                  — POST, JSON
/v1/summarize                           — POST, JSON
/v1/mcp/{server_id}/{action}            — POST, JSON
/v1/whoami                              — GET, JSON
/healthz, /readyz                       — GET, JSON
```

OpenAPI generation: Hono has `@hono/zod-openapi`, which emits a
`/openapi.json` schema directly from the route definitions. The
existing `bun run codegen:agent-types` script already runs
against `agent-py`'s OpenAPI; the same script can target the TS
service's `/openapi.json` if we ever want a strict-typed client
for it. Frontend-side, the TS service's types could be imported
**directly** from `services/agent-ts/src/types.ts` — no codegen
at all — so the script is mostly a CI consistency check.

## Selector wiring

The Phase 4-2 toggle in
`components/auth/account-menu.tsx` currently picks between
`'ts'` (Next.js inline route) and `'python'` (agent-py). It
grows to three options when this lands:

```ts
type ChatBackend = "ts" | "python" | "ts-service"
```

`AGENT_PY_BASE_URL` becomes one of three:
- `NEXT_PUBLIC_AGENT_PY_URL` — Python service (existing)
- `NEXT_PUBLIC_AGENT_TS_URL` — TS service (new)
- (none) — Next.js inline route (default)

The `apiClient.chatStream` dispatch already keys on `backend` ∈
`{ts, python}`; adding a third branch is a 10-line change. The
account menu's `ToggleRow` becomes a `Select` (or three rows).

## Phased plan

Same shape as PLAN-agent-api: phases small enough to land in one
reviewable PR each, each lands shippable behind the selector
without breaking either existing backend.

### Phase 0 — Scaffolding (~1 day)

**Ships:** `services/agent-ts/` with Hono + health + JWT auth +
docker-compose entry.

**Scope:**
- `services/agent-ts/package.json` — Hono, `@hono/node-server`
  (or `@hono/bun-adapter`), zod, `postgres`. Bun preferred so
  the runtime matches the frontend toolchain.
- `src/app.ts` — Hono app factory mirroring `create_app(...)` in
  `agent-py`. Lifespan: open Postgres pool on boot, close on
  shutdown.
- `src/env.ts` — zod schema for the shared env vars
  (`SUPABASE_*`, `ANTHROPIC_*`, `MINIMAX_CN_*`, `TAVILY_API_KEY`,
  `MCP_ENCRYPTION_KEY`). Same vars Python and Next.js read.
- `src/middleware/auth.ts` — JWT verify against
  `SUPABASE_JWT_SECRET` (reuse `lib/server/supabase/jwt.ts`).
- `src/routes/health.ts` — `/healthz` + `/readyz`.
- `src/routes/whoami.ts` — echoes JWT claims (smoke test).
- `Dockerfile` — multi-stage Bun build, non-root user, same
  shape as `services/agent-py/Dockerfile`.
- `docker-compose.yml` — add `agent-ts` alongside `agent-py`.

**Verification:** `curl localhost:8001/healthz` returns 200;
`curl -H "Authorization: Bearer <jwt>" localhost:8001/v1/whoami`
echoes the claims.

### Phase 1 — Read-only queue replica (~0.5 day)

**Ships:** Poll loop that claims `task_jobs` rows and releases
them back, in dry-run.

**Scope:**
- `src/poller.ts` — `FOR UPDATE SKIP LOCKED` claim, log structured
  event, release. Same `WORKER_DRY_RUN` env var as `agent-py`.
- `src/jobs.ts` — `claimNextJob` / `releaseJobToQueue` /
  `markJobDone` / `markJobFailed`. Direct port of
  `agent-py/jobs.py`, ~80 LOC.

**Verification:** With `SUPABASE_DB_URL` set and `WORKER_DRY_RUN=true`,
the service claims and releases jobs visible in `task_jobs`
without executing them.

### Phase 2 — Executor wiring (~1 day)

**Ships:** `start` jobs claimed by the TS service execute end-to-end
using the existing `lib/server/agent/runner.ts` machinery.

**Scope:**
- `src/executor.ts` — load checkpoint, call
  `runAgentLoop(...)` from `lib/server/agent/runner.ts`,
  settle the task row. Stamp
  `tasks.metadata.handler = 'ts-service'`.
- Per-user feature flag check — same
  `auth.users.raw_user_meta_data->>'agent_backend'` lookup, but
  the matching value is `'ts-service'` (NOT `'python'`).
  Co-existence: a user can opt into Python OR TS-service OR
  neither.
- Reuse the existing `lib/server/agent/{store,jobs,checkpoint}.ts`
  modules directly — no re-implementation.

**Tests:** mirror `agent-py/tests/test_executor.py` (run an
inline fake step fn through the executor, assert state
transitions).

### Phase 3 — Chat + tools + skills (~1 day)

**Ships:** `POST /v1/chat` with full feature parity. The
runtime difference is "Hono instead of Next.js handler"; the
underlying logic is **the same `streamText()` call** the existing
`/api/chat` route already uses, lifted into a library.

**Scope:**
- Refactor `app/api/chat/route.ts`'s `streamText(...)` body
  into `lib/server/agent/chat-stream.ts` so both the Next.js
  route AND `services/agent-ts/` can call it.
- `src/routes/chat.ts` — Hono handler that calls the library +
  returns SSE.
- Two wire formats: custom (existing) and AI-SDK v5 (via
  `stream.toUIMessageStream({ sendFinish: true })`). Mirrors
  Phase 3g on the Python side; here it's a one-liner since the
  AI SDK ships the formatter natively.
- All skills (`webFetch`, `webSearch`, `searchFiles`,
  `generateImage`, MCP) work out of the box — they're already
  TS and live under `lib/server/skills/`.

**Verification:** with `NEXT_PUBLIC_AGENT_TS_URL=http://localhost:8001`
and the selector flipped to `ts-service`, a chat turn streams
through the TS service and renders identically to the Next.js
inline path.

### Phase 4 — Remaining routes (~1 day)

**Ships:** `/v1/extract`, `/v1/summarize`, `/v1/url/fetch`,
`/v1/images/refresh-url`, `/v1/mcp/{server}/{action}` all hosted
on the TS service.

**Scope:**
- Lift the body of each existing Next.js route into a library
  function under `lib/server/` (some already are; some inline
  the logic).
- Add the Hono handler in `services/agent-ts/src/routes/`.
- Reuse zod schemas from `lib/shared/api-schemas.ts` — same
  validation, same error shapes.

**Verification:** parametrised curl matrix against the TS
service mirrors the same matrix run against `agent-py`. Diff
should be empty.

### Phase 5 — Frontend selector grows a third option (~0.5 day)

**Ships:** Account menu `ChatBackend` becomes a 3-way pick. The
apiClient dispatches to whichever URL the user chose.

**Scope:**
- `lib/client/hooks/store/slices/ui.ts` — widen
  `ChatBackend: 'ts' | 'python' | 'ts-service'`. Bump
  `STORE_VERSION` to 21 with a migration that keeps existing
  values valid (no rewrites needed).
- `lib/client/api-client.ts` — `AGENT_TS_BASE_URL` from
  `NEXT_PUBLIC_AGENT_TS_URL`; add the third dispatch branch in
  `chatStream`.
- `components/auth/account-menu.tsx` — three-row toggle (or a
  `Select`) gated on whichever URLs are configured.

**Verification:** click each radio, send a chat — Network tab
shows the correct origin for each backend.

## Risk + non-goals

**Risks:**
- **Doubled deploy surface.** Two long-running services instead
  of one. Mitigation: same self-host approach as `agent-py` (one
  Hetzner CX22 can host both processes; ~0 incremental cost).
- **Three-way selector confusion.** Users may not understand the
  difference. Mitigation: descriptive labels + a help link in
  the toggle UI. Default stays the Next.js inline path (no
  change for existing users).

**Explicit non-goals:**
- Cutover (analog of agent-py Phase 5). Not in scope; same
  reason — both stacks stay live.
- Frontend `useChat()` adoption. Independent workstream; can
  land before, during, or after this plan.
- Sharing process with `agent-py`. They stay separate
  containers. Operational simplicity over packing density.

## Estimate

| Phase | Effort | Cumulative |
|---|---|---|
| 0 | ~1 day | 1 day |
| 1 | ~0.5 day | 1.5 days |
| 2 | ~1 day | 2.5 days |
| 3 | ~1 day | 3.5 days |
| 4 | ~1 day | 4.5 days |
| 5 | ~0.5 day | **~5 days total** |

About one calendar week of focused work, vs. the ~6 weeks the
Python service consumed. The delta is exactly the "re-use
existing TS implementations" lever — `lib/server/{agent,skills,mcp,url,image-storage}.ts`
already exists and works.

## Open questions for the green-light decision

1. **Runtime: Bun or Node?** Bun matches the frontend
   toolchain (same `bun install`, same scripts); Node is
   simpler to deploy on managed PaaS that doesn't speak Bun.
   Self-host removes the Node-on-PaaS pressure; default to Bun.
2. **Framework: Hono or Fastify?** Hono has better OpenAPI
   integration (`@hono/zod-openapi` generates schemas from zod
   definitions). Fastify is more battle-tested in production.
   Default to Hono unless someone has a strong opinion.
3. **DB driver: `postgres` or `pg`?** `postgres` is smaller,
   has better TypeScript types, and supports the
   `FOR UPDATE SKIP LOCKED` semantics we need. Default to
   `postgres`.
4. **Process model: long-running, or serverless?** Long-running
   for parity with `agent-py` (the poll loop needs a persistent
   process anyway). Serverless deployment would require the
   `task_jobs/tick` cron pattern instead.

Each of these is a one-line config decision; none block the
phased plan above.
