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
cp apps/web/.env.example apps/web/.env
cp services/agent-py/.env.example services/agent-py/.env
# Leave Supabase vars blank. Set at minimum:
#   NEXT_PUBLIC_AGENT_PY_URL=/   in apps/web/.env
#   a model provider key, e.g. ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY,
#   in services/agent-py/.env
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
cat .docker/supabase/dev-keys.txt        # NEXT_PUBLIC_* -> apps/web/.env, the rest -> services/agent-py/.env
bun dev

# Sub-path B2 - Docker only (no CLI; uses docker-compose.supabase.yml)
bun run supabase:docker:up
bun run supabase:docker:migrate
cat .docker/supabase/dev-keys.txt        # NEXT_PUBLIC_* -> apps/web/.env, the rest -> services/agent-py/.env
bun dev
```

Run agent-py as in Path A (`docker compose up proxy agent-py`); with
`SUPABASE_DB_URL` set and `WORKER_DRY_RUN=false` (in
`services/agent-py/.env`) it also runs
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
- Each app has its own file: the frontend reads `apps/web/.env`
  (`apps/web/.env.local`, if present, overrides it), agent-py reads
  `services/agent-py/.env`. A `.env` or `.env.local` at the repo root is
  not read, and both refuse to start while one exists.
- Upgrading from one root `.env`? Run `bun run env:split`. It writes
  `apps/web/.env` and `services/agent-py/.env` from it, refuses to
  overwrite either, and prints only key names. Check both files, then
  remove the root one.
- If you flip between Path A and Path B, `localStorage` and Supabase
  data are independent. They're not merged; you pick one.

## Related
- [Environment variables](21-environment-variables.md)
- [Supabase setup](22-supabase-setup.md)
- [Troubleshooting](26-troubleshooting.md)
