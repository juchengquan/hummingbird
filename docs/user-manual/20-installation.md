<!-- pages-for: env:AI_GATEWAY_API_KEY, env:NEXT_PUBLIC_SUPABASE_URL, env:NEXT_PUBLIC_SUPABASE_ANON_KEY -->
<!-- related: README.md, docs/SUPABASE_LOCAL.md, docs/SUPABASE_SETUP.md, package.json -->

# Installation

## What it is
The two paths to get Hummingbird running locally. Both end at the
same place - a working `bun dev` on `http://localhost:3000` - but
differ in how much of the backend stack you bring up.

## Path A - Quick start (no backend)

Runs everything in `localStorage`. No Supabase, no sign-in, no
multi-device sync. Fastest path; full app minus auth + sync.

```bash
bun install
cp .env.example .env.local
# Leave Supabase vars blank. Set at minimum:
#   AI_GATEWAY_API_KEY=<your Vercel AI Gateway key>
bun dev
```

Open <http://localhost:3000>. Without `AI_GATEWAY_API_KEY` the chat
panel still loads; every turn falls back to a clearly-labeled mock
response.

## Path B - With local Supabase

Unlocks email magic-link sign-in, file persistence, and the MCP
cloud-mode credential lane. Two sub-paths:

```bash
# Sub-path B1 - Supabase CLI (recommended; needs `supabase` + Docker)
bun run supabase:start
cat .docker/supabase/dev-keys.txt        # paste into .env.local
bun dev

# Sub-path B2 - Docker only (no CLI; uses docker-compose.supabase.yml)
bun run supabase:docker:up
bun run supabase:docker:migrate
cat .docker/supabase/dev-keys.txt        # paste into .env.local
bun dev
```

Verify: open Studio at <http://localhost:54323>; magic-link emails
land in Inbucket at <http://localhost:54324>.

## Requirements

- **Bun** - package manager + dev runtime. >= 1.1.
- **Docker** - only for Path B. The Supabase CLI itself is a thin
  wrapper around Docker.
- **Node.js** - not used. Bun handles everything.
- **Disk** - the Supabase Docker images are ~5GB.

## Tips & gotchas
- Always copy `.env.example` to `.env.local` (NOT `.env`) - the
  Next.js convention is to load `.env.local` last so it overrides
  the tracked defaults.
- If you flip between Path A and Path B, `localStorage` and Supabase
  data are independent. They're not merged; you pick one.

## Related
- [Environment variables](21-environment-variables.md)
- [Supabase setup](22-supabase-setup.md)
- [Troubleshooting](26-troubleshooting.md)
