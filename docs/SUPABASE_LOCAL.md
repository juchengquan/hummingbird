# Local Supabase setup

Run the entire Supabase stack on your machine via the Supabase CLI
(Postgres + Auth + Storage + Studio + Inbucket email sink) instead of a
hosted project. Useful for offline development, faster iteration, no
shared dev database, and full schema resets in seconds.

This is the companion to [`docs/SUPABASE_SETUP.md`](./SUPABASE_SETUP.md) —
that one covers the hosted-cloud path; this one covers local. The app
code is identical for both — only env vars differ.

**~10 minutes** once Docker is installed.

## Quick start (TL;DR)

Pick one path. Both produce the same URLs and accept the same env vars.

### Path A — Supabase CLI

```bash
# One-time install (one of):
brew install supabase/tap/supabase       # macOS / Linuxbrew
npx -y supabase --version                # any platform via npx

# From repo root:
bun run supabase:start                   # boots stack + applies migrations
cat .docker/supabase/dev-keys.txt >> .env.local   # paste keys (edit dupes after)
bun dev                                  # → http://localhost:3000
```

### Path B — Standalone docker-compose (no CLI)

```bash
# From repo root:
bun run supabase:docker:up               # boot containers
bun run supabase:docker:migrate          # apply migrations (once after first up)
cat .docker/supabase/dev-keys.txt >> .env.local   # paste keys (edit dupes after)
bun dev                                  # → http://localhost:3000
```

### URLs (both paths)

| Service | URL |
|---|---|
| App (Next.js dev) | http://localhost:3000 |
| Supabase API | http://localhost:54321 |
| Studio (DB GUI) | http://localhost:54323 |
| Inbucket (catches magic-link emails) | http://localhost:54324 |
| Postgres | `postgres://postgres:postgres@localhost:54322/postgres` |

### Common follow-ups

```bash
# Stop everything (keeps data)
bun run supabase:stop                    # Path A
bun run supabase:docker:down             # Path B

# Wipe DB + replay migrations
bun run supabase:reset                   # Path A (fast, ~3s)
bun run supabase:docker:reset            # Path B (rebuilds containers, ~30s)

# Regenerate TypeScript types from the live schema
bun run supabase:types                   # Path A only
```

Detailed walkthrough below.

## When to use this vs. the cloud guide

| Choose **local** when… | Choose **cloud** (`SUPABASE_SETUP.md`) when… |
|---|---|
| Doing offline / commute development | Testing multi-device sync end-to-end |
| Iterating on schema changes (instant resets) | Sharing dev DB with teammates |
| Running E2E tests in CI without a shared DB | Verifying production email deliverability |
| Avoiding hosted free-tier rate limits | Preparing share links for an external reviewer |

Many teams keep both `.env.local.cloud` and `.env.local.local` and
symlink whichever they want — `.env.local` is gitignored, so you can
switch profiles without touching the repo.

## What works locally

Everything the app uses today. The codebase has zero hosted-only
dependencies (no Realtime, no Edge Functions, no managed-only features),
so every feature gated by `lib/shared/supabase/env.ts` lights up:

- All five migrations (`supabase/migrations/0001_schema.sql`,
  `0002_rls_policies.sql`, `0003_storage.sql`,
  `0004_conversation_files.sql`, `0005_mcp.sql`) apply identically.
  `0005_mcp.sql` enables `pgcrypto` itself — no separate extension
  toggle.
- **MCP integration** — full tools + resources + cloud-mode
  credentials. Set `MCP_ENCRYPTION_KEY` in `.env.local` to unlock
  the Cloud radio in the Add Server dialog. See **Step 5** below.
