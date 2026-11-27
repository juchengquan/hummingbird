<!-- pages-for: env:AI_GATEWAY_API_KEY, env:NEXT_PUBLIC_SUPABASE_URL, env:NEXT_PUBLIC_SUPABASE_ANON_KEY -->
<!-- related: README.md, docs/SUPABASE_LOCAL.md, docs/SUPABASE_SETUP.md, package.json -->

# Installation

## What it is
The two paths to get Hummingbird running locally. Both run the
frontend (`bun dev`) and the agent service (agent-py, the one
backend - every AI and API call goes to it), but differ in whether
you bring up Supabase.

## Path A - Quick start (no backend)

Runs everything in `localStorage`. No Supabase, no sign-in, no
multi-device sync. Fastest path; full app minus auth + sync.

```bash
bun install
cp .env.example .env
# Leave Supabase vars blank. Set at minimum:
#   NEXT_PUBLIC_AGENT_PY_URL=/
#   a model provider key for agent-py, e.g. ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY
bun dev                            # the frontend on :3000
docker compose up proxy agent-py   # agent-py + a same-origin proxy on :8080
```

Open <http://localhost:8080>. Without `NEXT_PUBLIC_AGENT_PY_URL` the
app shows "This deploy has no backend configured". Without a model
provider key the chat loads but says "No model provider is configured
on this deploy" and sending is blocked - there is no mock answer.

## Path B - With local Supabase

Unlocks sign-in, file persistence, background tasks, and the MCP
cloud-mode credential lane. Two sub-paths:

```bash
# Sub-path B1 - Supabase CLI (recommended; needs `supabase` + Docker)
bun run supabase:start
cat .docker/supabase/dev-keys.txt        # paste into .env
bun dev

# Sub-path B2 - Docker only (no CLI; uses docker-compose.supabase.yml)
bun run supabase:docker:up
bun run supabase:docker:migrate
cat .docker/supabase/dev-keys.txt        # paste into .env
bun dev
```

Run agent-py as in Path A (`docker compose up proxy agent-py`); with
`SUPABASE_DB_URL` set and `WORKER_DRY_RUN=false` it also runs
background and scheduled tasks.

Verify: open Studio at <http://localhost:54323>; magic-link emails
land in the local inbox at <http://localhost:54324> (Mailpit with
the CLI, Inbucket with docker-compose).

## Requirements

- **Bun** - package manager + dev runtime. >= 1.1.
- **Docker** - only for Path B. The Supabase CLI itself is a thin
  wrapper around Docker.
- **Node.js** - not used. Bun handles everything.
- **Disk** - the Supabase Docker images are ~5GB.

## Tips & gotchas
- agent-py reads `.env` at the repo root, and so does Next.js
  (`.env.local`, if present, overrides it for Next.js only). One shared
  file is split per app in a later release.
- If you flip between Path A and Path B, `localStorage` and Supabase
  data are independent. They're not merged; you pick one.

## Related
- [Environment variables](21-environment-variables.md)
- [Supabase setup](22-supabase-setup.md)
- [Troubleshooting](26-troubleshooting.md)
