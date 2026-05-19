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

Nine SQL files live in the repo under `supabase/migrations/`. Run
them in numerical order via the **SQL Editor** in the Supabase
dashboard (left sidebar → **SQL Editor** → **New query**).

For each file, paste the entire contents, click **Run**, confirm no
errors:

1. `supabase/migrations/0001_initial_schema.sql`
   - Creates: `profiles`, `workspaces`, `conversations`, `messages`,
     `files`, `resources` + indexes.
2. `supabase/migrations/0002_conversation_assets.sql`
   - Creates: `artifacts`, `notes` + indexes.
3. `supabase/migrations/0003_rls_policies.sql`
   - Enables row-level security on every table, creates "own row"
     policies, installs the `on_auth_user_created` trigger that
     auto-creates a profile when someone signs up.
4. `supabase/migrations/0004_runtime_metadata.sql`
   - Adds the runtime metadata columns the sync layer needs:
     message `reasoning` / `error` / `attached_file_ids` /
     `suggestions`; file extraction columns (`extraction_status`,
     `extracted_text`, `extracted_kind`, `image_data_url`,
     `summary`, `key_topics`); workspace `system_prompt`.
5. `supabase/migrations/0005_shares.sql`
   - Adds the `shares` table backing the public share-link routes,
     plus its RLS policy ("own shares").
6. `supabase/migrations/0006_skills.sql`
   - Adds `skill_prefs jsonb` columns to `workspaces` and
     `conversations` for the Skills cascade.
7. `supabase/migrations/0007_message_reasoning_duration.sql`
   - Adds `messages.reasoning_duration_ms` so the "Thought for X.X s"
     badge in the reasoning block survives reload.
8. `supabase/migrations/0008_message_tool_calls.sql`
   - Adds `messages.tool_calls jsonb` for first-class tool-call
     persistence (web-search pills survive reload as structured
     records rather than markdown footers in the message text).
9. `supabase/migrations/0009_conversation_lineage.sql`
   - Adds `conversations.parent_id` + `conversations.forked_from_message_id`
     so the Branches dialog can render a fork tree. `on delete set
     null` on both so deleted ancestors don't cascade away children.

After running all eight, sanity-check from the **Table Editor**: ten
tables should be listed (`profiles`, `workspaces`, `conversations`,
`messages`, `files`, `resources`, `artifacts`, `notes`, `shares`), each
showing the RLS shield icon indicating policies are active.

## Step 3 — Set up the storage bucket

`supabase/storage/policies.sql` creates the `user-files` bucket and the
per-user folder-prefix policies that scope reads/writes to
`user-files/{auth.uid()}/...`.

Run it in the SQL Editor exactly like the migrations above.

Verify in **Storage** (left sidebar) that the `user-files` bucket
exists and shows "Private bucket" with policies attached.

## Step 4 — Configure auth (magic link)

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

## Step 5 — Set env vars in `.env.local`

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

## Step 6 — Verify

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
  `supabase/storage/policies.sql` ran without errors

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

If you'd rather run Supabase locally instead of using cloud, the
**Supabase CLI** can bring up a complete stack via Docker:

```bash
brew install supabase/tap/supabase
supabase init
supabase start
```

This boots Postgres + Auth + Storage + Studio at `localhost:54321` /
`localhost:54323` with deterministic anon/service-role keys you can
use in `.env.local`. The migrations under `supabase/migrations/`
auto-apply.

Trade-off: faster iteration, but you can't test multi-device sync
without exposing the local stack. Recommend starting with the cloud
path above and switching to local later if you find yourself wanting
faster reset cycles.

## Re-running on an existing project

Every migration is idempotent (`create table if not exists`,
`add column if not exists`, etc.) so you can re-run all six against an
already-provisioned project without dropping anything. New migrations
(when added) just need to be run once; older ones become no-ops.
