# Plan: Switch from cloud Supabase to local Supabase

Status: **planning** — drafted 2026-06-06 from a working session on
where conversation data currently lives, what options exist for local
persistence, and which one to pick. **No code yet.** This is an
infrastructure / dev-environment switch, not a feature.

> **Companion docs.** This plan is narrower than
> [`docs/PLAN-replace-supabase-with-postgres.md`](./PLAN-replace-supabase-with-postgres.md)
> (which would *ditch* Supabase entirely and rebuild auth/storage/REST).
> The setup steps borrow heavily from
> [`docs/SUPABASE_LOCAL.md`](./SUPABASE_LOCAL.md); this plan stitches
> those steps into a switch-over for an existing cloud-pointing
> environment and resolves the decisions that doc leaves to the reader.

---

## Goal

Move local development off the hosted Supabase project
(`https://bsapthtfvflybeouyfqc.supabase.co`, currently wired in
`.env.local`) onto a Supabase stack running on this machine. Persist
**conversations, messages, files, workspaces, artifacts, and everything
else the app touches** in local Postgres + local Storage, with no cloud
dependency for daily use. Make the switch reversible (one symlink flip)
so the cloud project remains available for cross-device sync work, share
links, or anything else the local stack can't cover.

## Non-goals

The following are explicitly out of scope for this plan. Each could be
its own follow-up project.

1. **Replacing Supabase with plain Postgres.** Already covered by
   [`docs/PLAN-replace-supabase-with-postgres.md`](./PLAN-replace-supabase-with-postgres.md).
   Effort estimate from our discussion: ~2 weeks for one engineer
   (auth rebuild + RLS rewrite + storage replacement + ~30 client
   files re-pointed). This plan **keeps** Supabase, just runs it
   locally.
