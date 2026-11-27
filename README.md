# Hummingbird

A multi-panel chat assistant: streaming chat with tool calls, a Plate.js
rich-text editor, per-conversation file attachments, MCP (Model Context
Protocol) server integration, and optional Supabase-backed multi-device
sync. Next.js 16 + React 19 + Bun for the frontend, and one backend:
the Python agent service, agent-py (`services/agent-py/`), which the app
needs running. Local-first by default; signing in unlocks cloud sync
without changing the offline UX.

## Quick start (no Supabase)

The fastest path — runs everything in `localStorage`, no Supabase
needed. You get the full app minus multi-device sync and sign-in. The
frontend talks to agent-py for every API call (chat, files, MCP, the
editor AI), so run both:

```bash
bun install
cp .env.example .env.local         # leave Supabase vars blank
docker compose up proxy agent-py   # agent-py + a Caddy proxy on :8080 (reads .env)
bun dev                            # Next on :3000
open http://localhost:8080         # use the app through the proxy
```

Set **at minimum**:

```bash
NEXT_PUBLIC_AGENT_PY_URL=/            # .env.local — the browser calls /v1/... on the proxy's origin
ANTHROPIC_API_KEY=<your key>          # .env — or AI_GATEWAY_API_KEY / OPENROUTER_API_KEY / MINIMAX_CN_* / OLLAMA_BASE_URL
```

Without a model provider the app still loads, but the model picker and
the chat say plainly that no provider is configured, with a pointer to
the setup docs — there is no mock answer. Without
`NEXT_PUBLIC_AGENT_PY_URL` the app shows a "This deploy has no backend
configured" screen.

## Quick start (with local Supabase)

Unlocks password sign-in, file persistence, and the MCP cloud-mode
credential lane. Two paths — both detailed in
[`docs/SUPABASE_LOCAL.md`](docs/SUPABASE_LOCAL.md).

```bash
# Path A — Supabase CLI (recommended; needs `supabase` + Docker)
bun run supabase:start
cat .docker/supabase/dev-keys.txt        # paste into .env.local
bun dev

# Path B — Docker only (no CLI; uses docker-compose.supabase.yml)
bun run supabase:docker:up
bun run supabase:docker:migrate
cat .docker/supabase/dev-keys.txt        # paste into .env.local
bun dev
```

Verify the stack: open Studio at <http://localhost:54323>; emails land
in the local inbox at <http://localhost:54324> (Mailpit with the CLI,
Inbucket with docker-compose).

## Same-origin backend (reverse proxy)

The backend (`services/agent-py/`) is best served on the **same
origin** as the frontend, the way a deployment serves them
(`docs/PLAN-frontend-backend-split.md` Q21). A Caddy proxy on
<http://localhost:8080> sends `/v1/*`, `/healthz` and `/readyz` to
agent-py and everything else to the Next dev server:

```bash
# .env.local
NEXT_PUBLIC_AGENT_PY_URL=/        # "/" = call /v1/... on the page's own origin

bun dev                            # Next on :3000 (restart after editing NEXT_PUBLIC_*)
docker compose up proxy agent-py   # Caddy on :8080 + agent-py (reads .env)
open http://localhost:8080         # use the app through the proxy
```

Routing lives in [`.docker/proxy/Caddyfile`](.docker/proxy/Caddyfile)
(SSE flushes immediately; `PROXY_PORT` changes the published port).
The browser sends the Supabase JWT as a bearer token when signed in,
exactly as with a separate origin. Alternatively set
`NEXT_PUBLIC_AGENT_PY_URL=http://localhost:8000` to call agent-py on its
own port (then agent-py needs `CORS_ALLOWED_ORIGINS=http://localhost:3000`).

## Environment variables

See [`.env.example`](.env.example) for the canonical list with
descriptions. Quick reference:

The frontend (Next) reads only `NEXT_PUBLIC_*` and `CSP_MODE`; every
secret is agent-py's (`services/agent-py/README.md` § Configuration).
One `.env` is still shared by both (split in wave 14).

