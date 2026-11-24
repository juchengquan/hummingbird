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
7. `supabase/migrations/0007_file_full_text.sql`
   - Adds the `full_text` column to `files` (alongside the existing
     truncated `extracted_text`) plus a `tsvector` generated column
     and GIN index that back Phase 3 of the file full-text retrieval
     plan (`docs/PLAN-file-full-text-retrieval.md`). English-stemmed
     today; per-document language detection is a later concern.
8. `supabase/migrations/0008_message_compression.sql`
   - Adds three columns to `messages` for the "Compress older messages"
     action: `compressed` (excluded from the next chat call when true),
     `kind` (null for normal messages, `'recap'` for synthetic
     summaries), and `recap_message_ids` (the original ids a recap
     replaced, so Undo knows what to restore). Idempotent — safe to
     re-run.
9. `supabase/migrations/0009_search_file_sections.sql`
   - Adds the `search_file_sections(p_file_id, p_query, …)`
     SECURITY INVOKER function that wraps Postgres `ts_headline`
     over `files.full_text` (added in 0007). Backs the
     `searchFiles` ServerSkill — see Phase 3 of the file full-text
     retrieval plan. Granted to `authenticated`.
10. `supabase/migrations/0010_message_generated_images.sql`
    - Adds `generated_images jsonb` to `messages` so the assistant's
      generated-image gallery (with storage paths + signed URLs)
      syncs across devices. Idempotent.
