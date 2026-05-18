# Supabase setup guide

Once-through setup to unlock the cloud-sync work waiting on
`claude/dev-followups`. The codebase ships migrations + RLS + auth UI;
this guide walks the manual steps that have to happen on Supabase's
side. **15-30 minutes** end to end.

## What this enables

Everything currently blocked on having a Supabase project:

- Cloud sync of workspaces, conversations, messages, files, resources,
  notes, and artifacts (sync layer)
- Magic-link sign-in across devices (already wired up in
  `components/auth/auth-dialog.tsx` — currently hidden because the env
  vars are absent)
- First-sign-in reconciliation (upload local state to cloud or
  reconcile with existing cloud rows)
- Signed-in file uploads to Supabase Storage instead of UploadThing
  (lifts the 2 MB image cap currently baked into localStorage)
- Eventually: real-time multi-device sync + share links

The app keeps working anonymously without any of this — Supabase is
strictly additive.

## Prerequisites

- A Supabase account (free tier is fine for development)
- A working email address for magic-link testing
- About 15-30 minutes

---

## Step 1 — Create the Supabase project

1. Go to https://supabase.com/dashboard, sign in, click **New project**.
2. Pick an org (or create one), name the project (e.g. `hummingbird-dev`),
   set a database password (save it somewhere — you won't need it for
   the app's runtime, but it's used for direct Postgres access).
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

1. `supabase/migrations/0001_initial_schema.sql`
   - Creates: `profiles`, `workspaces`, `conversations`, `messages`,
     `files`, `resources` + indexes.
2. `supabase/migrations/0002_conversation_assets.sql`
   - Creates: `artifacts`, `notes` + indexes.
3. `supabase/migrations/0003_rls_policies.sql`
   - Enables row-level security on every table, creates "own row"
     policies, and installs the `on_auth_user_created` trigger that
     auto-creates a profile when someone signs up.

After running all three, sanity-check from the **Table Editor**:
all nine tables should be listed, each showing the RLS shield icon
indicating policies are active.

## Step 3 — Set up the storage bucket

File 4 — `supabase/storage/policies.sql` — creates the `user-files`
bucket and the per-user folder-prefix policies that scope reads/writes
to `user-files/{auth.uid()}/...`.

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
     - ⚠️ This one is **server-only**. Never expose it to the browser.
       The app code in `lib/supabase/client.ts` deliberately doesn't
       read it. The variable is reserved for the sync layer's
       server-side admin operations (e.g. reading another user's
       row to render a share link).
3. In the repo root, create `.env.local` if it doesn't exist:
   ```bash
   cp .env.example .env.local
   ```
4. Paste the three values into the relevant lines. Make sure
   `AI_GATEWAY_API_KEY` is also set if you want real chat AI to
   work (`.env.example` documents it).
5. Restart `bun dev` so Next.js picks up the new env vars.

## Step 6 — Verify

After restart, with localStorage cleared so you're "anonymous":

1. Open http://localhost:3000/dashboard.
2. The sidebar header now shows a **Sign in** button (`AccountMenu`
   renders nothing when Supabase is unconfigured; presence of the
   button is the signal that env vars resolved correctly).
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

If anything goes wrong:
- 401 / "unconfigured" toast → env vars not picked up; restart `bun dev`
- Magic link goes to spam → Supabase's default SMTP is heavily
  greylisted; either whitelist the sender or configure your own SMTP
- Redirect loop → `Site URL` and `Redirect URLs` aren't both set
  correctly under Auth → URL Configuration

## What I'll do once this is done

Tell me you're set up (or push `.env.local`'s `NEXT_PUBLIC_*` keys
into the dev environment) and I'll start work on the **sync layer**
on a fresh branch. The order is:

1. `lib/supabase/types.ts` — generated DB types via
   `bunx supabase gen types typescript`
2. `lib/sync/sync-queue.ts` — in-memory FIFO of `SyncOp` objects,
   persisted to localStorage under `hummingbird-sync-queue`, retries
   with exponential backoff, pauses when offline
3. `lib/sync/handlers.ts` — one handler per persisted mutator from
   the store (workspaces, conversations, messages, files, resources,
   notes, artifacts, document content, chat model)
4. `lib/hooks/use-sync.ts` — diff-based store observer that
   transforms changes into `SyncOp`s and feeds the queue
5. **First-sign-in reconciliation** — bulk-INSERT local state on
   empty cloud; AlertDialog choice on non-empty cloud
6. Signed-in file uploads via `supabase.storage.from('user-files')`
   in `hooks/use-upload-file.ts`

This is the heavy lift — probably 600+ lines across the layer.
Verification needs your real Supabase project so I can confirm rows
actually land and RLS holds. Without it I'd be coding blind.

## Production setup (later)

When you're ready to deploy to a real environment:

- Create a second Supabase project for production, run the same
  migrations against it.
- Add the production URL to the **Redirect URLs** allow-list under
  Auth → URL Configuration.
- Set the three `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` vars in your deployment platform's env
  config (Vercel project settings, etc.).
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
use in `.env.local`. The migrations under `supabase/migrations/` will
auto-apply.

Trade-off: faster iteration, but you can't test multi-device sync
without exposing the local stack. Recommend starting with the cloud
path above and switching to local later if you find yourself wanting
faster reset cycles.