| Variable | Read by | When | Why |
|---|---|---|---|
| `NEXT_PUBLIC_AGENT_PY_URL` | Next | Always | agent-py base URL; `/` = same origin behind the proxy |
| `NEXT_PUBLIC_SUPABASE_URL` | Next | Only with Supabase | Browser client target |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Next | Only with Supabase | Browser client auth |
| `CSP_MODE` | Next | Optional | `report-only` (default) / `enforce` / `off` |
| `ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_CN_*`, `OLLAMA_BASE_URL` | agent-py | At least one, for real AI | Model providers |
| `SUPABASE_JWT_SECRET` (or a JWKS URL), `SUPABASE_DB_URL` | agent-py | Only with Supabase | Verify sessions; tasks, runs, schedules |
| `WORKER_DRY_RUN=false` | agent-py | To run background tasks | The task worker (and the scheduler that follows it) |
| `TAVILY_API_KEY` | agent-py | Only for web search | Tavily-backed `webSearch` tool |
| `MCP_ENCRYPTION_KEY` | agent-py | Only for cloud-mode MCP creds | pgcrypto symmetric key (32+ chars). Generate with `openssl rand -base64 32` |

## Common scripts

```bash
bun dev                  # dev server with HMR
bun run build            # production build
bun run start            # production server
bun run check            # typecheck + lint (mirrors CI minus build/audit)
bun run check:ci         # full CI gate locally
bun run lint             # eslint only
bun run typecheck        # tsc --noEmit only

# Supabase (CLI path)
bun run supabase:start   # boot stack + apply migrations
bun run supabase:stop    # stop containers
bun run supabase:reset   # wipe + reapply all migrations (~3s)
bun run supabase:status  # show ports + keys
bun run supabase:types   # regenerate lib/shared/supabase/types.ts

# Supabase (docker-compose path)
bun run supabase:docker:up
bun run supabase:docker:down
bun run supabase:docker:migrate
bun run supabase:docker:reset
```

## Architecture at a glance

- **`app/`** — Next.js App Router pages (no API routes since wave 13).
- **`services/agent-py/`** — the backend: chat and tasks on `/v1/runs`,
  the task worker and scheduler, MCP, file extraction, share links,
  summarize, the editor AI. The wire contract is
  `packages/contract/` (OpenAPI + `RUN_EVENTS.md`).
- **`components/panels/`** — Main content (chat, editor, resources).
- **`components/sidebars/`** — Sliding sidebars (workspaces, chat
  list, resources rail).
- **`lib/client/`** — Browser-only (Zustand store, hooks, API client,
  IndexedDB helpers). Fenced via `import "client-only"`.
- **`lib/server/`** — Node-only: just the CSP builder and the sandbox
  frame's policy (no secrets). Fenced via `import "server-only"`.
- **`lib/shared/`** — Isomorphic (types, Zod schemas, pure utilities,
  generated Supabase types). No I/O.
- **`supabase/migrations/`** — Five SQL files run in order; see
  `docs/SUPABASE_SETUP.md`.

The folder fences are enforced at build time via ESLint
`no-restricted-imports` and at runtime via `server-only` /
`client-only` packages. Run `bun run audit:bundle` after a build to
confirm nothing server-only leaked into the client chunks.

## Where to go next

| If you want to… | Read |
|---|---|
| Set up local Supabase end-to-end | [`docs/SUPABASE_LOCAL.md`](docs/SUPABASE_LOCAL.md) |
| Deploy against hosted Supabase | [`docs/SUPABASE_SETUP.md`](docs/SUPABASE_SETUP.md) |
| Understand the API contract | [`docs/API.md`](docs/API.md) |
| See the roadmap + open ideas | [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md) |
| Read a plan doc (one per major feature) | `docs/PLAN-*.md` |
| Pick up where the last agent left off | [`docs/HANDOFF.md`](docs/HANDOFF.md) |
| Read the user manual | [`docs/user-manual/index.md`](docs/user-manual/index.md) |

Project-level conventions and tech-stack details: [`CLAUDE.md`](CLAUDE.md).