11. `supabase/migrations/0011_prompts.sql`
    - Creates the `prompts` table — user-scoped saved prompt
      templates with `{{variables}}`. Backs Phase 2 of the prompt
      library plan (`docs/_done/PLAN-prompt-library.md`); the in-Zustand
      store from Phase 1 (PR #50) now round-trips to Supabase.
      Soft-delete via `deleted_at`; unique `(user_id, slug)` on
      live rows. Idempotent.
12. `supabase/migrations/0012_tasks.sql`
    - Creates `tasks` + `task_events` — the long-running agent task
      runner's durable run header + append-only event log.
13. `supabase/migrations/0013_task_checkpoint.sql`
    - Adds the HITL checkpoint column for suspend/resume on agent tasks.
14. `supabase/migrations/0014_task_jobs.sql`
    - Creates the `task_jobs` queue table backing durable background
      execution (agent task queue, Phase 6).
15. `supabase/migrations/0015_workspace_canvas.sql`
    - Adds `canvas_state jsonb` to `workspaces` for the spatial
      canvas view.
16. `supabase/migrations/0016_project_mode.sql`
    - Adds `is_project` / `goal` / `milestones` to `workspaces` and
      creates the `project_tasks` Kanban-card table (links optionally to
      a `tasks` run + an `artifacts` deliverable). Backs project mode
      (`docs/PLAN-project-mode.md`). Idempotent.
17. `supabase/migrations/0017_prompts_workspace.sql`
    - Adds `workspace_id` to `prompts` (0011 created them user-scoped);
      prompts are now workspace-scoped like conversations and
      documents. Backfills every existing prompt to its owner's
      earliest workspace (a user with prompts but no workspace gets one
      new workspace named `Prompts` to hold them — nothing is deleted),
      then sets the column `not null`. Idempotent.
      (Renamed from a `0012` that collided with `0012_tasks`; see #80.)
18. Every later file (`0018_…` onward), in numerical order. Of note:
    - `supabase/migrations/0031_rls_fk_ownership.sql` — adds a
      RESTRICTIVE `<table>: fk ownership (insert|update)` RLS policy
      per user-data table so every foreign key (conversation, document,
      workspace, file, task, …) must point at a row the caller owns;
      also hardens `mcp_upsert_server_with_credentials` (workspace
      ownership check + correct local→cloud promotion). Creates a
      non-exposed `private` schema for one helper. Idempotent.

Later migrations (`0018_*` onward) apply the same way, in filename
order. Every migration has a unique numeric prefix (CI enforces this via
`bun run check:migrations`). Of note for the Python agent service:

- `supabase/migrations/0030_task_metadata.sql`
  - Adds `tasks.metadata jsonb not null default '{}'` — the audit
    column `services/agent-py` stamps `{"handler": "python"}` into.
    Idempotent.
- `supabase/migrations/0032_task_job_lease.sql`
  - Adds `task_jobs.lease_expires_at` (+ a partial index on running
    rows) — the worker lease. The claim sets it, the executing worker
    heartbeats it forward, settle/release clear it; an expired lease
    makes a stranded `running` job reclaimable (or reaped as failed
    once `max_attempts` is spent). Backfills rows already stranded
    `running`: only rows touched within the last hour are resumed; older
    ones are marked attempt-exhausted so the reaper fails them instead
    of re-running them. Idempotent.
- `supabase/migrations/0033_message_generated_files.sql`
  - `messages.generated_files` + the `file` artifact kind. Adds
    `artifacts_kind_check` `NOT VALID` (no table scan under the
    exclusive lock); `0037` validates it.
- `supabase/migrations/0034_task_write_hardening.sql`
  - Takes `tasks` / `task_jobs` writes away from PostgREST. `anon` /
    `authenticated` lose INSERT on `tasks` and INSERT/UPDATE/DELETE on
    `task_jobs`; `tasks` UPDATE is column-granted to `status`,
    `finished_at`, `updated_at`, and a trigger lets API callers only
    settle a live run as `cancelled` / `failed`. Adds two SECURITY
    DEFINER RPCs: `create_task_run` (queued run + initial checkpoint,
    conversation ownership, `max_steps` 1..50) and `enqueue_task_job`
    (pins status / attempts / `max_attempts`, clamps `scheduled_at`,
    validates action + payload, checks ownership, task state and a
    20-queued-jobs-per-user cap; the service role may enqueue for any
    task). Workers connect as the DSN role and are unaffected.
    Idempotent.
- `supabase/migrations/0035_task_schedule_limits.sql`
  - `task_schedules` column grants (`last_run_at` / `last_run_task_id`
    become dispatcher-only), plus a trigger for API callers: a coarse
    cron floor (five fields; minute field fires at most 12×/hour) and at
    most 20 enabled schedules per user. Idempotent.
- `supabase/migrations/0036_task_job_stale_lease_backfill.sql`
  - For databases that ran the original `0032` backfill: jobs still
    `running` on that backfill's exact lease and started more than a
    day ago are marked attempt-exhausted, so the reaper fails them
    rather than a worker re-running them. Idempotent.
- `supabase/migrations/0037_validate_artifacts_kind_check.sql`
  - `VALIDATE CONSTRAINT artifacts_kind_check` (doesn't block reads or
    writes). A no-op where `0033` already added it validated.
- `supabase/migrations/0038_mcp_pgcrypto_schema.sql`
  - The MCP credential RPCs called pgcrypto unqualified under a pinned
    `search_path = pg_catalog, public`; on Supabase pgcrypto lives in
    `extensions`, so cloud-mode credentials could not be saved or read.
    Adds `private.mcp_encrypt` / `private.mcp_decrypt`, whose bodies
    name pgcrypto's schema as looked up in `pg_extension` at migration
    time, and points both RPCs at them. Re-run it if pgcrypto is ever
    moved to another schema. Idempotent.
- `supabase/migrations/0039_mcp_upsert_foreign_id.sql`
  - `mcp_upsert_server_with_credentials` raises `23505`
    (`mcp_server_id_conflict`) when the server id belongs to another
    user instead of silently writing nothing, and `P0002` for a foreign
    workspace; `/api/mcp/server` answers 409 / 404. Idempotent.
- `supabase/migrations/0040_task_worker_liveness.sql`
  - `task_worker_active_within(p_seconds)` (SECURITY DEFINER, returns a
    boolean only): true when any task worker holds a live lease or
    finished a job in the window. The stale-run reconciler checks it
    before failing a never-started run as "No task worker available",
    so a busy worker's backlog isn't failed. Adds an index on
    `task_jobs(updated_at)`. Idempotent.
- `supabase/migrations/0041_runs_on_tasks.sql`
  - Runs on the task tables (`mode`, `thread_id`, `previous_run_id`,
    `outcome`, `lease_expires_at`) and the `create_run` RPC for the
    runs API (`/v1/runs`). Idempotent.
- `supabase/migrations/0042_one_live_resume.sql`
  - At most one live resume per interrupted run: a unique partial
    index on `tasks(previous_run_id)` over rows that are not `failed` /
    `cancelled`, and `create_run` raising 23505 'run already resumed'
    (constraint `tasks_one_live_resume`) for a second one — agent-py
    answers `409 run_already_resumed`. Idempotent.
- `supabase/migrations/0043_answer_once.sql`
  - A paused background task is answered one way only (Q41):
    `enqueue_task_job` refuses a `respond` job (55000 → the Next route's
    409) while a runs-API resume of the task is not failed / cancelled,
    and `create_run` refuses a resume of a task that has a `respond`
    job (55000 'run already answered' → agent-py's `409
    run_already_answered`), locking the task row so the two serialise.
    Same signatures. Idempotent. (0045 makes both checks per question.)
- `supabase/migrations/0044_message_turn_persona.sql`
  - `messages.turn_persona` (nullable JSONB): the persona a user message
    was sent as, so a resend keeps its MCP allow-list on every device
    (Q52). Without it messages still sync, but the record stays on the
    device that sent the turn. Idempotent.
- `supabase/migrations/0045_background_tasks_correct.sql`
  - Background tasks made correct (wave 5c, Q55–Q60): terminal is final,
    one winner per question (`tasks.answered_question_ids`,
    `tasks.answers_applied_at`), cancel as the whole task (`cancel_task`
    RPC), the sub-agent barrier in triggers, one lock order. Idempotent.
  - **Deploy order:** stop every agent-py → apply 0045 → start the new
    agent-py → deploy Next. An older agent-py must not run against it
    (it would also count the barrier down); an older Next app may. The
    new agent-py and Next app both need it.
  - **Existing rows** are repaired once (the file's header says what
    happens to each): tasks stuck on a second question work again, a
    cancel a pause overwrote is cancelled again, parents left waiting on
    ended sub-agents fail ("run it again"; migrating never starts a model
    call, Q62), never-queued runs older than an hour fail.
  - **Rollback:** the statements in the file's header.
- `supabase/migrations/0046_chat_answer_once.sql`
  - Chat on runs answers a question once (Q63): agent-py stamps an
    interactive resume's `answers_applied_at` before its answers take
    effect, and `create_run` refuses a later resume of the same paused
    run once that resume has ended (23505, constraint
    `tasks_answer_applied` → agent-py's `409 run_answer_applied`). A
    resume that ended before applying still frees the question. Deleting
    an applied interactive resume fails the run it answered. Background
    runs are untouched. Same `create_run` signature. Idempotent.
  - **Deploy order:** stop every agent-py → apply 0046 → start the new
    agent-py → deploy Next. An older agent-py against it maps the refusal
    to `409 run_id_conflict` and doesn't stamp its own resumes, so don't
    run one past it; an older Next app shows the refusal as an unknown
    error (nothing runs twice).
  - **Existing rows:** an interactive resume of a still-paused
    interactive run counts as applied unless its log shows its harness
    never started (entries all `status` / `result`); one with no log left
    (purged) counts as applied. No status or other column changes.
  - **Rollback:** the statements in the file's header.
- `supabase/migrations/0047_task_identity_and_caps.sql`
  - A task's identity, delivery mark and cap (wave 6: Q69, Q72, Q73,
    Q75, Q77, Q79). New `tasks` columns `root_run_id` (no FK; filled for
    every insert by the `tasks_identity` trigger), `research` and
    `result_delivered_at` (users can't write it; `mark_task_delivered`
    RPC); `task_run_is_current` / `task_current_run_id` (a task's current
    run); at most 5 active top-level tasks per user in `create_run` and
    `create_task_run` (54000 → `409 limit_reached`; answers exempt);
    `create_scheduled_task` for schedule fires (creates the task already
    failed `limit_reached` at the cap); a background answer a failed
    resume had applied is refused with constraint `tasks_answer_applied`
    (`409 run_answer_applied`). Same `create_run` / `create_task_run`
    signatures. Idempotent.
  - **Deploy order:** stop every agent-py → apply 0047 → start the new
    agent-py → deploy Next. An older agent-py answers the cap with a 500
    instead of `409 limit_reached`, and an older schedule dispatcher
    still inserts past the cap.
  - **Existing rows:** `root_run_id` is backfilled by walking
    `parent_task_id` / `previous_run_id` (a chain broken by a deleted run
    roots at its earliest reachable run), `research` from each
    checkpoint; no status, outcome or `updated_at` changes. A background
    task that has already ended is marked delivered (the old path wrote
    its result); one still live delivers once when it ends. **Every
    enabled schedule without a model is paused once** (`enabled = false`, Q73) — a re-run doesn't pause it again.
    A user who already has 5 or more active tasks can't start another
    until fewer are active.
  - **Rollback:** the statements in the file's header.
- `supabase/migrations/0048_task_read_flags.sql`
  - Reading a run without reading its checkpoint (wave 6; Q66). New
    generated column `tasks.awaiting_children` (the checkpoint's
    `awaiting_children` key, computed when the checkpoint is written);
    `task_run_is_current_by` / `task_current_run_id_by` — 0047's
    current-run rule over columns, since passing a whole `tasks` row to a
    function fetches its TOASTed checkpoint. 0047's row functions and the
    cap's count now call them. Idempotent.
  - **Deploy order:** stop every agent-py → apply 0048 (the column rewrites
    `tasks` under a brief exclusive lock) → start the new agent-py. An
    older agent-py or Next keeps working against it.
  - **Existing rows:** the column is computed for every row by the
    `add column`; nothing else changes.
  - **Rollback:** the statements in the file's header.
- `supabase/migrations/0049_subagent_exit_entry.sql`
  - A sub-agent run's end shows on its parent as it happens (wave 6):
    whatever ends it (the worker, its own cancel, the reconciler) writes a
    `handoff` `exit` entry naming it on its parent's log, from the
    `tasks_ended` trigger, while the parent waits on its sub-agents. Before,
    the parent's stream closed them only when the parent ended.
  - **Deploy order:** migrate first, then deploy agent-py. An agent-py
    from before this can, when a fan-in's seq probe fails, write a seq an
    exit entry already took ("a step closed twice"); the new agent-py
    abandons that fan-in instead.
  - **Existing rows:** nothing changes.
  - **Rollback:** the statements in the file's header.
- `supabase/migrations/0050_task_refusal_hints.sql`
  - A task write refused at a limit (54000) names it in the error's hint
    (wave 7, Q88): `task_cap` (5 active tasks) or `job_queue` (20 queued
    jobs); Next and agent-py show the same sentence for each.
    `private.task_waits_on` reads 0048's `awaiting_children` column, not
    the checkpoint (Q90).
  - **Deploy order:** any; an older Next or agent-py sees the same
    SQLSTATE and message as before.
  - **Existing rows:** nothing changes.
  - **Rollback:** the four functions' definitions from 0047 and 0045.

### Migration 0018 collision (renamed to `0033_message_generated_files.sql`)

Two files used to share version `0018`: `0018_realtime_task_events.sql`
(the original) and `0018_message_generated_files.sql` (added later). The
Supabase CLI keys `supabase_migrations.schema_migrations` by the numeric
prefix, so the pair broke the CLI path: a fresh `supabase db reset` /
`supabase start` aborted on a duplicate-key error, and on a DB that had
recorded `0018` already, `supabase migration up` treated the second file
as applied and silently skipped it (no `messages.generated_files`
column). The SQL Editor path and `.docker/supabase/apply-migrations.sh`
run files by name and were unaffected.

The later file is now `0033_message_generated_files.sql`. It has no
ordering dependency on `0019`–`0031` and is fully idempotent
(`add column if not exists`; `drop constraint if exists` before
re-adding `artifacts_kind_check`), so:

- **SQL Editor / Docker path** — if you already ran the old `0018_message_generated_files.sql`,
  running `0033` again is a harmless no-op. Nothing else to do.
- **Supabase CLI path** — `supabase migration up` (or `db push`) applies
  `0033` like any new migration; on a DB that already has the column it
  is a no-op. No `migration repair` is required. If you previously
  hand-recorded the old file (e.g. `supabase migration repair --status
  applied 0018` after working around the collision), nothing changes:
  `0018` now refers only to `0018_realtime_task_events.sql`. To mark
  `0033` applied without running it (optional — running it is safe):
  `supabase migration repair --status applied 0033`.

After running all of them, sanity-check from the **Table Editor**:
twenty-one tables should be listed (`profiles`, `workspaces`,
`conversations`, `messages`, `files`, `resources`, `conversation_files`,
`artifacts`, `notes`, `prompts`, `shares`, `mcp_servers`,
`mcp_resources`, `mcp_resource_bindings`, `conversation_mcp_resources`,
`url_bookmarks`, `conversation_url_bookmarks`, `tasks`, `task_events`,
`task_jobs`, `project_tasks`), each showing
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
