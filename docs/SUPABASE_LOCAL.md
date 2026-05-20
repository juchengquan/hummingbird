# Local Supabase setup

Run the entire Supabase stack on your machine via the Supabase CLI
(Postgres + Auth + Storage + Studio + Inbucket email sink) instead of a
hosted project. Useful for offline development, faster iteration, no
shared dev database, and full schema resets in seconds.

This is the companion to [`docs/SUPABASE_SETUP.md`](./SUPABASE_SETUP.md) —
that one covers the hosted-cloud path; this one covers local. The app
code is identical for both — only env vars differ.

**~10 minutes** once Docker is installed.

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

- All three migrations (`supabase/migrations/0001_schema.sql`,
  `0002_rls_policies.sql`, `0003_storage.sql`) apply identically
- Magic-link auth via local **Inbucket** (no real inbox needed —
  emails are captured at http://localhost:54324)
- File uploads to the local `user-files` Storage bucket
- Share links via the local service-role key
- All RLS policies — RLS is plain Postgres, not Supabase-cloud-specific

## Prerequisites

- **Docker** — Desktop on macOS / Windows, Engine on Linux. Verify with
  `docker info`. The stack uses ~2 GB RAM idle.
- **Supabase CLI** — installation options:
  ```bash
  brew install supabase/tap/supabase   # macOS / Linuxbrew
  npx -y supabase --version            # any platform via npx (slower)
  scoop install supabase                # Windows
  ```
  See https://supabase.com/docs/guides/cli/getting-started for other
  options. Verify with `supabase --version`.

## Step 1 — Initialize the project

From the repo root:

```bash
supabase init
```

This creates `supabase/config.toml` (already gitignored from
`supabase/.gitignore` if it exists; if not, add it). The migrations
under `supabase/migrations/` are discovered automatically — no
moving needed.

If `supabase init` complains that the directory is non-empty (it sees
the existing `migrations/` folder), pass `--workdir .` or accept the
prompt — it will leave existing files alone and only add `config.toml`
and a `.gitignore`.

## Step 2 — Boot the stack

```bash
supabase start
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

## Step 3 — Env vars

In repo root:

```bash
cp .env.example .env.local   # if you don't have one yet
```

Set these three lines in `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the anon key printed by supabase start>
SUPABASE_SERVICE_ROLE_KEY=<the service_role key printed by supabase start>
```

Leave the other vars (`AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`,
`NEXT_PUBLIC_API_BASE_URL`) as they are — local Supabase doesn't affect
them.

Restart `bun dev` so Next.js picks the new env vars up.

> **Tip** — the local anon and service-role keys are *deterministic*:
> the CLI signs them with a well-known dev JWT secret. They never
> change across machines or `supabase start` runs, so you can check
> them into `.env.local.local` (not `.env.local`!) and reuse forever.
> Just **never commit them anywhere a production stack might see** —
> they're worthless in production but they look like real keys.

## Step 4 — Verify

With Supabase running and `bun dev` up:

1. **Studio loads** — open http://localhost:54323. You should see nine
   tables under the `public` schema (`profiles`, `workspaces`,
   `conversations`, `messages`, `files`, `resources`, `artifacts`,
   `notes`, `shares`) and a `user-files` private bucket under Storage.
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
