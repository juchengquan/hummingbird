# Hummingbird

A multi-panel chat assistant: streaming chat with tool calls, a Plate.js
rich-text editor, per-conversation file attachments, MCP (Model Context
Protocol) server integration, and optional Supabase-backed multi-device
sync. Next.js 16 + React 19 + Bun. Local-first by default; signing in
unlocks cloud sync without changing the offline UX.

## Quick start (no backend)

The fastest path — runs everything in `localStorage`, no Supabase
needed. You get the full app minus multi-device sync and email
magic-link auth.

```bash
bun install
cp .env.example .env.local         # leave Supabase vars blank
bun dev                             # → http://localhost:3000
```

Set **at minimum** in `.env.local`:

```bash
AI_GATEWAY_API_KEY=<your Vercel AI Gateway key>
```

Without `AI_GATEWAY_API_KEY` the chat panel still loads, but every
turn falls back to a clearly-labeled mock response so you can verify
UI without spending tokens.

## Quick start (with local Supabase)

Unlocks email magic-link sign-in, file persistence, and the MCP
cloud-mode credential lane. Two paths — both detailed in
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

Verify the stack: open Studio at <http://localhost:54323>; magic-link
emails land in Inbucket at <http://localhost:54324>.

## Environment variables

See [`.env.example`](.env.example) for the canonical list with
descriptions. Quick reference:

| Variable | When | Why |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Always (for real AI) | Streams chat / editor model calls |
| `NEXT_PUBLIC_SUPABASE_URL` | Only with Supabase | Browser client target |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Only with Supabase | Browser client auth |
| `SUPABASE_SERVICE_ROLE_KEY` | Only for share links | Server-side admin access |
| `TAVILY_API_KEY` | Only for web search | Tavily-backed `webSearch` tool |
| `MCP_ENCRYPTION_KEY` | Only for cloud-mode MCP creds | pgcrypto symmetric key (32+ chars). Generate with `openssl rand -base64 32` |
| `NEXT_PUBLIC_API_BASE_URL` | Only for split-backend | Points API client at a non-default origin |

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

- **`app/`** — Next.js App Router pages + route handlers. `app/api/*`
  is the backend surface (chat, MCP proxy, file extraction, share
  links, summarize).
- **`components/panels/`** — Main content (chat, editor, resources).
- **`components/sidebars/`** — Sliding sidebars (workspaces, chat
  list, resources rail).
- **`lib/client/`** — Browser-only (Zustand store, hooks, API client,
  IndexedDB helpers). Fenced via `import "client-only"`.
- **`lib/server/`** — Node-only (route helpers, Supabase server
  client, MCP SDK wrapper, encryption helpers). Fenced via `import
  "server-only"`.
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
