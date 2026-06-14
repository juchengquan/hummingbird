# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Humm is a Next.js 16.1.6 chat assistant application with a multi-panel interface featuring chat, rich text editor (Plate.js), and file management capabilities.

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

# Agent service (Python — Phase 0 of PLAN-agent-api.md)
docker compose up agent-py            # run service in container
bun run codegen:agent-types           # regen lib/shared/agent-py-types.generated.ts
bun run codegen:agent-types:check     # CI mode — fail if drifted
bun run check:agent-py                # ruff check + ruff format --check + mypy + pytest (mirrors the agent-py CI job)

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
- **Framework**: Next.js 16.1.6 (App Router)
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

- **AI Gateway** (`AI_GATEWAY_API_KEY`) — required for real chat/editor AI. Without it, the chat panel falls back to a clearly-labeled mock response.
- **Minimax-CN override** (`MINIMAX_CN_BASE_URL`, `MINIMAX_CN_API_KEY`) — optional. When both are set, any `minimax/*` model id is dispatched through an OpenAI-compatible client at the configured base URL instead of going through the Vercel AI Gateway. Useful for the Minimax China endpoint or a self-hosted Minimax-compatible gateway. Either var unset → fallthrough to the gateway, as if the override didn't exist. See `lib/server/model-provider.ts`. The same key powers the `generateImage` skill; the image endpoint is derived from `MINIMAX_CN_BASE_URL`'s origin (image and chat share a host but live under different paths), falling back to `https://api.minimaxi.com/` when `MINIMAX_CN_BASE_URL` is unset. See `lib/server/skills/minimax-image-client.ts`.
- **Ollama** (`OLLAMA_BASE_URL`, optional `OLLAMA_API_KEY`). When `OLLAMA_BASE_URL` is set (typically `http://localhost:11434/v1`), `ollama/*` models route through Ollama's OpenAI-compatible endpoint. The `ollama` provider in `config/providers.json` carries `allowInsecureBaseUrl: true` which relaxes two checks: the SSRF gate accepts `http://localhost` / loopback / private-network hosts, and the API key becomes optional (Ollama doesn't enforce auth). Only enable this for endpoints you control — by setting it you take responsibility for the upstream URL not being a credential-exfiltration sink. A malformed URL still fails at boot.
- **OpenRouter** (`OPENROUTER_API_KEY`). When set, the `openrouter` provider activates and any `openrouter/*` model id dispatches against `https://openrouter.ai/api/v1`. Special model `openrouter/auto` lets OpenRouter pick the upstream per request based on prompt length, latency budget, and price; specific upstream ids (`openrouter/anthropic/claude-sonnet-4.5`, etc.) route to that exact model. The base URL is fixed in `config/providers.json` (not env-overridable) because OpenRouter is a hosted gateway with no self-host story.
- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) — optional. Enables email magic-link sign-in and (eventually) cloud sync of workspaces, conversations, files, and conversation assets. Without it the app runs anonymously on `localStorage` only; the auth UI is hidden.
- **MCP encryption** (`MCP_ENCRYPTION_KEY`) — required when any user picks Cloud-mode credentials for an MCP server. Generate with `openssl rand -base64 32`. Stored only in the Next.js server env; never persisted to Postgres. Rotating it invalidates existing cloud-mode credentials (users have to re-add).

SQL lives under `supabase/migrations/` as seventeen files (`0001_schema.sql`,
`0002_rls_policies.sql`, `0003_storage.sql`, `0004_conversation_files.sql`,
`0005_mcp.sql`, `0006_url_bookmarks.sql`, `0007_file_full_text.sql`,
`0008_message_compression.sql`, `0009_search_file_sections.sql`,
`0010_message_generated_images.sql`, `0011_prompts.sql`,
`0012_tasks.sql`, `0013_task_checkpoint.sql`,
`0014_task_jobs.sql`, `0015_workspace_canvas.sql`,
`0016_project_mode.sql`, `0017_prompts_workspace.sql`) — see `docs/SUPABASE_SETUP.md`
for the hosted-cloud run order, or `docs/SUPABASE_LOCAL.md` for the
local Supabase CLI path (Docker-based, no cloud account needed). For
verifying the file full-text retrieval pipeline end-to-end after
schema or extraction changes, see `docs/SUPABASE_TEST.md`.

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
backend doesn't live under `services/`.