- Magic-link auth via local **Inbucket** (no real inbox needed —
  emails are captured at http://localhost:54324)
- File uploads to the local `user-files` Storage bucket
- Share links via the local service-role key
- All RLS policies — RLS is plain Postgres, not Supabase-cloud-specific

## Two paths — pick one

Both are pre-wired in the repo. Choose based on whether you want to
install the Supabase CLI:

| Path | Best for | Needs |
|---|---|---|
| **A. Supabase CLI** *(recommended)* | Local development, fast resets | `supabase` CLI + Docker |
| **B. Standalone docker-compose** | CI, environments where CLI install is painful | Docker only |

Both produce the same URLs (`:54321` API, `:54323` Studio, `:54324`
Inbucket, `:54322` Postgres) and the same deterministic dev keys, so
`.env.local` is identical for either.

## Prerequisites

- **Docker** — Desktop on macOS / Windows, Engine on Linux. Verify with
  `docker info`. The stack uses ~2 GB RAM idle.
- *(Path A only)* **Supabase CLI** — installation options:
  ```bash
  brew install supabase/tap/supabase   # macOS / Linuxbrew
  npx -y supabase --version            # any platform via npx (slower)
  scoop install supabase                # Windows
  ```
  See https://supabase.com/docs/guides/cli/getting-started for other
  options. Verify with `supabase --version`.

---

## Path A — Supabase CLI

### Step 1 — Initialize

`supabase/config.toml` is already committed in this repo, so no
`supabase init` step. The migrations under `supabase/migrations/` are
discovered automatically.

### Step 2 — Boot the stack

```bash
bun run supabase:start    # alias for `supabase start`
```

First run pulls the Docker images (~1 GB, a few minutes). Subsequent
boots take ~30 s. On success it prints something like:

```
         API URL: http://localhost:54321
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
    Inbucket URL: http://localhost:54324
        anon key: eyJhbGc…(long string)
service_role key: eyJhbGc…(long string)
```

Keep this output — you'll paste three of these into `.env.local` next.

The migrations under `supabase/migrations/` apply automatically on
`supabase start` (and on every `supabase db reset`). No manual SQL
Editor step.

### Step 3 — Env vars

In repo root:

```bash
cp .env.example .env.local   # if you don't have one yet
```

Set these three lines in `.env.local` (copy values from the `supabase
start` output or from `.docker/supabase/dev-keys.txt` — they're identical):

```bash
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<see .docker/supabase/dev-keys.txt>
SUPABASE_SERVICE_ROLE_KEY=<see .docker/supabase/dev-keys.txt>
```

Leave the other vars (`AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`,
`NEXT_PUBLIC_API_BASE_URL`) as they are — local Supabase doesn't affect
them.

Restart `bun dev` so Next.js picks the new env vars up.

> **Tip** — the local anon and service-role keys are *deterministic*
> JWTs signed with the well-known dev secret. They never change across
> machines or `supabase start` runs and are pre-committed in
> `.docker/supabase/dev-keys.txt` for reference. Worthless against any
> real Supabase project, but never paste them into a production env.

---

## Path B — Standalone docker-compose

Use this when you don't want the Supabase CLI on the machine — e.g. CI
runners or contributors who already have Docker but nothing else. The
committed `docker-compose.supabase.yml` runs a subset of the same
services (no Realtime, no Edge Functions, no Analytics — none of which
this app uses anyway).

### Step 1 — Boot and migrate

```bash
bun run supabase:docker:up         # boot containers (~30 s first time)
bun run supabase:docker:migrate    # apply supabase/migrations/* (once)
```

Or do both atomically (also wipes existing volumes — destructive):

```bash
bun run supabase:docker:reset
```

### Step 2 — Env vars

```bash
cat .docker/supabase/dev-keys.txt    # copy these three lines into .env.local
```

Then `bun dev`.

### Path-B-specific operations

| Script | Effect |
|---|---|
| `bun run supabase:docker:up` | Start containers |
| `bun run supabase:docker:down` | Stop containers (keeps volumes) |
| `bun run supabase:docker:migrate` | Apply migrations to running stack |
| `bun run supabase:docker:reset` | Wipe volumes, recreate, re-migrate |

### Trade-offs vs Path A

| | Path A (CLI) | Path B (docker-compose) |
|---|---|---|
| Install cost | Docker + supabase CLI | Docker only |
| First boot | ~60 s | ~90 s |
| `db reset` | `bun run supabase:reset` (~3 s) | `bun run supabase:docker:reset` (~30 s) |
| Image-version maintenance | CLI tracks for you | Manual tag bumps in `docker-compose.supabase.yml` |
| Services included | Full Supabase stack | Postgres, Auth, REST, Storage, Studio, Inbucket (sufficient for this app) |
| CI-friendly | OK | Better (no extra binary) |

---

## Step 4 — Verify

(Applies to both paths once env vars are set and `bun dev` is up.)

With Supabase running and `bun dev` up:

1. **Studio loads** — open http://localhost:54323. You should see
   fourteen tables under the `public` schema (`profiles`,
   `workspaces`, `conversations`, `messages`, `files`, `resources`,
   `conversation_files`, `artifacts`, `notes`, `shares`,
   `mcp_servers`, `mcp_resources`, `mcp_resource_bindings`,
   `conversation_mcp_resources`) and a `user-files` private bucket
   under Storage.
2. **App talks to local Supabase** — open http://localhost:3000/dashboard.
   The sidebar header shows a **Sign in** button (it's hidden when env
   vars are absent; presence of the button confirms the local URL +
   anon key resolved).
3. **Magic-link sign-in via Inbucket**:
   - Click **Sign in**, enter any email (e.g. `me@local.test`), click
     **Send magic link**.
   - Open http://localhost:54324 — the email is waiting. Click the
     magic-link button inside it.
   - You land back on `/dashboard`, signed in. The sidebar now shows
     your email.
4. **Profile row created**:
   ```sql
   -- In Studio's SQL Editor (http://localhost:54323):
   select id, email from public.profiles;
   ```
   One row — your account, auto-inserted by the `on_auth_user_created`
   trigger from `0002_rls_policies.sql`.
5. **Sync writes land in Postgres** — create a workspace and a
   conversation in the app, then:
   ```sql
   select id, name from public.workspaces;
   select id, title from public.conversations;
   ```
6. **File upload roundtrips** — drag a small file into the chat input.
   In Studio → Storage → `user-files`, navigate to your user-id
   folder; the file is there. Also visible in `public.files`.
7. **Share link works** — open the conversation kebab menu →
   **Share…** → **Conversation** → **Create link**. Copy the URL,
   open it in a private window — read-only render with no session.

If anything above fails, check the **Common issues** section at the
bottom of this doc.

## Step 5 — MCP (optional)

Hummingbird supports Model Context Protocol servers as workspace-
scoped tooling. Two credential storage modes (see
`docs/PLAN-mcp-integration.md` for the full design):

- **Local mode** — credential lives in `localStorage` on this device,
  sent in the `X-MCP-Credentials` header on each call. Works without
  any backend setup; you can use it even with Supabase off.
- **Cloud mode** — credential encrypted in Supabase via `pgcrypto`,
  decrypted only inside a SECURITY DEFINER RPC. Syncs across
  devices. Requires you to be signed in **and** to have set
  `MCP_ENCRYPTION_KEY` in the Next.js server env.

### Enable cloud-mode MCP credentials locally

```bash
# Generate a key (32+ bytes random — pgcrypto uses it as a passphrase).
openssl rand -base64 32

# Add to .env.local
echo "MCP_ENCRYPTION_KEY=<paste the output above>" >> .env.local

# Restart Next.js so the env var is picked up.
# (kill `bun dev`, start it again — Next.js does not hot-reload env)
bun dev
```

Without the key:
- The **Cloud** radio in the "Add MCP server" dialog is greyed out
  with "Sign in to enable" (when signed out) or stays greyed even
  after sign-in (if the env var isn't set server-side).
- Local mode keeps working.

Rotating the key invalidates every existing cloud-mode credential —
users have to re-add the server. Don't change it without a clear
need.

### Smoke-test an MCP server

Most public HTTP-transport MCP servers work. Two options:

1. **Cloudflare's hosted MCP demo** —
   <https://github.com/cloudflare/agents-starter>. Spin it up on
   Workers (~3 min) and point the workspace at the resulting URL.
2. **Self-host a simple one** — e.g. the
   [`@modelcontextprotocol/server-everything`](https://github.com/modelcontextprotocol/servers/tree/main/src/everything)
   reference server behind a small Express wrapper that bridges
   stdio → HTTP. Useful for end-to-end tests because it exposes one
   tool of each MCP primitive.

Verification path inside the app:

1. Open the **workspace settings sheet** (gear icon next to the
   active workspace, or pick a workspace from the workspaces panel
   and open its detail).
2. Scroll to **MCP servers** → **Add**. Enter a name + the server
   URL + a bearer token if the server needs one + pick Local or
   Cloud mode.
3. On submit, the dialog runs discovery in the background and
   surfaces a toast: *"Connected to X. 3 tools, 5 resources."* If
   you see a 401/502, the URL or the token is wrong.
4. **Tool call** — start a new chat in that workspace, ask the model
   to call one of the tools (e.g. *"Search for X in this MCP
   server"*). A tool-call pill renders inline with the prefix
   `mcp__{serverId}__{toolName}`. Click to expand the result.
5. **Resource attach** — open the right resources sidebar, click the
   **Plug** icon to switch to the MCP tab. Click **+** in either
   "This conversation" or "Workspace MCP resources", pick a resource
   from the picker, then ask the model something that needs the
   resource. The system prompt now contains its content.

### Inspect cloud-mode encryption (advanced)

```sql
-- In Studio's SQL Editor, signed in as the same user that added
-- the server. RLS makes this invisible to other users.

-- Confirm the row has ciphertext, not plaintext:
select credential_mode, credentials_encrypted is not null as has_cipher,
       length(credentials_encrypted) as cipher_bytes
from public.mcp_servers;

-- Confirm decryption works through the SECURITY DEFINER function:
select public.mcp_get_decrypted_credentials(
  '<your server uuid>',
  '<paste your MCP_ENCRYPTION_KEY value>'
);
-- Returns the decrypted JSON credential.

-- Pass the wrong key → returns NULL (pgcrypto raises, function
-- swallows). Never throws so callers can degrade gracefully.
```

## Common operations

### Reset the database

Drops every table and replays all migrations under
`supabase/migrations/`. Use this when iterating on `0001_schema.sql`:

```bash
supabase db reset
```

You stay signed in (auth lives in the separate `auth` schema, which
the reset doesn't touch), but every workspace / conversation / file
is gone. Local Storage objects also stick around — clear them
manually in Studio if you want a fully blank slate.

### Stop the stack

```bash
supabase stop          # stops containers, keeps volumes
supabase stop --no-backup   # also wipes the local DB volume
```

### Apply a new migration without resetting

```bash
supabase migration up
```

Picks up any new `supabase/migrations/NNNN_*.sql` files since the last
run. Since the current setup ships *final-shape* migrations (not
incremental), `db reset` is the more common path.

### Generate fresh TypeScript types

```bash
supabase gen types typescript --local > lib/shared/supabase/types.ts
```

The Supabase plan in `docs/SUPABASE_SETUP.md` mentions this command;
the `--local` flag points it at your local stack instead of a remote
project.

### Inspect / edit data

Use Studio at http://localhost:54323 — it's a full-featured Postgres
GUI with SQL editor, table editor, auth users browser, and Storage
file browser. No login required (local only).

### Tail logs

```bash
supabase status        # shows what's running and where
docker logs supabase_db_humm           # Postgres logs
docker logs supabase_auth_humm         # GoTrue logs
docker logs supabase_storage_humm      # Storage logs
```

(Names vary slightly by CLI version — `docker ps` lists them.)

## Switching between local and cloud

The cleanest pattern is two env files plus a symlink:

```bash
# One-time setup:
cp .env.local .env.local.cloud      # snapshot your existing cloud config
# … edit .env.local with local URLs / keys per Step 3 …
cp .env.local .env.local.local      # snapshot the local config

# Switching (re-run after either, then restart `bun dev`):
ln -sf .env.local.local .env.local   # → local stack
ln -sf .env.local.cloud .env.local   # → hosted project
```

Caveat: signing in to the local stack creates a user with a different
`auth.uid()` than your cloud user, so any data you synced to one will
not appear in the other. This is by design — they're separate DBs.

## Common issues

**"Failed to fetch" / app can't reach Supabase.**
Check `supabase status` — the container may have stopped. `supabase
start` again. If port `54321` is in use, edit `supabase/config.toml`
and bump the port (e.g. `api.port = 54331`); update
`NEXT_PUBLIC_SUPABASE_URL` to match.

**Magic-link email never arrives.**
It never arrives at your real inbox — local Inbucket captures
everything. Check http://localhost:54324. If Inbucket is empty, the
sign-in call likely failed before sending — check the browser console
and `docker logs supabase_auth_*`.

**"RLS denies this" on every query.**
You're calling Supabase without a session. The chat / workspace
flows assume `signIn()` has completed. Sign in via the auth dialog
first; the dashboard `AccountMenu` should show your email.

**`supabase start` fails: port already allocated.**
Another process holds one of the default ports (54321-54324). Either
free it (`lsof -i :54321`) or change ports in `supabase/config.toml`.

**Migration errors on a non-empty DB.**
The migrations in this repo describe the schema's *final shape*, not
deltas. `supabase db reset` is the supported reset path — it drops
the `public` schema before replaying. If you've made manual schema
tweaks via Studio that you want to keep, dump them with
`supabase db dump --data-only > before-reset.sql` first.

## How this differs from the cloud path

| Step in `SUPABASE_SETUP.md` | Local equivalent |
|---|---|
| Create Supabase project in dashboard | `supabase init && supabase start` |
| Paste 3 migration files in SQL Editor | Auto-applied by `supabase start` |
| Configure auth provider + redirect URLs | Defaults in `config.toml` already match `/auth/callback` |
| Copy URL + anon + service-role keys from dashboard | Printed by `supabase start` (deterministic) |
| Set `Site URL` to your domain | Already `http://localhost:3000` by default |
| Use real email inbox for magic link | Inbucket at http://localhost:54324 |
| Cloud Studio (per-project dashboard) | Local Studio at http://localhost:54323 |

Everything in the app — `lib/client/supabase/client.ts`,
`lib/server/supabase/{server,admin}.ts`, the sync layer, the share
routes, the file upload hook — is unchanged. The only difference is
which `NEXT_PUBLIC_SUPABASE_URL` resolves to.
