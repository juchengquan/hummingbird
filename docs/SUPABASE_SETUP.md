# Supabase setup guide

Once-through setup for cloud sync, sharing, and the Skills system. The
codebase already ships the migrations, RLS policies, auth UI, sync
layer, and route handlers; this guide walks the manual steps that have
to happen on Supabase's side. **15-30 minutes** end to end.

## What this enables

All of the cloud-backed features. Most of it is wired up and waiting on
env vars:

- **Cross-device sync** of workspaces, conversations, messages, files,
  resources, notes, artifacts, **per-workspace and per-conversation skill
  preferences**, and the per-conversation editor document
- **Magic-link sign-in** (`components/auth/auth-dialog.tsx`) — currently
  hidden when env vars are absent
- **First-sign-in reconciliation** — uploads local state to cloud on
  empty accounts; prompts to merge or replace when there's already cloud
  data
- **File uploads to Supabase Storage** (`hooks/use-upload-file.ts`,
  `lib/files/persist.ts`) — replaces the old UploadThing path
- **Public share links** for conversations and per-conversation editor
  docs (`/share/conversation/[token]`, `/share/document/[token]`) via
  the service-role admin client
- **Skills cascade** — per-workspace default + per-conversation override
  for opt-in capabilities like Web Search; per-message mute is
  client-side only