## Agent service (Python — Phases 0+1+2a)

`services/agent-py/` is the new Python agent service per
[`docs/PLAN-agent-api.md`](docs/PLAN-agent-api.md). **Phase 0**
shipped the scaffolding (FastAPI + JWT auth + OpenAPI codegen).
**Phase 1** added a background `task_jobs` poll loop in dry-run
mode — claims a job, structured-logs it, releases it back. **Phase 2a**
added the executor pattern end-to-end: TaskEvent IR, RunEmitter,
RunStore writes, the agent loop, per-user feature flag, and the
executor that runs `start` actions for flagged users. Step fn is a
stub emitting a canned event stream — real model + tools land in
Phase 2b.

Stack: Python 3.12 · FastAPI · uv (package manager) · PyJWT ·
asyncpg · structlog · pytest · ruff · mypy.

| Path | What |
|---|---|
| `services/agent-py/src/agent_py/main.py` | FastAPI app + endpoints. Lifespan owns the DB pool + the poller task. |
| `services/agent-py/src/agent_py/auth.py` | Supabase JWT verification middleware (HS256 against `SUPABASE_JWT_SECRET`). |
| `services/agent-py/src/agent_py/settings.py` | `pydantic-settings` config. Reads the repo-level `.env`. |
| `services/agent-py/src/agent_py/db.py` | asyncpg pool lifecycle. Open on startup if `SUPABASE_DB_URL` is set; close on shutdown. |
| `services/agent-py/src/agent_py/jobs.py` | `claim_next_job` (Phase 1) + `release_job_to_queue` (Phase 1 dry-run) + `mark_job_done` / `mark_job_failed` (Phase 2a settlement). |
| `services/agent-py/src/agent_py/events.py` | TaskEvent IR — status / step_start / step_end / token / result. Shape mirrors `lib/shared/agent/events.ts`. |
| `services/agent-py/src/agent_py/emitter.py` | RunEmitter — monotonic seq, settle-once. |
| `services/agent-py/src/agent_py/store.py` | RunStore — `append_event` (idempotent on `(task_id, seq)`), `update_run`, `set_task_handler` (`metadata.handler = 'python'`), `is_run_cancelled`. |
| `services/agent-py/src/agent_py/runner.py` | `run_agent_loop` — pure orchestration with injected RunStepFn. |
| `services/agent-py/src/agent_py/feature_flag.py` | Per-user flag check — `auth.users.raw_user_meta_data->>'agent_backend' == 'python'`. Defensive on every shape; DB error → fall back to "not flagged". |
| `services/agent-py/src/agent_py/executor.py` | `execute_start` — stamps handler, runs loop, updates task row terminal. Step fn is a Phase 2a stub; Phase 2b swaps in the real model call. |
| `services/agent-py/src/agent_py/poller.py` | Async tick loop. Dispatch tree: dry-run → release; live + unflagged → release; live + flagged + non-`start` → release; live + flagged + `start` → execute then mark_done/failed. |
| `services/agent-py/tests/` | 62 tests covering health + auth (Phase 0) + db / jobs / poller dry-run (Phase 1) + events / emitter / runner / feature_flag / executor / poller live-mode dispatch (Phase 2a). |
| `services/agent-py/Dockerfile` | Multi-stage uv build, slim runtime, non-root user. |
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
`WORKER_DRY_RUN` defaults to `true` (Phase 1 contract); flip to
`false` to enable the Phase 2a executor. With it `false`, the
per-user feature flag (`auth.users.raw_user_meta_data->>'agent_backend'`)
gates whether Python executes a given user's runs vs releases for the
TS worker. To opt a user in: `UPDATE auth.users SET raw_user_meta_data
= COALESCE(raw_user_meta_data, '{}'::jsonb) ||
'{"agent_backend":"python"}'::jsonb WHERE id = '<uuid>';`. The service
reads the same top-level `.env` as Next.js.

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
