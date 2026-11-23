# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Humm is a Next.js 16.4.6 chat assistant application with a multi-panel interface featuring chat, rich text editor (Plate.js), and file management capabilities.

## Commands

```bash
# Development
bun dev              # Start development server on http://localhost:3000

# Build & Production
bun run build        # Build for production
bun run start        # Start production server

# Linting
bun run lint         # Run ESLint
bun run typecheck    # Run `tsc --noEmit`
bun run check        # typecheck + lint (fast — mirrors CI without build/audit)
bun run check:ci     # typecheck + lint + build + audit:bundle (full CI gate locally)
bun run test         # split runner (scripts/run-tests.sh): isolates app/api/tasks/ (process-global mock.module mocks) + excludes services/ (own CI jobs); a coverage guard fails if a *.test.ts sits outside the configured roots
bun run test:e2e     # Playwright smoke: starts agent-py (stub harness) + a Next production build; see playwright.config.ts

# Agent service (Python — Phase 0 of PLAN-agent-api.md)
docker compose up agent-py            # run service in container
docker compose up proxy agent-py      # + Caddy on :8080, same origin (NEXT_PUBLIC_AGENT_PY_URL=/; README "Same-origin backend")
bun run codegen:agent-types           # regen lib/shared/agent-py-types.generated.ts
bun run codegen:agent-types:check     # CI mode — fail if drifted
bun run test:db                       # agent-py suite on a throwaway Postgres with every migration (needs Docker; mirrors the agent-py-db CI job) — run it for any change to SQL, migrations, the executor or runs
bun run check:agent-py                # ruff check + ruff format --check + mypy + pytest (mirrors the agent-py CI job)
bun run fixtures:runs                 # re-record agent-py run streams for lib/client/runs tests (after changing runs output)
bun run fixtures:runs --background    # …and the background-run set (real executor on a throwaway Postgres; needs Docker)

# Frontend↔backend contract (spec-first, docs/PLAN-frontend-backend-split.md)
bun run contract:gen                  # packages/contract/openapi.yaml → TS types + agent-py Pydantic models
bun run contract:check                # lint the spec + fail if generated outputs drifted (CI job `contract`)
CONTRACT_BASE_URL=http://localhost:8000 bun run contract:conformance   # run the conformance suite against a live backend

# Or to develop the agent service on the host:
cd services/agent-py && uv sync && uv run uvicorn agent_py.main:app --reload
# Auto-fix formatting before committing: cd services/agent-py && uv run ruff format . && uv run ruff check --fix .
```

> The agent-py CI job runs `ruff format --check` as a **separate step**
> from `ruff check` — `bun run check:agent-py` mirrors both, so run it
> (not just `ruff check`) before pushing agent-py changes.

## Architecture

### Tech Stack

- **Runtime**: Bun (package manager)
- **Framework**: Next.js 16.4.6 (App Router)
- **Language**: TypeScript 5.x
- **UI**: React 19.2.3
- **Styling**: Tailwind CSS 4 + shadcn/ui components
- **State**: Zustand 5.x with localStorage persistence
- **Editor**: Plate.js (Slate-based rich text)
- **Icons**: Lucide React

### Key Directories

| Directory | Purpose |
|-----------|---------|
| `app/` | Next.js App Router pages and layouts |
| `components/ui/` | Base UI components (shadcn/radix) |
| `components/panels/` | Main content panels (chat, editor, sources) |
| `components/sidebars/` | Sliding sidebar components |
| `lib/hooks/` | Zustand stores and custom hooks |
| `lib/` | Utilities (cn() for Tailwind, file-utils) |

### State Management

The app uses **Zustand** with localStorage persistence
(`lib/client/hooks/use-store.ts`):

- **Main store (`useStore`)**: Panel visibility, theme, conversations, messages, files, editor content
- **Session store (`useSessionStore`)**: Ephemeral state using sessionStorage (selected files for current session)

Key store interfaces:
```typescript
interface Conversation { id, title, messages[], createdAt, updatedAt, pinned }
interface Message { id, role: 'user' | 'assistant', content, timestamp }
interface UploadedFile { id, name, size, type, uploadedAt }
```

The store persists: theme, conversations, activeConversationId, files, documentContent, panel states, and panel widths.