- **Cross-device durable chat polish** — the reasoning-duration badge
  ("Thought for X.X s") and the tool-call pills (e.g. "Searched the
  web · 5 results") render the same on every device once their
  migrations are applied

The app keeps working anonymously without any of this — every Supabase
integration falls back gracefully when env vars are absent.

## Prerequisites

- A Supabase account (free tier is fine for development)
- A working email address for magic-link testing
- About 15-30 minutes
- _Optional_ — a Tavily API key for Web Search (free tier at
  https://tavily.com)

---

## Step 1 — Create the Supabase project

1. Go to https://supabase.com/dashboard, sign in, click **New project**.
2. Pick an org (or create one), name the project (e.g. `hummingbird-dev`),
   set a database password (save it — you won't need it for the app's
   runtime, but it's used for direct Postgres access).
3. Pick a region geographically close to you.
4. Free tier plan. Click **Create new project** and wait ~2 minutes
   for provisioning.

When provisioning finishes, the dashboard lands on your project. Keep
this tab open — the next steps use it.

## Step 2 — Run the schema migrations

Three SQL files live in the repo under `supabase/migrations/`. Run
them in numerical order via the **SQL Editor** in the Supabase
dashboard (left sidebar → **SQL Editor** → **New query**).

For each file, paste the entire contents, click **Run**, confirm no
errors:

1. `supabase/migrations/0001_schema.sql`
   - Every table in its final shape: `profiles`, `workspaces`,
     `conversations`, `messages`, `files`, `resources`, `artifacts`,
     `notes`, `shares`. Includes all columns the app uses today:
     workspace `system_prompt` / `skill_prefs` / `default_model` /
     `position`; conversation `document_content` / `skill_prefs` /
     fork lineage; message `reasoning` / `reasoning_duration_ms` /
     `error` / `attached_file_ids` / `suggestions` / `tool_calls`;
     file extraction columns; workspace-scoped notes / artifacts
     with nullable `conversation_id`.
2. `supabase/migrations/0002_rls_policies.sql`
   - Enables row-level security on every table, creates "own row"
     policies (one per table), installs the `on_auth_user_created`
     trigger that auto-creates a profile when someone signs up.
3. `supabase/migrations/0003_storage.sql`
   - Creates the private `user-files` Storage bucket and the per-user
     folder-prefix policies (read / write / update / delete are all
     scoped to `user-files/{auth.uid()}/...`).
4. `supabase/migrations/0004_conversation_files.sql`
   - Adds the `conversation_files` join table (conversation-private
     file attachments — files scoped to one chat that never enter the
     workspace library) plus its RLS policy, and a `deleted_at`
     column on `files` for soft-delete (tombstone) semantics.
5. `supabase/migrations/0005_mcp.sql`
   - Adds the MCP tables (`mcp_servers`, `mcp_resources`,
     `mcp_resource_bindings`, `conversation_mcp_resources`) with RLS,
     enables the `pgcrypto` extension, and creates two SECURITY
     DEFINER helpers (`mcp_get_decrypted_credentials`,
     `mcp_upsert_server_with_credentials`) that encrypt / decrypt
     cloud-mode credentials. The encryption key lives in the Next.js
     server env (`MCP_ENCRYPTION_KEY`), not in Postgres — see the
     "MCP encryption key" subsection below.
6. `supabase/migrations/0006_url_bookmarks.sql`
   - Adds the `url_bookmarks` and `conversation_url_bookmarks` tables
     (third source type after files and MCP resources) plus the
     `selected_url_bookmark_ids` column on `conversations`. Same RLS
     pattern, same workspace + conversation-private lane model. Page
     content is fetched + extracted server-side by `/api/url/fetch`
     at save time.

After running all six, sanity-check from the **Table Editor**:
sixteen tables should be listed (`profiles`, `workspaces`,
`conversations`, `messages`, `files`, `resources`, `conversation_files`,
`artifacts`, `notes`, `shares`, `mcp_servers`, `mcp_resources`,
`mcp_resource_bindings`, `conversation_mcp_resources`, `url_bookmarks`,
`conversation_url_bookmarks`), each showing
the RLS shield icon indicating policies are active. The **Storage**
sidebar should show a `user-files` private bucket with the four
policies attached.

### MCP encryption key

If you plan to let users pick Cloud-mode credentials for MCP servers,
set `MCP_ENCRYPTION_KEY` in your Next.js deployment's environment
(Vercel project secrets, Fly secrets, etc.). Generate with:

```bash
openssl rand -base64 32
```

The key is **never stored in Postgres**. It's passed as an argument
to the `mcp_*_credentials` RPCs on each call, which means:

- One env var rotates encryption across all environments (local,
  staging, prod) without touching the database.
- A read-only attacker who breaches Supabase sees ciphertext only;
  plaintext requires breaching the Next.js tier too.
- The trade-off: the key is *theoretically* visible in slow-query
  logs if `log_min_duration_statement = 0` and `pg_stat_statements`
  are both enabled. If your audit posture cares about this, switch
  to the session-setting pattern documented in
  `docs/PLAN-mcp-stage-3.md` — one-file change, no schema migration.

Leaving the key unset disables Cloud mode in the workspace settings
UI (the radio greys out). Local mode keeps working — credentials live
in the user's `localStorage`.

## Step 3 — Configure auth (magic link)

1. **Authentication** → **Providers** in the sidebar.
2. **Email** should already be enabled. Click into it:
   - **Enable Email provider** — on
   - **Confirm email** — your choice; for dev I'd leave it **off** so
     test sign-ins don't require email verification
   - **Enable email signup** — on
3. **Authentication** → **URL Configuration**:
   - **Site URL** → `http://localhost:3000` (and your production URL
     later)
   - **Redirect URLs** — add both:
     - `http://localhost:3000/auth/callback`
     - (production callback URL when you have one)

   The `auth/callback` route is implemented at
   `app/auth/callback/route.ts` and handles
   `supabase.auth.exchangeCodeForSession`.

4. **Authentication** → **Email Templates** (optional):
   - The default magic-link template works fine. You can customize
     branding here later. The reply-from address uses Supabase's
     shared SMTP by default — sufficient for dev but rate-limited; for
     real users wire up your own SMTP under **Settings** → **Auth**.

## Step 4 — Set env vars in `.env.local`

1. **Settings** → **API** in the dashboard.
2. Copy these values:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`
     - ⚠️ Server-only. Never expose to the browser. Used by the share
       link routes (`app/share/conversation/[token]/page.tsx`,
       `app/share/document/[token]/page.tsx`) via
       `lib/supabase/admin.ts` to resolve tokens with RLS bypassed.
3. In the repo root, create `.env.local` if it doesn't exist:
   ```bash
   cp .env.example .env.local
   ```
4. Paste the three values into the relevant lines. The other env vars
   in `.env.example`:
   - `AI_GATEWAY_API_KEY` — required for real chat AI (Vercel AI
     Gateway). Without it the chat panel falls back to a labeled mock
     response.
   - `TAVILY_API_KEY` — optional. Backs the **Web Search** skill at
     https://tavily.com (free tier covers dev use). Without it the
     Skills panel still surfaces Web Search but the chat route omits
     the tool and tells the model so it falls back to its training
     data instead of inventing a search call.
5. Restart `bun dev` so Next.js picks up the new env vars.

## Step 5 — Verify

After restart, with localStorage cleared so you're "anonymous":

1. Open http://localhost:3000/dashboard.
2. The sidebar header shows a **Sign in** button (`AccountMenu` renders
   nothing when Supabase is unconfigured; presence of the button means
   env vars resolved correctly).
3. Click it → enter your email → click **Send magic link**.
4. Within ~30 seconds you should receive an email from
   `noreply@mail.app.supabase.io` (or your custom domain if you set
   one up). Click the link.
5. You should land back on `/dashboard`, signed in. The sidebar header
   now shows your email instead of **Sign in**.
6. Run this query in the SQL Editor:
   ```sql
   select id, email, created_at from public.profiles;
   ```
   You should see one row — your account, auto-created by the
   `on_auth_user_created` trigger.

### Verify sync is running

7. Create a workspace and a conversation. Within a second or two:
   ```sql
   select id, name from public.workspaces where user_id = auth.uid();
   select id, title, skill_prefs from public.conversations where user_id = auth.uid();
   ```
   Both should show your rows. `skill_prefs` should be `{}` until you
   toggle something in the Skills panel.

### Verify file uploads

8. Drag a small PDF into the chat input. Check **Storage** → `user-files`
   → there should be a row at `{your-user-id}/{file-id}.pdf`. The same
   id appears in `public.files`:
   ```sql
   select id, name, storage_path, extracted_text is not null as extracted
   from public.files where user_id = auth.uid();
   ```

### Verify a share link

9. Open the conversation kebab menu → **Share…** → **Conversation** →
   **Create link**. Copy the URL and open it in a private window —
   it should render the messages read-only without requiring a session.

### Verify Web Search (if `TAVILY_API_KEY` is set)

10. Open the right activity bar → **Skills** → toggle Web search to
    "On for chat". Ask "what happened in the news today?". You should
    see a live **🌐 Searching the web for "…"** pill above the
    assistant response that resolves to **🌐 Searched the web · N
    results**. After the answer streams in, refresh the page — the
    pill should still be there (read from `messages.tool_calls`). The
    message body itself should be free of "_Searched the web: …_"
    footers; that footer was replaced by the durable column in `0008`.
    Click × on the chip above the input to pause web search for one
    send only; the chip greys out and Send resets the mute.

### Verify conversation forking

11. Hover an assistant message → click the **Branch from here** icon
    (GitBranch). A new conversation titled `<original> (branch)`
    appears at the top of the sidebar and becomes active, with the
    message history copied up to and including the branch point.
    The original conversation stays intact.

### Verify reasoning-duration badge (needs a reasoning-emitting model)

12. Switch to DeepSeek R1 (or any model that streams reasoning chunks).
    Send a non-trivial prompt. After the answer arrives, collapse the
    Reasoning block — the header should show "Reasoning · X.X s".
    Refresh — the badge should still be there (read from
    `messages.reasoning_duration_ms`).

If anything goes wrong:
- 401 / "unconfigured" toast → env vars not picked up; restart `bun dev`
- Magic link goes to spam → Supabase's default SMTP is heavily
  greylisted; either whitelist the sender or configure your own SMTP
- Redirect loop → `Site URL` and `Redirect URLs` aren't both set
  correctly under Auth → URL Configuration
- Share link 404 → confirm `SUPABASE_SERVICE_ROLE_KEY` is set; without
  it the admin client falls back to null and shares can't be resolved
- Files upload but never appear in Storage → check that the
  `user-files` bucket exists and the policies from
  `supabase/migrations/0003_storage.sql` ran without errors

## Local-mode escape hatch

Users can opt out of cloud sync from the AccountMenu popover even when
Supabase is configured:

- **Use local only** — pauses the sync queue entirely. Useful on shared
  machines or when you want to scope a session to one device.
- **Store files locally** — keeps raw file blobs in IndexedDB only; the
  extracted text still syncs but the underlying blob doesn't touch
  Supabase Storage. Useful when you want to stay under storage quotas.

Both toggles persist across reloads.

## Production setup (later)

When you're ready to deploy to a real environment:

- Create a second Supabase project for production, run the same
  migrations against it.
- Add the production URL to the **Redirect URLs** allow-list under
  Auth → URL Configuration.
- Set every env var in your deployment platform's config (Vercel
  project settings, etc.):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `AI_GATEWAY_API_KEY`
  - `TAVILY_API_KEY` _(optional)_
- Configure custom SMTP under **Settings** → **Auth** if magic-link
  delivery matters at scale.
- Periodic backups: enabled by default on free tier (point-in-time
  recovery is paid).

## Local-only alternative (advanced)

If you'd rather run Supabase locally — for offline development,
instant schema resets, or to avoid a shared cloud DB — see
[`docs/SUPABASE_LOCAL.md`](./SUPABASE_LOCAL.md). It walks the Supabase
CLI path end-to-end (~10 min once Docker is installed). The migrations
under `supabase/migrations/` are reused as-is; only the env vars
change.

Trade-off: local is faster to iterate against but can't be used to
test multi-device sync against an external reviewer. Many teams keep
both `.env.local.cloud` and `.env.local.local` and symlink whichever
they want.

## Re-running against an existing project

The three migration files describe the schema's **final shape** — they
are not incremental. To run them against a project that already has
tables from an older version of this codebase, you have to **reset the
public schema first** (otherwise `create table` collides). In the SQL
Editor:

```sql
drop schema public cascade;
create schema public;
grant usage on schema public to anon, authenticated;
grant all on schema public to postgres, service_role;
```

Then run `0001_schema.sql` → `0002_rls_policies.sql` → `0003_storage.sql`
in order. The Storage bucket and its policies survive the schema drop
(they live in the `storage` schema), so `0003_storage.sql` uses
`on conflict do nothing` and `create policy` may error with "already
exists" — drop the four `user-files: own folder ...` policies from
the **Storage → Policies** UI before re-running if you hit that.

This is a deliberate trade-off: the consolidated schema is much easier
to read and modify, but the cost is that re-applying it requires a
reset. For a pre-launch / solo-dev project this is fine; for shared
environments, freeze the schema before migrating new collaborators.