2. **Migrating PGlite (WASM Postgres in the browser).** The other
   serious "local-only" answer we discussed. Skips Docker entirely
   but requires rewriting the supabase-js layer. Kept in
   [§ Future considerations](#future-considerations) as a possible
   v2 once local Supabase has stabilised.
3. **Slimming `localStorage` now that Postgres holds the durable
   copy.** Worth doing — see
   [§ Open question: localStorage role after the switch](#open-question--localstorage-role-after-the-switch) —
   but not a prerequisite for the switch itself.
4. **Cloud↔local data migration.** The cloud project's data does
   **not** automatically move to the local stack. See
   [§ Ambiguity: cloud data handling](#ambiguity--cloud-data-handling)
   for the open question on whether and how to copy.

## Context — what we discussed

### Where conversation data lives today

Three storage layers in the browser:

| Storage | Holds | Cleared by |
|---|---|---|
| **localStorage** `hummingbird-storage` | conversations, messages, workspaces, artifacts, settings — one JSON blob, ~28 top-level keys, persisted via Zustand `persist` (debounced) | "Cookies and other site data" / "Site data" in any browser. **Not** plain "Cache". |
| **sessionStorage** `hummingbird-session` | ephemeral selection IDs | tab close or "Site data" wipe |
| **IndexedDB** `hummingbird-files` → `blobs` | raw bytes of uploaded files only — metadata still in `hummingbird-storage` | "Site data" wipe (separately listed) |

**Browser-specific "clear" semantics** (relevant because "clean my cache"
means different things in different browsers — useful retrievable note
since you asked directly):

| Browser | Safe button (keeps data) | Destructive button (wipes data) |
|---|---|---|
| Chrome / Edge / Brave | "Cached images and files" only | "Cookies and other site data" (and DevTools → Application → "Clear site data" with the storage boxes ticked) |
| Firefox | "Cached Web Content" | "Cookies and Site Data" |
| Safari | "Empty Caches" (Develop menu) | "Manage Website Data" → "Remove" / "Remove All" |
| Any private / incognito window | n/a | Everything wiped when the last private window closes |

Browser-initiated **eviction** is a separate fragility: under disk
pressure, browsers can evict IndexedDB without asking. The defence is
`navigator.storage.persist()` — see
[§ Future considerations](#future-considerations) item 3. Worth adding
regardless of which persistence option wins.

Cloud sync, when configured (it currently is, against the hosted
project): Supabase Postgres holds a durable mirror via the sync layer
in `lib/client/sync/`. Without sync, a "Clear site data" wipe is
unrecoverable.

> **Subtle point worth re-stating here:** even with Supabase on,
> localStorage doesn't go away. Zustand hydrates from localStorage on
> every page load (faster than a network round-trip); Postgres is the
> durable backing store, not the hot path. This stays true after the
> switch — local Supabase replaces *cloud Supabase*, not localStorage.

### Options considered

We weighed five shapes:

| Option | Footprint | Schema | Auth | Effort | Verdict |
|---|---|---|---|---|---|
| 1. Stay on localStorage + IndexedDB only | zero new processes | none | none | zero | Works today; hits walls at 5 MB localStorage cap + lack of structured queries |
| 2. Dexie / RxDB over IndexedDB | zero new processes | document-y | none | medium | Lifts the cap, gives indexed range queries; no SQL / FK / full-text |
| 3. **PGlite** (Postgres compiled to WASM in browser) | ~7–12 MB lazy WASM, persists to IndexedDB | full PG, cloud migrations apply mostly as-is | none (no remote = nothing to auth against) | ~1 week to swap `supabase-js` for a thin DB layer | The most interesting *zero-server* answer; kept as future option |
| 4. **Local Supabase, full stack** | 9–12 containers, ~2 GB idle RAM | identical to cloud schema, zero code changes | sign in via Inbucket once | ~10 min to set up | **Chosen.** Already 100% wired in repo. |
| 5. **Local Supabase, trimmed stack** | ~5 containers, ~1 GB idle RAM | identical to cloud schema, zero code changes | sign in via Inbucket once (only if Inbucket kept) | ~10 min set up + ~1 h compose edit | A sub-variant of option 4 — same architecture, fewer containers. See [§ Trimming the stack further](#trimming-the-stack-further). |

Options 4 and 5 are the **same architecture** at different
container counts — the choice between them is whether the
Studio/Inbucket/imgproxy/meta overhead is worth keeping. Recommendation:
start with option 4 (no edits to the compose file), trim down to option
5 only if Docker overhead becomes a daily annoyance.
| 4. **Local Supabase via Docker** | 9–12 containers, ~2 GB idle RAM | identical to cloud schema, zero code changes | sign in via Inbucket once | ~10 min to set up | **Chosen.** Already 100% wired in repo. |

Local Supabase won because **the path is already paved**:
`docs/SUPABASE_LOCAL.md`, npm scripts (`supabase:start`,
`supabase:reset`, etc.), pre-committed dev keys, and a tailored
`docker-compose.supabase.yml` all exist. No code changes.

### What the local Supabase stack actually runs

Two paths exist; both produce the same URLs and the same dev keys.

**Path A — Supabase CLI (`bun run supabase:start`).** Boots the full
stack defined by `supabase/config.toml`:

`db` · `kong` · `auth` (GoTrue) · `rest` (PostgREST) · `storage` ·
`studio` · `meta` · `inbucket` · `realtime` · `edge_runtime` ·
`analytics` · `db.pooler`

= **~12 service containers, ~3 GB idle RAM.**

**Path B — Standalone compose (`bun run supabase:docker:up`).** Trimmed
to what this app actually uses (`docker-compose.supabase.yml`):

`db` · `kong` · `auth` · `rest` · `storage` · `imgproxy` · `meta` ·
`studio` · `inbucket`

= **9 service containers + 2 named volumes, ~2 GB idle RAM.**

The trimmed Path B drops `realtime`, `edge_runtime`, `analytics`, and
the pooler because Hummingbird doesn't use any of them.

**Per-container purpose** (the same nine that Path B runs; Path A
runs these plus the four Hummingbird doesn't use). Useful for the trim
discussion below — and for understanding why "Supabase" isn't one
service but a coordinated mesh of seven independent open-source
projects glued together by Kong:

| Service | What it does | Why it's its own container |
|---|---|---|
| `db` | **Postgres** itself | The actual database |
| `kong` | **API gateway** | Routes `/auth/v1/*` → `auth`, `/rest/v1/*` → `rest`, `/storage/v1/*` → `storage`; enforces anon / service-role key check |
| `auth` | **GoTrue** | Email magic-link auth, JWT minting |
| `rest` | **PostgREST** | Auto-generates a typed REST API from your Postgres schema — this is what `supabase.from('table').select(...)` actually hits |
| `storage` | **Storage API** | File upload / download / signed URL signing; sits in front of `db` + the storage volume |
| `imgproxy` | **Image transforms** | On-the-fly resize / format conversion for Storage objects via `?width=200` URLs |
| `meta` | **postgres-meta** | The Postgres introspection API Studio uses to render tables, columns, RLS policies |
| `studio` | **Web GUI** | `http://localhost:54323` — table editor, SQL editor, Storage browser, auth user browser |
| `inbucket` | **Email sink** | Captures magic-link emails locally so they don't go to a real inbox |

#### Trimming the stack further

Path B can be cut further to the **minimum viable Supabase** — five
containers — without losing any feature this app uses today. The four
that come out:

| Container | What it gives up | Survivable? |
|---|---|---|
| `studio` | The web GUI at `localhost:54323` (table editor, SQL editor, Storage browser) | Yes if you're comfortable with `psql` for queries and a generic Postgres GUI (TablePlus, DBeaver, Beekeeper) for inspection |
| `inbucket` | The local email sink at `localhost:54324`; magic-link emails would have nowhere to go | **Only** if you swap to a different auth flow (sign in once via Studio's `auth.users` table seed, then reuse the session) — otherwise sign-in breaks |
| `imgproxy` | On-the-fly image transforms (`?width=200` URLs from Storage) | Yes — this app doesn't use the transform URLs today |
| `meta` | Studio's introspection API | Yes if Studio is also dropped (`meta` exists for Studio's sake) |

So the realistic floor for this app is:

- **`db` · `kong` · `auth` · `rest` · `storage`** = 5 containers, ~1 GB
  idle RAM. Requires either keeping `inbucket` or wiring an alternate
  auth flow.
- **`db` · `kong` · `auth` · `rest` · `storage` · `inbucket`** = 6
  containers, ~1.1 GB idle RAM, no changes to auth flow.

**Implementation:** edit `docker-compose.supabase.yml` to comment out
or delete the four service blocks above, then `bun run
supabase:docker:reset`. Studio replacement: `psql
"postgresql://postgres:postgres@localhost:54322/postgres"` or any
generic Postgres GUI pointed at the same URL — no per-table setup,
since standard PG protocol works.

> **[OPEN QUESTION]** Adopt the trimmed shape from day one, or start
> full and trim later? Recommendation: **start full**. The full stack is
> already wired with zero edits; trimming is a one-hour follow-up that
> only pays off if Docker idle overhead actually bothers you in
> practice. Premature trimming = lost Studio + extra debugging when
> something goes wrong.

> **[OPEN QUESTION]** Path A vs Path B for this team. Recommendation:
> **Path A** for now — faster `db reset` (~3 s vs ~30 s), image-version
> bumps tracked by the CLI, slightly cleaner control surface. Path B
> only wins for CI runners, contributors who refuse to install the CLI
> binary, **and** the trim-further story (the CLI doesn't let you turn
> individual services off; you'd have to switch to Path B to trim). The
> Supabase CLI is already installed on this machine (verified: `supabase
> 2.100.1`). See [§ Step 0 — Pre-flight](#step-0--pre-flight) for the
> version check.

### Why "ditching Supabase entirely" is a much larger project

For completeness, in case the discussion drifts back to this: a full
Supabase removal (option not chosen here) requires rebuilding three
substantial systems plus rewriting the auth model in the schema.
Detailed in `PLAN-replace-supabase-with-postgres.md`; summary of effort
sized during this session:

**The underlying reason "just use Postgres" is hard** — browsers can't
connect to raw Postgres. The app uses `supabase-js`, which is a typed
HTTP client that hits **three different HTTP services**, all proxied by
Kong:

| What `supabase-js` does | Container it actually hits |
|---|---|
| `supabase.from('conversations').select(...)` | **PostgREST** — auto-generated REST over the schema |
| `supabase.auth.signInWithOtp(...)` | **GoTrue** — issues the JWT that PostgREST then validates |
| `supabase.storage.from('user-files').upload(...)` | **Storage API** — file I/O + signed URL signing |

So "abandon Supabase, just use Postgres" really means "replace the HTTP
layer between the browser and Postgres." That's the scope. Codebase
audit done during this session:

- **~30 files** import the centralised Supabase wrappers
  (`getServerClient`, `getAdmin`, etc. under `lib/server/supabase/`).
  Re-pointing those to a direct DB layer is mechanical.
- **~5 files** make direct `.from()` / `.auth.*` / `.storage.*`
  calls outside the wrappers.
- **81 references to `auth.*`** across **11 of the 22 SQL files**,
  mostly `auth.uid()` inside `CREATE POLICY` statements. These are
  what makes the RLS rewrite tedious — `auth.uid()` is a GoTrue
  artefact that doesn't exist without GoTrue.

Effort tally:

| Replacement | Effort |
|---|---|
| `supabase-js` → Drizzle/Kysely + new API routes | 2–3 days |
| GoTrue → Auth.js / Lucia / "no auth, single user" | 3–5 days |
| RLS rewrite (`auth.uid()` → `current_setting('app.current_user_id')`) — 81 references across 11 SQL files | 1 day + careful test coverage |
| Storage API → local FS or S3-compatible + signing routes | 2–3 days |
| Triggers on `auth.users` + Python agent feature flag | 0.5 days |
| Migration tooling swap (away from `supabase` CLI) | 0.5 days |
| **Total** | **~2 weeks** for full parity, or ~1 week if auth is dropped entirely |

Switching to **local Supabase** instead avoids every line of that work.

---

## Pre-flight inventory

What's already in place on this machine, verified during the planning
session:

| Item | State |
|---|---|
| Docker | ✅ installed and running (`docker info` succeeds) |
| Supabase CLI | ✅ `2.100.1` at `/opt/homebrew/bin/supabase` |
| `supabase/config.toml` | ✅ committed in repo |
| `supabase/migrations/0001…0017_*.sql` | ✅ 22 migration files present |
| `docker-compose.supabase.yml` | ✅ committed (Path B available) |
| `.docker/supabase/dev-keys.txt` | ✅ committed; holds the deterministic anon + service-role JWTs |
| `.docker/supabase/apply-migrations.sh` | ✅ committed (Path B helper) |
| `.docker/supabase/kong.yml` | ✅ committed (Path B routing) |
| npm scripts | ✅ `supabase:start`, `:stop`, `:reset`, `:status`, `:types`, `:docker:up`, `:docker:down`, `:docker:reset`, `:docker:migrate` |
| `.env.example` | ✅ committed |
| `.env.local` | ✅ **already exists, currently pointing at cloud project `https://bsapthtfvflybeouyfqc.supabase.co`** |

That last row is the only decision-bearing item. See
[§ Ambiguity: cloud data handling](#ambiguity--cloud-data-handling).

---

## The plan — five steps

### Step 0 — Pre-flight

Re-verify the items in the table above haven't drifted since this plan
was drafted. None of these should fail on this machine today:

```bash
docker info > /dev/null && echo "docker ok"
supabase --version                           # expect 2.x
ls supabase/migrations/ | wc -l              # expect 22 (as of 2026-06-06)
ls .docker/supabase/                         # expect apply-migrations.sh, dev-keys.txt, kong.yml
grep -c "supabase:" package.json             # expect ≥ 9
```

If any fails, fix before proceeding. The most likely drift after time
passes: new migrations land (count goes up), Supabase CLI gets a major
version bump, or Docker isn't started.

### Step 1 — Split `.env.local` into named profiles

The symlink-swap pattern from `SUPABASE_LOCAL.md`. Goal: end up with
three files — a `cloud` profile, a `local` profile, and `.env.local`
symlinked to whichever is currently active.

```bash
# Step 1a — preserve current cloud-pointing config
cp .env.local .env.local.cloud

# Step 1b — start a local profile from the same starting point
cp .env.local .env.local.local
```

Then edit `.env.local.local` and replace these three lines with the
deterministic local dev keys from `.docker/supabase/dev-keys.txt`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6InNlcnZpY2Vfcm9sZSIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q
```

Leave **every other variable alone** — `AI_GATEWAY_API_KEY`,
`MINIMAX_*`, `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`,
`DEBUG_CHAT_STREAM` all work identically against local Postgres.

Then swap the symlink:

```bash
rm .env.local
ln -s .env.local.local .env.local
```

After step 1:

```
.env.local        → symlink → .env.local.local   (active)
.env.local.local  → file with local URLs + dev keys
.env.local.cloud  → file with the original cloud URLs + keys
```

Flipping back later: `ln -sf .env.local.cloud .env.local`.

> **[AMBIGUITY]** `.env.local`, `.env.local.local`, and `.env.local.cloud`
> are all `.gitignore`-d (standard Next.js convention). Confirm nothing
> custom is overriding that before committing this plan — `git
> check-ignore .env.local.local`. **Action:** check during execution.

> **[OPEN QUESTION]** Should we add a one-line indicator in the app
> footer / titlebar showing whether the current backend is `local` or
> `cloud`? Easy mistake to forget which profile is active. Not blocking;
> follow-up task if it becomes annoying.

### Step 2 — Boot the local stack

```bash
bun run supabase:start
```

**First run** pulls ~1 GB of Docker images — minutes on a decent
connection. **Subsequent boots** take ~30 s. The 22 migrations under
`supabase/migrations/` auto-apply on every start (and on every
`db reset`).

Successful output ends with:

```
         API URL: http://localhost:54321
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
    Inbucket URL: http://localhost:54324
        anon key: (matches .docker/supabase/dev-keys.txt)
service_role key: (matches .docker/supabase/dev-keys.txt)
```

If any port (`54321`–`54324`, `54322`) is held by another process,
`supabase start` fails loudly with `port already allocated`. Resolve via
`lsof -i :54321` (etc.) and either kill the holder or bump ports in
`supabase/config.toml`.

Sanity check: `bun run supabase:status` after boot — lists every
container and its port.

### Step 3 — Restart `bun dev` so Next.js re-reads env

Next.js does **not** hot-reload env vars. The current `bun dev` process
still has the cloud URL cached. Kill it (Ctrl-C) and re-run:

```bash
bun dev
```

Without this, you'll see "still talking to cloud" symptoms and chase
ghosts.

### Step 4 — Verify the swap end-to-end

Four checkpoints in order:

1. **Studio is up.** Open <http://localhost:54323>. Click **Table
   Editor**. You should see the ~14 public tables (`profiles`,
   `workspaces`, `conversations`, `messages`, `files`, `resources`,
   `conversation_files`, `artifacts`, `notes`, `shares`,
   `mcp_servers`, `mcp_resources`, `mcp_resource_bindings`,
   `conversation_mcp_resources`) — all empty.
   - **If missing:** migrations didn't apply. Run `bun run
     supabase:reset` and re-check.
2. **App resolves the local URL.** Open
   <http://localhost:3000/dashboard>. A **Sign in** button appears in
   the sidebar — its visibility is gated on `NEXT_PUBLIC_SUPABASE_URL`
   being set. If the button is missing, the env vars didn't propagate
   (did you restart `bun dev`?).
3. **Magic-link auth via Inbucket.**
   - Click **Sign in** in the app, enter any email
     (e.g. `me@local.test`), click **Send magic link**.
   - Open <http://localhost:54324> (Inbucket). The email is at the top
     of the inbox. Click the magic-link button.
   - You land back on `/dashboard`, signed in. Sidebar now shows your
     email.
4. **Writes land in local Postgres.** Create a workspace + a
   conversation + send a message in the app. In Studio's SQL editor:
   ```sql
   select id, name from public.workspaces;
   select id, title from public.conversations;
   select role, left(content, 50) from public.messages order by created_at desc limit 5;
   ```
   Rows should appear. **If they do, the switch is verified.**

### Step 5 — Optional: regenerate TS types from local schema

The pinned types in `lib/shared/supabase/types.ts` were generated
against the cloud schema. If local migrations have drifted (e.g. a
migration landed in `dev` after the cloud project was last `db
reset`-ed), regenerate:

```bash
bun run supabase:types
```

Commit if non-empty diff. Empty diff = local and cloud schemas are in
sync, no action needed.

> **[OPEN QUESTION]** Should regenerating against local be the
> canonical workflow going forward? CI currently enforces
> "PR touches `supabase/migrations/` → must also touch `types.ts`" via
> `scripts/verify-supabase-types.sh`. The expectation in `SUPABASE_LOCAL.md`
> is to run `supabase:reset && supabase:types` before committing a
> migration. Adopting local Supabase makes that workflow easier (no
> cloud round-trip to re-snapshot the schema), which is a small bonus.

---

## Verification checklist (post-step-4)

Pin these as the "yes, the switch worked" criteria. Tick all before
calling the switch done.

- [ ] `supabase status` reports all ~12 (Path A) or ~9 (Path B) containers
      healthy.
- [ ] Studio at `localhost:54323` shows all public tables.
- [ ] App at `localhost:3000/dashboard` shows the **Sign in** button.
- [ ] Magic link arrives in Inbucket (`localhost:54324`) within 1 s of
      submit.
- [ ] After sign-in, `public.profiles` has exactly one row (yours), inserted
      by the `on_auth_user_created` trigger from `0002_rls_policies.sql`.
- [ ] New workspace / conversation / message rows appear in `public.*`
      tables.
- [ ] File upload → file metadata in `public.files`, blob in
      Storage's `user-files/<userId>/` folder (visible in Studio →
      Storage).
- [ ] Share-link creation (kebab menu → Share → Conversation → Create
      link) → opening the link in a private window renders the
      conversation read-only with no session.
- [ ] **Rollback verified at least once:** `ln -sf .env.local.cloud
      .env.local`, restart `bun dev`, sign in to the cloud project, see
      the original cloud data unchanged.

---

## Rollback / switching back to cloud

One symlink flip + a dev-server restart:

```bash
ln -sf .env.local.cloud .env.local
# kill bun dev, restart it
bun dev
```

To also stop the Docker stack (frees ~2 GB RAM, keeps data in volumes):

```bash
bun run supabase:stop           # Path A
bun run supabase:docker:down    # Path B
```

The local Postgres + Storage data lives in Docker volumes and survives
container restarts. To **truly nuke it**:

```bash
supabase stop --no-backup       # Path A — also wipes the data volume
bun run supabase:docker:reset   # Path B — wipes volumes + re-migrates
```

> **[OPEN QUESTION]** Should we wire a `bun run env:cloud` / `bun run
> env:local` pair of npm scripts that flip the symlink and remind you
> to restart `bun dev`? Two-line addition to `package.json`; would
> remove the "did I forget to switch profiles?" risk.

---

## Operational considerations

### Daily-driver feel

- **Docker has to be running** for the app to write to local Postgres.
  If Docker Desktop is closed, the app currently falls through to an
  anonymous localStorage-only mode (no error banner — the **Sign in**
  button just sits there). For a desk-bound workflow this is invisible;
  for a battery-conscious laptop workflow it's friction.
- **Stack cold-start:** ~30 s after `supabase start`. Until ready, the
  app silently behaves as if Supabase is misconfigured.
- **Sign-in persistence:** sessions survive container restarts as long
  as you don't `supabase stop --no-backup`. Plan for "sign in once per
  fresh DB reset," not "sign in every morning."

> **[OPEN QUESTION]** Worth adding a small `Backend: local|cloud|none`
> indicator in the dashboard chrome so the daily-driver experience tells
> you which world you're in without checking `.env.local`?

### Data lifecycle

- Conversations / messages / workspaces → Postgres tables (durable in
  the `supabase_db_data` volume).
- File blobs → Supabase Storage (`user-files` bucket, durable in the
  `supabase_storage_data` volume).
- File metadata → `public.files` table.
- **Two Docker volumes** hold everything. Backup = `pg_dump` (DB) + a
  tarball of the storage volume.

> **[OPEN QUESTION]** Backup cadence. Suggested baseline: a weekly
> `pg_dump` to `~/backups/humm/$(date +%F).sql` via a cron job or just
> a manual habit. Not blocking; flag if data loss matters before going
> further.

> **[AMBIGUITY]** The Storage volume is reset only by
> `supabase stop --no-backup` (Path A) or `bun run supabase:docker:reset`
> (Path B). `supabase db reset` (the common case for schema iteration)
> wipes the DB **but not** the Storage bucket — so file rows in
> `public.files` go away while blobs linger in Storage as orphans.
> **Action:** decide whether to also clear Storage on every `db reset`
> via a helper script. Current behaviour is "leak orphan blobs." Not
> destructive, but messy.

### Schema drift

Once running locally, every `supabase db reset` re-applies the migration
chain from scratch. Tests, schema iterations, and
`supabase gen types typescript --local` all run against this. If you
also push a new migration to the cloud project, run `db reset` locally
to pick it up — there's no automatic sync.

> **[OPEN QUESTION]** Single source of truth for the schema. Today
> migrations are written once and applied to whichever project (cloud
> or local) you point at. With both around, easy to drift. Suggested
> rule: **always iterate locally first**, then push to cloud via
> whatever mechanism you use today (`supabase db push` if linked, or
> manual `psql`). Calling it out as a convention now is cheaper than
> hunting drift later.

### Performance

- Local Postgres queries: low single-digit ms.
- Round-trip through Kong + PostgREST: tens of ms per request.
- App-perceived latency: comparable to or slightly snappier than cloud
  (no network hop).
- Streaming SSE for chat: identical — chat path doesn't go through
  Supabase.

### CI

CI is unaffected by this change. `.env.local*` files are gitignored;
PRs run against whatever CI's secrets specify (cloud, in this repo's
case). The pre-existing `scripts/verify-supabase-types.sh`
forcing-function still fires on migration changes.

> **[OPEN QUESTION]** Should we set up a docker-compose-based local
> Supabase in CI too, for true E2E test runs? Out of scope here, but
> worth flagging — `docker-compose.supabase.yml` is exactly what such
> a CI workflow would use (Path B).

### MCP credentials

Cloud-mode MCP credentials need `MCP_ENCRYPTION_KEY` in the Next.js
server env. Without it, the **Cloud** radio in the Add MCP server
dialog is greyed out; Local mode still works. To enable Cloud mode
locally:

```bash
openssl rand -base64 32     # generates a fresh key
# paste into .env.local.local as: MCP_ENCRYPTION_KEY=<output>
# restart bun dev
```

> **[OPEN QUESTION]** Worth enabling this from day one (Local mode is
> usually fine for solo dev), or defer until you actually need cloud-
> mode credentials? Recommend: defer. Add when first needed.

### Python agent service

`services/agent-py/` requires `SUPABASE_DB_URL` (the direct Postgres
connection, not the pooler). With local Supabase running, this is:

```
SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres
```

This unblocks running the Python agent locally — currently blocked on
cloud because the agent service was scoped to "self-host on a small VM"
per `docs/PLAN-agent-api.md`. Not a goal of this plan, but a bonus side
effect.

> **[OPEN QUESTION]** Set `SUPABASE_DB_URL` in `.env.local.local`
> proactively so the Python agent picks it up the first time you start
> it, or leave it commented out until needed? Recommend: set it
> commented-out with a one-line note pointing at `PLAN-agent-api.md`.

---

## Ambiguities & open questions — consolidated

Pulled out of the body for quick scanning. Each carries an
**Action** line for follow-up.

### Ambiguity — cloud data handling

The cloud project (`https://bsapthtfvflybeouyfqc.supabase.co`)
currently holds whatever data you've created against it. **None of
that automatically appears in the local stack.** Options:

| Option | What it means |
|---|---|
| **Accept loss locally** | Start fresh in local; cloud data still accessible by flipping the symlink back. Simplest. |
| **One-time data copy** | `pg_dump` from cloud → `psql` import into local. Schema must match exactly (it does today — same migrations). 5–15 min. Storage bucket would need a separate `gsutil`/`aws s3 sync`-style copy. |
| **Bidirectional sync** | Out of scope. Supabase doesn't provide multi-master replication; you'd be building a custom mirror. Don't. |

**Action:** decide *before* step 1 whether you want a one-time data
copy. The plan as written assumes "accept loss locally — the cloud
project is your backup."

### Ambiguity — `.env.local.local` gitignore

The standard Next.js `.gitignore` only excludes `.env*.local`. The
file `.env.local.local` *does* match `.env*.local` (because `.local.local`
ends in `.local`), so it should be ignored — but worth confirming:

**Action:** during execution, run `git check-ignore .env.local.local
.env.local.cloud` and confirm both print the filename (= they're
ignored). If `.env.local.cloud` slips into the repo, **don't commit**;
the cloud anon key shouldn't sit in git.

### Open question — Path A vs Path B

Recommendation: **Path A (CLI)** for now. Reasons:
- CLI is already installed.
- `db reset` is 10× faster (~3 s vs ~30 s).
- Image-version maintenance happens through `supabase` CLI updates,
  not hand-edited `docker-compose.supabase.yml`.

Switch to Path B only if you want to run the same setup in a CI worker
without installing the CLI.

**Action:** start with Path A. Revisit only if it causes friction.

### Open question — localStorage role after the switch

Once Postgres is the durable store, the case for keeping the *full*
state in `hummingbird-storage` weakens. Today every Zustand mutation
re-serialises the full partialized state. Trimming localStorage to
just UI prefs (theme, panel widths, active workspace) and rehydrating
the rest from Postgres on app boot would:

- Eliminate the 5 MB localStorage ceiling.
- Speed up first-paint negligibly (Postgres read isn't on the SSR
  path).
- Add a "loading…" frame on cold start (currently zero — localStorage
  is sync).
- Require a non-trivial rewrite of `partializeState` + the sync layer's
  boot path.

**Action:** defer. Land local Supabase first, see whether the
localStorage 5 MB cap actually bites in practice, then decide. The
current architecture's offline-first design is a feature, not an
accident — don't sacrifice it without a forcing function.

### Open question — backend-indicator UI

Tiny chip in the dashboard chrome reading `local Supabase`,
`cloud Supabase`, or `localStorage only`. Reads
`NEXT_PUBLIC_SUPABASE_URL`; matches on `localhost` or `supabase.co`.

**Action:** non-blocking. ~30 min of work if/when accidentally
launching against the wrong backend becomes a recurring annoyance.

### Open question — `bun run env:local` / `env:cloud` scripts

Two-line `package.json` addition:

```json
"env:local": "ln -sf .env.local.local .env.local && echo 'switched to LOCAL — restart bun dev'",
"env:cloud": "ln -sf .env.local.cloud .env.local && echo 'switched to CLOUD — restart bun dev'"
```

**Action:** add at the same time as Path-A activation, before the first
real swap. Cheap, eliminates a class of mistakes.

### Open question — `db reset` should also clear Storage

`supabase db reset` wipes Postgres but leaves Storage blobs orphaned.
Workaround: a wrapper script that does both. Sketch:

```bash
#!/usr/bin/env bash
# scripts/local-supabase-full-reset.sh
set -euo pipefail
supabase db reset
# Path A: storage volume name is supabase_storage_<dirname>
docker volume rm -f "$(docker volume ls -q | grep storage_humm || true)" || true
supabase stop && supabase start
```

**Action:** decide whether the orphan-blob mess matters in practice
before writing this script. If you reset rarely, skip.

### Open question — backup cadence

Suggested floor: weekly `pg_dump`. Sketch:

```bash
# In ~/.zshrc as a function, or a cron:
humm-backup() {
  local out="$HOME/backups/humm/$(date +%Y-%m-%d).sql"
  mkdir -p "$(dirname "$out")"
  pg_dump "postgresql://postgres:postgres@localhost:54322/postgres" > "$out"
  echo "→ $out"
}
```

Plus a Storage volume tarball if file uploads matter.

**Action:** discuss whether data loss tolerance is "rebuild from
scratch" (no backup needed) or "weeks of work lost" (weekly minimum).

### Open question — single source of truth for schema

With both cloud and local available, easy to forget which one the
latest migration was applied to. Suggested convention: **migrations
land in `supabase/migrations/`, get tested via `supabase db reset`
locally, then `supabase db push` to cloud** (or manual `psql` against
cloud). Cloud is downstream of local.

**Action:** adopt as convention now via a one-paragraph addition to
`SUPABASE_LOCAL.md` once this plan is executed.

### Open question — Python agent activation

`SUPABASE_DB_URL=postgresql://postgres:postgres@localhost:54322/postgres`
in `.env.local.local` (commented out) makes the Python agent runnable
the first time you want it. See `docs/PLAN-agent-api.md` for the
service's full setup story.

**Action:** add the commented-out line during step 1.

### Open question — truly auth-free local mode (disable RLS)

The plan as written keeps RLS on and asks you to sign in via Inbucket
once per fresh DB. If you want **zero auth friction** — no sign-in
dialog, no Inbucket trip, no `auth.uid()` gate — the options are:

1. **Disable RLS on every public table after migrations apply.** Custom
   step in a wrapper around `supabase db reset`:
   ```sql
   do $$
     declare t record;
   begin
     for t in select tablename from pg_tables where schemaname = 'public' loop
       execute format('alter table public.%I disable row level security', t.tablename);
     end loop;
   end $$;
   ```
   The app would still need *some* user id to write rows that have a
   `user_id` column. You'd either (a) seed a fixed dev user in `auth.users`
   and hard-code the id, or (b) make the app tolerate `auth.uid() = null`
   in the relevant code paths (non-trivial — current code assumes a
   signed-in user when Supabase is on).
2. **Sign in once via Inbucket and never sign out.** Sessions persist
   across container restarts as long as you don't
   `supabase stop --no-backup`. Practically zero friction after the
   first ~30 s of clicking through Inbucket.

**Caveats with option 1:** breaks the share-link flow (which depends on
RLS to expose just one conversation to anon), breaks any client code
that branches on `auth.user`, and silently diverges your local Postgres
from the cloud schema. Not recommended unless you have a specific
reason.

**Action:** **prefer option 2 by default.** Only reach for option 1 if
the once-per-DB-reset Inbucket trip becomes an actual annoyance.
Mark this question closed once you've used local Supabase for a week
and know which side of the trade-off you land on.

### Open question — multi-user local testing

Some flows need more than one user to exercise:

- **Share links** — create as user A, open as anon and verify
  read-only render.
- **Per-workspace RLS** — confirm user B can't see user A's
  workspace even with a forged URL.
- **MCP cloud-mode credentials** — same encryption key across users
  but per-user RLS on the `mcp_servers` rows.

With local Supabase + Inbucket, "multi-user" is cheap: sign in with a
different email (`me@local.test`, `you@local.test`, `friend@local.test`,
etc.) and Inbucket catches every magic link. Each email = a separate
row in `auth.users` and a separate `auth.uid()`. The same browser can
juggle multiple sessions via different browser profiles or private
windows.

**Action:** non-blocking — defer until you have a specific multi-user
scenario to test. Worth knowing the path exists so you don't reach for
"two laptops" by reflex.

---

## Effort estimate

| Phase | Time |
|---|---|
| Reading this plan, agreeing on the open questions | 15 min |
| Executing steps 0–5 | 5 min (excluding first-time Docker image pull) |
| First-time Docker image pull | 3–10 min |
| Verification checklist | 5 min |
| **Total** | **~30 min wall-clock**, ~10 min hands-on |

Add ~30 min if you also want to wire the `env:local`/`env:cloud` npm
scripts and the backend-indicator chip in the same sitting.

---

## Future considerations

Things to revisit after this plan ships.

1. **Trim Path B further.** Already covered in detail at
   [§ Trimming the stack further](#trimming-the-stack-further). The
   floor is 5 containers (~1 GB idle RAM) at the cost of Studio +
   imgproxy + meta. Worth doing only if Docker idle overhead bothers
   you in practice; ~1 hour of compose editing if/when that day comes.
   Requires switching from Path A (CLI) to Path B (compose) because
   the CLI doesn't let you turn individual services off.
2. **PGlite path.** If "Docker has to be running" becomes daily
   friction, PGlite is the genuinely-zero-server answer. ~1 week to
   swap `supabase-js` for a thin PG layer; ~7 MB WASM cost on first
   load. The schema migrations apply nearly verbatim. **Note:** PGlite
   gives up auth (no remote = nothing to auth against = single local
   user only) and gives up file Storage (replace with IndexedDB blobs,
   same as today). Worth doing only if Docker overhead becomes
   intolerable.
3. **`navigator.storage.persist()`.** One-line hardening to ask the
   browser not to evict the `hummingbird-files` IndexedDB or
   `hummingbird-storage` localStorage under disk pressure. Worth
   adding regardless of local-vs-cloud choice. ~30 lines including the
   prompt + telemetry.
4. **Slim `partializeState`.** Once Postgres is the durable store,
   trim what gets persisted to localStorage. See
   [§ Open question: localStorage role after the switch](#open-question--localstorage-role-after-the-switch).
5. **Eventually replace Supabase entirely.** Always available as a
   future option via `PLAN-replace-supabase-with-postgres.md`. ~2 weeks
   for one engineer. **Not recommended** unless there's a specific
   reason — Supabase isn't costing you much running locally, and the
   migration cost is real.

---

## References

- `docs/SUPABASE_LOCAL.md` — the detailed step-by-step that this plan
  builds on.
- `docs/SUPABASE_SETUP.md` — the cloud counterpart, useful when
  migrating data between projects.
- `docs/PLAN-replace-supabase-with-postgres.md` — the larger "ditch
  Supabase entirely" project. Not what this plan does.
- `docs/PLAN-agent-api.md` — Python agent service requirements,
  relevant if you turn that on after local Supabase is running.
- `supabase/migrations/0001_schema.sql` … `0017_prompts_workspace.sql`
  — the 22-file migration chain applied on every `supabase start` /
  `supabase db reset`.
- `.docker/supabase/dev-keys.txt` — deterministic dev JWTs used by the
  local stack.
- `lib/shared/supabase/env.ts` — the gate that decides whether
  Supabase features light up; reads
  `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` at
  runtime.