**Slice layout** (`docs/PLAN-store-slice-split.md`). `use-store.ts` is a
thin composition + re-export hub: `AppState` is the union of per-entity
slice interfaces, and the `create()` body is one spread per slice. Each
slice lives in `lib/client/hooks/store/slices/<entity>.ts` and exports a
`<Name>Slice` interface + a `create<Name>Slice` factory (the standard
Zustand "slices pattern", typed against the full `StoreState` via
`SliceCreator<T>` so a slice can read siblings through `get()`). Slices:
`ui`, `chat`, `workspaces`, `conversations`, `messages`, `documents`,
`files`, `resources`, `conversation-files`, `mcp`, `url-bookmarks`,
`notes`, `artifacts`, `project-tasks`, `prompts`, `agents`. Selector
hooks (`useActiveWorkspace`, etc.) live beside their slice and are
re-exported from `use-store.ts` so consumer import paths don't change.

To find a mutator, open the slice named for its entity (e.g.
`deleteWorkspace` → `store/slices/workspaces.ts`). Cross-entity cascades
(`deleteWorkspace`, `deleteConversation`, `forkConversation`, file/MCP/
bookmark removals) live in the owning slice and reach siblings through
the shared `set`/`get`. The persist plumbing is split out too:
`store/migrate.ts` (`runMigrations` + `STORE_VERSION`) and
`store/persist.ts` (`partializeState` + `reviveAndPruneState`). **The
persisted localStorage shape + `STORE_VERSION` are a frozen contract** —
`store/persist.test.ts` pins the exact persisted key set, so adding or
removing a persisted key needs a matching `runMigrations` step + version
bump.

**Large blobs stay out of localStorage** (v32). `UploadedFile.imageDataUrl`
and `extractedFullText` live in IndexedDB (`lib/client/files/blob-fields.ts`);
`partializeState` strips them only once IndexedDB has committed them, and
they're usually absent from the in-memory row after a reload — read them via
`getFileBlobFields` / `getFileImageDataUrl(s)` / `useFileBlobFields`, never
`file.imageDataUrl` directly. A localStorage quota failure shows a
once-per-session toast (`store/quota-toast.ts`).

### Panel System

Uses Shadcn UI's `SidebarProvider` for a multi-panel layout:
- **AppSidebar**: Main navigation (left)
- **ChatSidebar**: Chat sessions list
- **SourcesSidebar**: File management
- **EditorSidebar**: Rich text editor (Plate.js)

Each panel is resizable and independently toggleable via the Zustand store.

### Theme

Default theme is `'dark'`. Theme is initialized synchronously from localStorage to prevent flash. Uses `suppressHydrationWarning` on the html element.

### Hydration Handling

Client-only time formatting is used to avoid hydration mismatches:
```typescript
function MessageTime({ timestamp }) {
  const [time, setTime] = useState("")
  useEffect(() => { setTime(formatTime(timestamp)) }, [timestamp])
  if (!time) return null
  return <>{time}</>
}
```

## Environment Variables

See `.env.example` for the full list. Two groups:

- **AI Gateway** (`AI_GATEWAY_API_KEY`) — required for real chat/editor AI. Without it, the chat panel falls back to a clearly-labeled mock response. Only model ids declared in `config/models.json` are dispatched on this key; any other id is rejected with 400 `unknown_model` unless the request brings its own gateway key (the editor's BYO `apiKey`). See `selectModel` in `lib/server/model-provider.ts`.
- **Trusted proxy hops** (`TRUSTED_PROXY_HOPS`, default `1`) — how many reverse proxies in front of Next.js append to `X-Forwarded-For`. `rateLimitKey` (`lib/server/rate-limit.ts`) takes the client IP from the entry that many positions from the right (left entries are client-spoofable); on Vercel (`VERCEL` set) the platform `x-real-ip` / `x-vercel-forwarded-for` headers win. `0` ignores XFF (all anonymous traffic shares one bucket). The same key, hashed, scopes anonymous callers in the summarize response cache. **A reverse proxy is required for per-IP limits** — `next start` only sets XFF when the client sent none, so with Next exposed directly clients pick their own key; production boot warns (`instrumentation.ts` → `warnOnProxyConfig`) when the var is unset or `0` outside a known platform. See `docs/SECURITY.md`.
- **Minimax-CN override** (`MINIMAX_CN_BASE_URL`, `MINIMAX_CN_API_KEY`) — optional. When both are set, any `minimax/*` model id is dispatched through an OpenAI-compatible client at the configured base URL instead of going through the Vercel AI Gateway. Useful for the Minimax China endpoint or a self-hosted Minimax-compatible gateway. Either var unset → fallthrough to the gateway, as if the override didn't exist. See `lib/server/model-provider.ts`. The same key powers the `generateImage` skill; the image endpoint is derived from `MINIMAX_CN_BASE_URL`'s origin (image and chat share a host but live under different paths), falling back to `https://api.minimaxi.com/` when `MINIMAX_CN_BASE_URL` is unset. See `lib/server/skills/minimax-image-client.ts`.
- **Ollama** (`OLLAMA_BASE_URL`, optional `OLLAMA_API_KEY`). When `OLLAMA_BASE_URL` is set (typically `http://localhost:11434/v1`), `ollama/*` models route through Ollama's OpenAI-compatible endpoint. The `ollama` provider in `config/providers.json` carries `allowInsecureBaseUrl: true` which relaxes two checks: the SSRF gate accepts `http://localhost` / loopback / private-network hosts, and the API key becomes optional (Ollama doesn't enforce auth). Only enable this for endpoints you control — by setting it you take responsibility for the upstream URL not being a credential-exfiltration sink. A malformed URL still fails at boot.
- **OpenRouter** (`OPENROUTER_API_KEY`). When set, the `openrouter` provider activates and any `openrouter/*` model id dispatches against `https://openrouter.ai/api/v1`. Special model `openrouter/auto` lets OpenRouter pick the upstream per request based on prompt length, latency budget, and price; specific upstream ids (`openrouter/anthropic/claude-sonnet-4.5`, etc.) route to that exact model. The base URL is fixed in `config/providers.json` (not env-overridable) because OpenRouter is a hosted gateway with no self-host story.
- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) — optional. Enables email magic-link sign-in and (eventually) cloud sync of workspaces, conversations, files, and conversation assets. Without it the app runs anonymously on `localStorage` only; the auth UI is hidden.
- **Require sign-in for AI** (`REQUIRE_AUTH_FOR_AI`) — optional, default off. When `true`/`1` **and** Supabase is configured, the model-spending routes (`/api/chat`, `/api/summarize`, `/api/ai/command`, `/api/ai/complete`, `/api/extract-table`, `/api/memory/extract`) return `401 { code: "auth_required" }` to anonymous callers, checked with `getUser()` before the body is read; `/api/extract` stays open but skips the vision pass for them. Off / Supabase unset → anonymous mode unchanged. Strict parsing (`true`/`false`/`1`/`0`); any other value throws, so the gated routes 500 rather than silently staying open. Helper: `lib/server/auth/require-ai-auth.ts` (`requireAiAuth()`). The client maps `auth_required` to a "Sign in required" error bubble / toast with a Sign in action (`lib/client/auth/auth-required.ts`), never the no-key mock fallback (that's the separate `auth` code).
- **MCP encryption** (`MCP_ENCRYPTION_KEY`) — required when any user picks Cloud-mode credentials for an MCP server. Generate with `openssl rand -base64 32`. Stored only in the Next.js server env; never persisted to Postgres. Rotating it invalidates existing cloud-mode credentials (users have to re-add).
- **MCP private hosts** (`MCP_ALLOW_PRIVATE_HOSTS`) — optional, default off. Every MCP server URL (proxy route, chat `mcpServers`, cloud rows, `/api/mcp/server` saves) passes `validateOutboundUrl` and must be public; outbound MCP + bookmark fetches go through `lib/server/url/guarded-fetch.ts`, whose undici dispatcher re-checks the resolved IP at connect time (DNS-rebinding guard) and re-validates every redirect. Set `true` to allow loopback / RFC 1918 / `.local` hosts for a local dev MCP server; link-local + cloud-metadata addresses stay blocked regardless. Never enable on a shared deployment. See `lib/server/mcp/outbound.ts`. agent-py reads the same variable for its MCP traffic (`url_validate.OutboundUrlPolicy`, checked at validation and at connect time) but parses it strictly: only `true` enables it, any value other than `true` / `false` / empty stops it at boot.
- **Code interpreter sandbox** (`CODE_SANDBOX_BASE_URL`, optional `CODE_SANDBOX_API_KEY`) — optional. When `CODE_SANDBOX_BASE_URL` is set, the `runCode` skill registers and runs model-written Python in a local **microsandbox** microVM (libkrun; HVF on Apple Silicon / KVM on Linux). Network is OFF inside the sandbox (airgapped); the pre-baked `python` image carries pandas/numpy/matplotlib; charts are produced via `savefig('/tmp/*.png')` and read back. Absent → the skill is simply not in `SERVER_SKILLS` (no mock — code execution has no meaningful mock), exactly like image-gen degrades without a Minimax key. Adapter lives in `lib/server/code-sandbox/` behind the `CodeSandbox` interface, so another provider drops in via the env seam. Caps via `CODE_SANDBOX_TIMEOUT_MS` / `_STDOUT_CAP` / `_RESULT_CAP` / `_MEM_MIB` / `_CPUS`. See `docs/PLAN-execution-sandbox.md` (runtime) + `docs/PLAN-code-interpreter.md` (consumer).
- **Vision document extraction** (`VISION_MODEL`) — optional. On top of the text-only extraction (`lib/server/extraction.ts`), layout-rich or scanned PDFs get a best-effort vision pass: pages are rendered to images (`pdf-to-img`, isolated in a Node worker thread so its bundled pdfjs can't collide with `pdf-parse`'s — see `lib/server/extraction/render-pdf.ts`) and transcribed to markdown (tables → markdown tables, figures → captions) by a vision-capable model, merged into the result's `text`/`fullText`. Gated by `shouldUseVision` (PDF + low text-yield or table-dense) and a per-IP budget; never fatal (any failure → text-only). `VISION_MODEL` overrides which model is used; it must be flagged `supportsVision` in `config/models.json`. Unset → first `supportsVision` model; none flagged → vision skipped. PR-1 of `docs/PLAN-multimodal-docs.md` (structured blocks + `file_sections` indexing + table rendering are PR-2/PR-3).
- **Content-Security-Policy** (`CSP_MODE`) — optional, `report-only` (default) | `enforce` | `off`; unset/unknown → `report-only`. `proxy.ts` (Next 16's renamed middleware) mints a per-request nonce, puts the policy on the request (Next reads the nonce from it and stamps its own scripts; `app/layout.tsx` reads `x-nonce` for the inline theme script — so every page renders dynamically) and on the response, plus `Reporting-Endpoints`. The policy is a pure builder in `lib/server/security/csp.ts` (nonce + `'strict-dynamic'` scripts, `'unsafe-inline'` styles, Supabase https+wss and `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_AGENT_{PY,TS}_URL` origins in `connect-src`). Reports land at `POST /api/csp-report` (`lib/server/security/csp-report.ts`) and are logged as one `{"evt":"csp_violation",…}` line each. Static headers (nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options, production HSTS) live in `next.config.ts` `headers()`. A new third-party origin the browser talks to must be added to the builder. Live-artifact and MCP-app iframes never use `srcdoc` (it would inherit the app policy and block their scripts under `enforce`): they load the static shell `GET /sandbox/frame` (`app/sandbox/frame/route.ts`, excluded from the proxy matcher) with `sandbox="allow-scripts"` and post the HTML in (`components/live-artifact/sandboxed-frame.tsx`, protocol in `lib/shared/sandbox-frame.ts`); the shell sends its own always-enforced CSP from `lib/server/security/sandbox-frame.ts` (inline + pinned CDNs, `connect-src 'none'`, `frame-ancestors 'self'`). See `docs/SECURITY.md` for reading reports and when to flip to `enforce`.

SQL lives under `supabase/migrations/` as numbered files applied in order (`0001_schema.sql`,
`0002_rls_policies.sql`, `0003_storage.sql`, `0004_conversation_files.sql`,
`0005_mcp.sql`, `0006_url_bookmarks.sql`, `0007_file_full_text.sql`,
`0008_message_compression.sql`, `0009_search_file_sections.sql`,
`0010_message_generated_images.sql`, `0011_prompts.sql`,
`0012_tasks.sql`, `0013_task_checkpoint.sql`,
`0014_task_jobs.sql`, `0015_workspace_canvas.sql`,
`0016_project_mode.sql`, `0017_prompts_workspace.sql`, … `0031_rls_fk_ownership.sql`,
`0032_task_job_lease.sql`, `0033_message_generated_files.sql`,
`0034_task_write_hardening.sql`, `0035_task_schedule_limits.sql`,
`0036_task_job_stale_lease_backfill.sql`,
`0037_validate_artifacts_kind_check.sql`, `0038_mcp_pgcrypto_schema.sql`,
`0039_mcp_upsert_foreign_id.sql`, `0040_task_worker_liveness.sql`,
`0041_runs_on_tasks.sql`, `0042_one_live_resume.sql`,
`0043_answer_once.sql`, `0044_message_turn_persona.sql`,
`0045_background_tasks_correct.sql`, `0046_chat_answer_once.sql`,
`0047_task_identity_and_caps.sql`, `0048_subagent_exit_entry.sql`) — see `docs/SUPABASE_SETUP.md`
for the hosted-cloud run order, or `docs/SUPABASE_LOCAL.md` for the
local Supabase CLI path (Docker-based, no cloud account needed). For
verifying the file full-text retrieval pipeline end-to-end after
schema or extraction changes, see `docs/SUPABASE_TEST.md`.

**RLS convention (0031).** Every user-data table's permissive `own …`
policy checks the row's own `user_id`; `0031_rls_fk_ownership.sql` adds a
RESTRICTIVE `<table>: fk ownership (insert|update)` policy requiring every
FK to a user-owned table to point at a row with `user_id = auth.uid()`.
A new table (or new FK column) referencing user-owned rows needs the same
restrictive pair, otherwise a user can hang rows off another user's data
via PostgREST.

**Worker tables are not user-writable (0034/0035).** `anon` /
`authenticated` cannot INSERT `tasks` or write `task_jobs`; API code
creates runs with the `create_task_run` RPC and enqueues with
`enqueue_task_job` (`lib/server/agent/task-writes.ts`, used by
`jobs.ts`). `tasks` UPDATE is column-granted to `status` / `finished_at`
/ `updated_at`, and a trigger only allows a live run → `cancelled` /
`failed`. `task_schedules` is column-granted (no `last_run_at` /
`last_run_task_id`), with a trigger enforcing a coarse cron floor and
20 enabled schedules per user; routes validate the exact ≥ 5 min gap
(`validateScheduleCron`). Workers (agent-py / agent-ts, DSN role) and the
service-role client are unaffected. A new column a route must write
needs a matching column GRANT.

**Runs live on the task tables (0041).** A `tasks` row is also a run of
the runs API (`docs/PLAN-frontend-backend-split.md` Q27): `mode` is
`background` (default — every pre-0041 row and writer) or `interactive`
(runs in agent-py's API process, never queued: a `task_jobs` trigger
refuses them). The thread is `thread_id` (= the conversation id, no FK);
background rows also keep `conversation_id = thread_id`, interactive
rows have `conversation_id` NULL (their conversation may not have synced)
and are deleted with their conversation by a trigger. Interactive runs
are created with the `create_run` RPC (idempotent on the client-minted
id). One live resume per interrupted run (0042): the unique partial
index `tasks_one_live_resume` on `previous_run_id` (rows not `failed` /
`cancelled`), surfaced by `create_run` as 23505 with that constraint
name → `409 run_already_resumed`. **Task identity (0047):** every row
has `root_run_id` (its task's first run: a resume's root is its previous
run's, a sub-agent's its parent's; set by the `tasks_identity` insert
trigger, no FK), `research`, and — on a root — `result_delivered_at`
(written only through `mark_task_delivered`). A task's current run is
`public.task_run_is_current(t)` / `public.task_current_run_id(t)` (Q75).
At most 5 active top-level tasks per user: `create_run` /
`create_task_run` raise 54000 (`409 limit_reached`), resumes exempt;
schedule fires go through `create_scheduled_task`, which creates the
task already failed at the cap. Each **question** (paused task +
question id) has one winner (0045, Q57/Q58): a runs-API resume refuses a
question a queued / running `respond` job holds (`409
run_already_answered`), `enqueue_task_job` refuses a `respond` to a
question a resume holds or the task doesn't wait on, and a background
resume that set `answers_applied_at` (written before any side effect)
holds it forever. So does an interactive (chat) one (0046, Q63): agent-py
stamps it before its answers take effect, under the user's task lock, and
`create_run` answers a later resume 23505 constraint
`tasks_answer_applied` → `409 run_answer_applied` once it has ended (the
paused run stays `interrupted`, Q64). **Background invariants (0045):** terminal is final (a
trigger); cancel = `cancel_task` = the whole task, a child is only
skipped (Q60); the sub-agent barrier is the `tasks_ended` /
`tasks_deleted` triggers, never a worker's decrement; every multi-row
writer locks in one order — conversation key share →
`private.lock_user_tasks` → task rows → job row. Migrate before deploying
agent-py, with no older agent-py running. **Every old task surface only sees `mode = 'background'`** — a new
reader of `tasks` for the task routes must filter on it too (see
`lib/server/agent/store.ts`).

## Frontend module conventions

`lib/` is split into three folders by runtime. The folder name tells you
where the code runs, and a fence import at the top of each file enforces
the boundary at build time:

| Folder | Runtime | Fence | Allowed imports |
|---|---|---|---|
| `lib/client/`  | Browser only | `import "client-only"` | `@/client/*`, `@/shared/*` |
| `lib/server/`  | Node only (route handlers, server components) | `import "server-only"` | `@/server/*`, `@/shared/*` |
| `lib/shared/`  | Isomorphic (pure, no I/O) | none | `@/shared/*` only |

Path aliases (`tsconfig.json`): `@/client/*`, `@/server/*`, `@/shared/*`.
ESLint enforces the same convention via `no-restricted-imports` in
`eslint.config.mjs`. After a production build, run `bun run audit:bundle`
to confirm no server-only paths or secret env-var names leaked into
`.next/static/chunks/*.js`.

When adding a new file, classify by runtime first:
- Touches `window`, `document`, `localStorage`, React hooks, or Zustand store → `lib/client/`
- Reads `process.env`, server-only secrets, or uses `next/headers` / `cookies()` → `lib/server/`
- Pure types, Zod schemas, helpers, constants → `lib/shared/`

## API contract

Frontend → backend communication is centralised in `lib/client/api-client.ts`.
Components and hooks must call `apiClient.*` (or read URLs from
`apiUrls.*` for libraries like Plate that take a URL string) — never
`fetch('/api/...')` directly. The wire shapes are pinned in
`lib/shared/api-schemas.ts` (Zod request + response schemas) and
`docs/API.md` (the SSE streaming protocol).

When adding a new endpoint, follow the checklist at the bottom of
`docs/API.md`. The plan in `docs/PLAN-backend-extraction.md` describes
the eventual swap to a Python backend; the client + schemas + doc
together are the contract that has to survive that swap.

## The three backends

Hummingbird ships with **three interchangeable backends** for `/v1/chat`
+ the four non-chat endpoints. Two live under `services/`; the third
is the original Next.js inline implementation split across
`app/api/**/route.ts` (route handlers — must live there because
Next.js's App Router resolves URLs by filesystem) and `lib/server/**`
(server-side libs called by both the route handlers and Server
Components). The frontend picks one per account via
`lib/client/api/backend-resolver.ts`'s `DispatchOption` (`'in-next'` /
`'remote'`). See [`services/README.md`](services/README.md) for the
full per-surface entry-point map and the rationale for why the third
backend doesn't live under `services/`. **agent-ts is frozen** (bug and
security fixes only, no new endpoints; Q11 of
`docs/PLAN-frontend-backend-split.md`) and doesn't import `lib/`: what
it used is vendored under `services/agent-ts/src/vendor/`, so fixes to
the `lib/` originals don't reach it. See `services/agent-ts/README.md`.

## Agent service (Python — Phases 0+1+2a)

`services/agent-py/` is the new Python agent service per
[`docs/PLAN-agent-api.md`](docs/PLAN-agent-api.md). **Phase 0**
shipped the scaffolding (FastAPI + JWT auth + OpenAPI codegen).
**Phase 1** added a background `task_jobs` poll loop in dry-run
mode — claims a job, structured-logs it, releases it back. **Phase 2a**
added the executor pattern end-to-end: TaskEvent IR, RunEmitter,
RunStore writes, the agent loop, a per-user opt-out, and the
executor. Later phases added the real model + tools, `continue` /
`respond`, subagents and lease-based crash recovery. **agent-py is the
task executor for every user** (agent-ts has no executor; its poller is
off unless `AGENT_TS_POLLER_ENABLED`).

Stack: Python 3.12 · FastAPI · uv (package manager) · PyJWT ·
asyncpg · structlog · pytest · ruff · mypy.

| Path | What |
|---|---|
| `services/agent-py/src/agent_py/main.py` | FastAPI app + endpoints. Lifespan owns the DB pool + the poller task. |
| `services/agent-py/src/agent_py/auth.py` | Supabase JWT verification middleware (HS256 against `SUPABASE_JWT_SECRET`). |
| `services/agent-py/src/agent_py/settings.py` | `pydantic-settings` config. Reads the repo-level `.env`. |
| `services/agent-py/src/agent_py/model_allowlist.py` | Model allowlist — the `anthropic/*` entries of `config/models.json`, each mapped to its `anthropicModelId`. Loaded + validated at `create_app`. agent-ts twin: `services/agent-ts/src/models.ts`. |
| `services/agent-py/src/agent_py/db.py` | asyncpg pool lifecycle. Open on startup if `SUPABASE_DB_URL` is set; close on shutdown. |
| `services/agent-py/src/agent_py/jobs.py` | `claim_next_job` (Phase 1) + `release_job_to_queue` (Phase 1 dry-run) + `mark_job_done` / `mark_job_failed` (Phase 2a settlement). |
| `services/agent-py/src/agent_py/events.py` | TaskEvent IR — status / step_start / step_end / token / result. Shape mirrors `lib/shared/agent/events.ts`. |
| `services/agent-py/src/agent_py/emitter.py` | RunEmitter — monotonic seq, settle-once. |
| `services/agent-py/src/agent_py/store.py` | RunStore — `append_event` (idempotent on `(task_id, seq)`), `update_run`, `set_task_handler` (`metadata.handler = 'python'`), `is_run_cancelled`. |
| `services/agent-py/src/agent_py/runner.py` | `run_agent_loop` — pure orchestration with injected RunStepFn. |
| `services/agent-py/src/agent_py/feature_flag.py` | Per-user **opt-out** — `auth.users.raw_app_meta_data->>'agent_backend'` absent / `'python'` → Python executes; any other value → opted out (job + task failed up front). DB error → unknown → release + retry. |
| `services/agent-py/src/agent_py/executor.py` | `execute_start` — stamps handler, runs loop, updates task row terminal. Step fn is a Phase 2a stub; Phase 2b swaps in the real model call. |
| `services/agent-py/src/agent_py/poller.py` | Async tick loop. Dispatch tree: dry-run → release; live + opted-out user → fail job + task; live + task already terminal → job done, no run; live otherwise → execute `start` / `continue` / `respond` under a heartbeated lease, then mark_done/failed. |
| `services/agent-py/tests/` | 62 tests covering health + auth (Phase 0) + db / jobs / poller dry-run (Phase 1) + events / emitter / runner / feature_flag / executor / poller live-mode dispatch (Phase 2a). |
| `services/agent-py/Dockerfile` | Multi-stage uv build, slim runtime, non-root user. Build context is the **repo root** (`docker build -f services/agent-py/Dockerfile .`) so the image ships `config/models.json`. |
| `docker-compose.yml` (repo root) | Spins up the agent service alongside `bun dev`. |
| `lib/shared/agent-py-types.generated.ts` | TS types generated from FastAPI's OpenAPI doc — the **source of truth** for the Python ⇄ TS contract. Regen with `bun run codegen:agent-types`. CI fails on drift via `codegen:agent-types:check`. |

**Configuration:** `SUPABASE_JWT_SECRET` is required for any
auth-protected endpoint (without it, those endpoints return 503 — a
distinct signal from 401 so monitoring can alert on misconfig).
`SUPABASE_DB_URL` is required to enable the poller — must be the
**direct** Postgres connection (`db.<project>.supabase.co:5432`), NOT
the transaction pooler (`*.pooler.supabase.com:6543`), because
`FOR UPDATE SKIP LOCKED` needs an open transaction. With it empty,
the poller no-ops every tick (`/healthz` + `/readyz` still respond).
`WORKER_DRY_RUN` defaults to `true` (Phase 1 contract); set it
`false` in any deployment that should run tasks — nothing else executes
them. With it `false`, Python runs **every** user's tasks unless the
user is opted out via `auth.users.raw_app_meta_data->>'agent_backend'`
(app metadata — service-role only; `raw_user_meta_data` is
user-writable and ignored). Absent or `'python'` → executed; any other
value (e.g. `'off'`) → the job and task are failed up front ("Background
tasks are disabled for this account"). To opt a user out:
`UPDATE auth.users SET raw_app_meta_data = COALESCE(raw_app_meta_data,
'{}'::jsonb) || '{"agent_backend":"off"}'::jsonb WHERE id = '<uuid>';`
(undo: `raw_app_meta_data - 'agent_backend'`). Safety net: the Next.js
stale-run reconciler (`lib/server/agent/store.ts`) fails a task still
`queued` and never started after `TASK_NO_WORKER_TIMEOUT_MINUTES`
(default 10) with "No task worker available" — but only when no worker
has executed anything in that window (`task_worker_active_within`,
migration 0040), so a busy worker's backlog waits instead. The service reads the
same top-level `.env` as Next.js.

**Model allowlist (agent-py + agent-ts):** both services accept only the
`anthropic/*` entries of `config/models.json` and send each entry's
`anthropicModelId` (e.g. `claude-sonnet-4-6`) to Anthropic; any other
id is 400 `unknown_model` on `/v1/chat` + `/v1/summarize`, and a run
whose checkpoint `config.model` isn't allowed fails before calling
Anthropic. `AGENT_DEFAULT_MODEL` (default `anthropic/claude-haiku-4.5`)
covers a model-less summarize + the suggestion chips, and must be on
the allowlist or the service won't boot. agent-py finds the catalog by
walking up from the package, or via `MODELS_CONFIG_PATH`. Adding an
`anthropic/*` model to `config/models.json` means setting its
`anthropicModelId` too. Details: `services/README.md` § Model allowlist.

**Runs API (`/v1/runs`, Phase 2 of `docs/PLAN-frontend-backend-split.md`).**
Five endpoints in `routers/runs.py`: `POST /v1/runs` (start — AG-UI
`RunAgentInput`, options in `forwardedProps`; interactive → `200` AG-UI
SSE, background → `202`), `GET /v1/runs` (list), `GET /v1/runs/{id}`,
`GET /v1/runs/{id}/events` (rejoin from a `<seq>` / `<seq>.<k>` cursor),
`POST /v1/runs/{id}/cancel`. The run model lives in
`services/agent-py/src/agent_py/runs/` — `wiring.py` builds every service
(stores, event logs, encoder, stream, harness, driver) and is the one
place to swap an implementation; a run is a `tasks` row (0041) for a
signed-in caller with `SUPABASE_DB_URL`, else in memory. Event mapping
and stream rules: `packages/contract/RUN_EVENTS.md`. Settings:
`REQUIRE_AUTH_FOR_AI` (refuses anonymous runs, as on Next) and
`RUNS_*` (lease/heartbeat, reaper interval, memory TTL/cap, per-IP
rate limits — `services/agent-py/README.md` § Configuration).
`RUNS_STUB_HARNESS=true` swaps the native harness (today's chat loop,
needs `ANTHROPIC_API_KEY`) for a model-free stub — for the contract
conformance suite (`CONTRACT_RUNS_STUB=1`) only.

**Deploy target decided** — self-host on a small VM (Hetzner CX22 as
the named example, ~€4.5/mo; home server / NAS as a parallel option
if uptime is good). Reasoning in `PLAN-agent-api.md` §Host decision.

## Development Patterns

- All panel content uses client-side rendering (`"use client"`)
- Zustand selectors are used for reactive state (`useStore(state => state.property)`)
- Tailwind classes are composed using the `cn()` utility from `lib/utils.ts`
- Components are organized by feature (panels, sidebars) rather than by type

## Working with PRs

- **Auto-subscribe to every PR you create.** Immediately after a
  successful `mcp__github__create_pull_request`, call
  `mcp__github__subscribe_pr_activity` with the same `owner`, `repo`,
  and the new PR's `pullNumber` — without waiting for the user to ask.
  Then handle CI failures and review comments as they arrive, per the
  PR-activity-event guidance in the system prompt.
- If the user explicitly says not to watch a particular PR, skip the
  subscribe for that one — but the default is on.

## User manual

The user-facing manual lives under `docs/user-manual/`. The top-level
`index.md` and the `.feature-inventory.json` are generated; the
per-topic pages are hand-written. To keep the manual in sync with the
codebase:

```bash
bun run docs:user-manual:build      # regenerate inventory + index.md
bun run docs:user-manual:check      # exit 1 if either is out of date
bun run docs:user-manual:roundtrip  # verify pages agree with inventory
```

When you add a new user-facing feature (a panel, a slash command, a
new env var, etc.), run the build. The new id will appear under
`## Unmapped (action needed)` in `index.md`. Write a page that
documents it, add the `<!-- pages-for: <id> -->` front-matter, and add
a `PAGE_MAP` entry in `scripts/build-user-manual-toc.ts`.
