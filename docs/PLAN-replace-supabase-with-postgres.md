# Plan: Replace Supabase with self-hosted Postgres

Status: **planning** — no code yet. This is an infrastructure migration, not a
feature. It replaces the managed Supabase stack (Postgres + GoTrue +
PostgREST + Storage + Kong) with a self-hosted Postgres + app-level
alternatives for Auth, REST, and file storage.

## Why

Supabase is a managed platform. Replacing it with self-hosted Postgres gives:

- **Full data ownership** — no third party has access to the database.
- **No vendor lock-in** — Postgres is everywhere; the app can run on any
  hosting (VPS, bare metal, any cloud provider's managed Postgres).
- **Cost predictability** — no Supabase plan limits, no per-user pricing.
- **Simpler dev stack** — the local dev Docker Compose currently runs 7
  containers (db, kong, auth, rest, storage, imgproxy, meta, studio,
  inbucket). Dropping to just Postgres (+ optional MinIO for storage)
  cuts complexity.
- **Unifies on `pg`** — today's codebase uses `@supabase/supabase-js`
  for most DB access but raw `pg` for a few RPC calls isn't possible
  without PostgREST in the middle. A direct SQL client is simpler to
  reason about.

The trade-off: Supabase saves you from building auth, REST, storage, and
RLS from scratch. This plan documents exactly what has to be rebuilt.

## What's at stake — the current Supabase surface

The Supabase stack currently provides 4 services. Here's exactly what
each one does in this codebase today, and what replaces it:

| Supabase service | What it does today | Replacement |
|---|---|---|
| **GoTrue** (Auth) | Email+password sign-in, session cookies, JWT minting. `use-auth.ts` calls `signInWithPassword`, `signOut`, `getSession` via `supabase-js`. `/auth/callback` exchanges OAuth code. | Auth.js v5 (next-auth) with credentials provider + JWT sessions. Drop-in for Next.js App Router via middleware. |
| **PostgREST** (REST API) | Auto-generated CRUD for 16 tables. The sync layer (`sync-queue.ts` + `reconcile.ts`) uses `supabase-js` to upsert/delete rows *directly from the browser* — no API route in between. Server routes (`/api/mcp/*`, `/api/share/*`) also query via PostgREST. | Replace with direct SQL (`pg`) on the server. Browser→DB writes route through new API routes that accept `SyncOp[]` batches. |
| **Storage** (S3-compatible) | `user-files` bucket with per-user folder RLS. Client uploads via `storage.from('user-files').upload()`. Server uploads for generated images. Signed URLs for download. | Replace with S3 (AWS/MinIO/Cloudflare R2) via `@aws-sdk/client-s3`. Same folder-per-tenant pattern (`{userId}/...`). |
| **RLS** (row-level security) | Every table enforces `user_id = auth.uid()` at the DB level. Without it, a missing `WHERE` clause leaks data cross-user. | User scoping moves into application code. Every API route must filter by the authenticated user ID from the JWT. A shared `withUserScope(db, userId)` utility pattern makes this auditable. |

What's **not** used (no migration needed):

- Supabase Realtime — sync is pull-based, not push.
- Supabase Edge Functions — none exist.
- Supabase Vector — pgvector isn't deployed yet (see `PLAN-local-rag.md`).

## Architecture — before and after

### Before (current)

```
Browser                                    Next.js Server
────────                                   ──────────────
┌─────────┐  supabase-js  ┌──────────┐   ┌──────────────┐
│ Sync    │ ────────────→ │          │   │ /api/chat/*  │
│ Queue   │  (upsert/del) │          │   │ /api/mcp/*   │
├─────────┤               │ Kong     │   │ /api/share/* │──┐
│ Recon-  │  supabase-js  │ (gateway)│   │ /auth/       │  │
│ cile    │ ────────────→ │          │   │ callback     │  │
├─────────┤  (fetch all)  │          │   └──────────────┘  │
│ Auth    │  supabase-js  └────┬─────┘                     │
│ UI      │ ────────────→      │                           │
└─────────┘                    │      supabase-js           │
                               ├──────────────┬────────────┘
                               │              │
                          ┌────┴────┐   ┌────┴────┐
                          │ GoTrue  │   │ PostgREST│
                          │ (auth)  │   │ (REST)   │
                          └────┬────┘   └────┬────┘
                               │              │
                          ┌────┴──────────────┴────┐
                          │       Postgres 15      │
                          │  (RLS enforced here)   │
                          └────────────────────────┘
                               │
                          ┌────┴────┐
                          │ Storage │
                          │  (S3)   │
                          └─────────┘
```

### After (target)

```
Browser                              Next.js Server
────────                             ──────────────
┌─────────┐  fetch  ┌────────────┐  ┌──────────────┐
│ Sync    │ ──────→ │ /api/sync   │  │ /api/chat/*  │
│ Queue   │         │ (batch ops) │  │ /api/mcp/*   │
├─────────┤  fetch  ├────────────┤  │ /api/share/* │──┐
│ Recon-  │ ──────→ │ /api/sync/  │  │ /auth/*      │  │
│ cile    │         │ snapshot    │  │ (next-auth)  │  │
├─────────┤  fetch  ├────────────┤  └──────┬───────┘  │
│ Auth    │ ──────→ │ /api/auth/* │         │          │
│ UI      │         │ (next-auth) │         │  pg      │
└─────────┘         └─────────────┘         │          │
                                             │  s3-sdk  │
                                        ┌────┴────┬─────┘
                                        │ Postgres│  S3
                                        │   16    │ (MinIO
                                        │  (no RLS│  or R2)
                                        │ needed) │
                                        └─────────┘
```

The key architectural shift: **browser never talks to Postgres directly.**
All DB access goes through Next.js API routes that run SQL via `pg` and
enforce user scoping.

## Strategy — phased, each phase ships independently

### Phase 0 — Assessment & decision gates (no code, 1 conversation)

Before writing code, decide:

1. **Auth library**: Auth.js v5 (recommended) vs. Lucia Auth vs. Clerk.
   - Auth.js v5: most popular, built-in Next.js middleware, credentials
     provider, JWT sessions. Risk: v5 is still relatively new; API
     surface has churned.
   - Lucia: lightweight, explicit, but the v4 docs say "use something
     else for new projects". Pass.
   - Clerk: hosted auth, defeats the "self-hosted" goal. Pass.
   - **Recommendation**: Auth.js v5. The credential flow matches what the
     app does today.

2. **Storage backend**: MinIO (Docker) vs. Cloudflare R2 vs. AWS S3.
   - MinIO: self-hosted S3-compatible, runs in Docker alongside Postgres.
     Free. IAM-free dev experience. Use for local dev + self-hosted prod.
   - R2: S3-compatible, generous free tier (10 GB free), no egress fees.
     Good for production if you're already on Cloudflare.
   - **Recommendation**: MinIO for local dev + a configurable S3 endpoint
     (`S3_ENDPOINT`, `S3_BUCKET`, etc.) so R2/S3 are drop-in.

3. **Migration runner**: Which tool runs the 11 `.sql` files?
   - Hand-written script: iterate `.sql` files, run via `pg`, track in a
     `_migrations` table. ~50 lines. Owned.
   - `drizzle-kit`: brings an ORM we don't need. Heavy.
   - `node-pg-migrate`: mature, simple, owned.
   - **Recommendation**: a hand-written migration runner (`scripts/migrate.ts`
     or a CLI-script). The migrations are already plain SQL; the runner
     just needs to read files in order and track which have run. This
     avoids a dependency that imposes its own conventions.

4. **User scoping enforcement**: How to prevent missing `WHERE user_id`
   bugs without RLS?
   - Pattern: a `pgWithUser(client, userId)` wrapper that auto-appends
     `WHERE user_id = $1` to SELECT/UPDATE/DELETE queries (via query
     introspection or a simple convention).
   - Alternative: a lint rule that flags raw `pg.query()` without user
     scoping. More lightweight.
   - **Recommendation**: start with convention + code review. Add the
     wrapper if leaks surface.

### Phase 1 — Database direct access (≈ 1.5 days)

**Goal**: Run the current Postgres schema on raw Postgres, with a
migration runner and a server-side `pg` client. No Supabase services.
Auth and storage still work via Supabase (bridged) — the database is
the only thing that moves.

**What changes:**

1. **New dependency**: `pg` (node-postgres) + `@types/pg`.

2. **New file** `lib/server/db/pool.ts`:
   ```ts
   import { Pool } from "pg"
   
   const pool = new Pool({
     host: process.env.PG_HOST ?? "localhost",
     port: Number(process.env.PG_PORT ?? 5432),
     database: process.env.PG_DATABASE ?? "postgres",
     user: process.env.PG_USER ?? "postgres",
     password: process.env.PG_PASSWORD ?? "postgres",
     max: 20,
   })
   
   export function getPool() { return pool }
   ```

3. **New file** `lib/server/db/with-user-scope.ts`:
   ```ts
   import { PoolClient } from "pg"
   
   export async function withUserScope<T>(
     client: PoolClient,
     userId: string,
     fn: (db: PoolClient) => Promise<T>,
   ): Promise<T> {
     // This is a hedge — in Phase 1 it's just documentation.
     // Phase 2 adds a query interceptor.
     return fn(client)
   }
   ```

4. **Migration runner** — `scripts/migrate.ts`:
   - Reads `.sql` files from `migrations/` in numeric order.
   - Keeps a `_migrations` table: `(filename text primary key, applied_at timestamptz)`.
   - Skips files already applied. Runs remaining in a single transaction.
   - `bun run migrate` as the package.json script.
   - Verifies all 11 current migrations run without errors against a raw
     Postgres 15/16.

5. **Docker Compose** (new `docker-compose.postgres.yml`):
   ```yaml
   services:
     db:
       image: postgres:16
       ports: ["5432:5432"]
       environment:
         POSTGRES_PASSWORD: postgres
       volumes:
         - pgdata:/var/lib/postgresql/data
   volumes:
     pgdata:
   ```

6. **Env vars** (add to `.env.example`):
   ```
   PG_HOST=localhost
   PG_PORT=5432
   PG_DATABASE=postgres
   PG_USER=postgres
   PG_PASSWORD=postgres
   ```

**Verification:**
- `bun run migrate` creates all 16 tables + 3 RPCs + GIN indexes.
- The `profiles` table no longer has an auto-create trigger on
  `auth.users` (that's a GoTrue hook). Replace with app-level profile
  creation on sign-up (handled in Phase 2).
- The `0005_mcp.sql` RPC functions (`mcp_get_decrypted_credentials`,
  `mcp_upsert_server_with_credentials`) no longer call `auth.uid()` —
  they accept `p_user_id` as a parameter instead (the caller provides
  the user ID from the JWT). This is a **migration change** (the two RPC
  signatures change).
- The `0009_search_file_sections.sql` RPC is SECURITY INVOKER and
  filters by `auth.uid()` — change to accept `p_user_id` parameter.

### Phase 2 — Auth replacement (≈ 2 days)

**Goal**: Replace GoTrue with Auth.js v5. The app uses email+password
sign-in. Sessions are JWTs stored in HTTP-only cookies. User profile
creation happens at first sign-in.

**What changes:**

1. **New dependency**: `next-auth@beta` (v5).

2. **New file** `lib/server/auth/index.ts` — Auth.js config:
   ```ts
   import NextAuth from "next-auth"
   import Credentials from "next-auth/providers/credentials"
   import { Pool } from "pg"
   import bcrypt from "bcryptjs"
   
   export const { handlers, auth, signIn, signOut } = NextAuth({
     providers: [
       Credentials({
         credentials: { email: {}, password: {} },
         authorize: async (credentials) => {
           const pool = new Pool(...)
           const { rows } = await pool.query(
             "SELECT id, email, password_hash FROM users WHERE email = $1",
             [credentials.email],
           )
           if (!rows[0]) return null
           const valid = await bcrypt.compare(credentials.password, rows[0].password_hash)
           if (!valid) return null
           return { id: rows[0].id, email: rows[0].email }
         },
       }),
     ],
     callbacks: {
       jwt: ({ token, user }) => {
         if (user) token.sub = user.id
         return token
       },
       session: ({ session, token }) => {
         session.user.id = token.sub!
         return session
       },
     },
   })
   ```

3. **New migration** `migrations/0012_users.sql`:
   ```sql
   -- Replaces the Supabase `auth.users` table.
   create table users (
     id uuid primary key default gen_random_uuid(),
     email text not null unique,
     password_hash text not null,
     created_at timestamptz not null default now()
   );
   
   -- User profiles (replaces the old `profiles` table that referenced auth.users).
   -- The user row is the profile; all other tables reference users.id directly.
   alter table workspaces rename column user_id to owner_user_id;
   -- ...same for all 16 tables that reference user_id.
   -- Actually: keep `user_id` as the column name, but it now references `users.id`.
   alter table workspaces
     drop constraint if exists workspaces_user_id_fkey,
     add constraint workspaces_user_id_fkey
       foreign key (user_id) references users(id) on delete cascade;
   -- Repeat for all tables: conversations, messages, files, resources,
   -- conversation_files, artifacts, notes, shares, mcp_servers, mcp_resources,
   -- mcp_resource_bindings, conversation_mcp_resources, url_bookmarks,
   -- conversation_url_bookmarks, prompts.
   ```

   Actually, let me reconsider. The cleanest approach: keep `user_id`
   column name, but repoint all FK constraints from `auth.users(id)` to
   `users(id)`. The migrations can DROP and re-ADD the FKs. This is a
   data-destructive migration if users already exist — phase this as
   net-new schema for new deployments.

4. **New route handler** `app/api/auth/[...nextauth]/route.ts`:
   ```ts
   export { GET, POST } from "@/server/auth"
   ```

5. **Middleware** `middleware.ts` (root-level):
   ```ts
   export { auth as middleware } from "@/server/auth"
   export const config = { matcher: ["/api/:path*"] }
   ```
   This protects `/api/*` routes — every API route gets `req.auth`.

6. **Client auth** — replace `use-auth.ts`:
   - `signIn("credentials", { email, password })` replaces `signInWithPassword`.
   - `signOut()` replaces `signOut()` (same API).
   - `useSession()` from `next-auth/react` replaces `getSession()` +
     `onAuthStateChange`.
   - The `AuthDialog` component adapts to the new API.

7. **Server auth** — replace `getSupabaseServerClient` auth calls:
   - Every API route that called `client.auth.getUser()` now calls the
     Auth.js `auth()` helper (reads the JWT from cookies, returns
     `{ user: { id, email } }` or `null`).
   - The `Authorization: Bearer <token>` header convention is replaced
     by Auth.js's cookie-based session.

8. **Admin access**: Auth.js doesn't have a "service role" concept. The
   admin client route for share resolution (`/api/share/[token]`) runs
   as the server itself — it uses the `pg` pool directly and validates
   the share token, not the caller's identity. This is actually simpler:
   the route just reads from the `shares` table with a WHERE clause on
   the token.

9. **Remove**: `lib/server/supabase/server.ts`, `lib/server/supabase/admin.ts`,
   `lib/client/supabase/client.ts` — all Supabase client factories are
   deleted.

10. **Remove**: `lib/client/hooks/use-auth.ts` — replaced by `useSession()`.

**Verification:**
- Sign up with email+password → `users` row created + profile populated.
- Sign in → JWT cookie set, all API routes accessible.
- Sign out → cookie cleared, API routes return 401.
- Existing anonymous/localStorage flow still works (no regression).
- The `use-sync-enabled.ts` gate now checks for Auth.js session instead
  of Supabase session.

### Phase 3 — API layer for sync + CRUD (≈ 2 days)

**Goal**: Replace PostgREST with direct `pg` queries behind API routes.
The sync queue and reconcile hooks POST to these routes instead of
calling `supabase-js` directly.

**What changes:**

1. **Sync proxy** — `app/api/sync/batch/route.ts`:
   ```ts
   import { auth } from "@/server/auth"
   import { getPool } from "@/server/db/pool"
   
   export async function POST(req: Request) {
     const session = await auth()
     if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 })
     
     const { ops } = await req.json() // SyncOp[]
     const pool = getPool()
     const client = await pool.connect()
     try {
       await client.query("BEGIN")
       for (const op of ops) {
         switch (op.type) {
           case "upsert":
             await upsertRow(client, session.user.id, op)
             break
           case "delete":
             await deleteRow(client, session.user.id, op)
             break
         }
       }
       await client.query("COMMIT")
       return Response.json({ ok: true })
     } catch (e) {
       await client.query("ROLLBACK")
       throw e
     } finally {
       client.release()
     }
   }
   ```
   The `upsertRow`/`deleteRow` functions are simple SQL builders
   keyed by entity type. Every statement includes `WHERE user_id = $1`.

2. **Snapshot endpoint** — `app/api/sync/snapshot/route.ts`:
   Returns all 16 tables as one JSON blob (the same shape as the
   current `fetchCloudSnapshot`). Called by the reconcile hook.

3. **Sync queue rewrite** — `lib/client/sync/sync-queue.ts`:
   Replace `supabase.from(table).upsert(...)` with `fetch("/api/sync/batch", { method: "POST", body: JSON.stringify({ ops }) })`.

4. **Reconcile rewrite** — `lib/client/sync/reconcile.ts`:
   Replace 16 parallel `supabase.from(table).select("*")` calls with a
   single `fetch("/api/sync/snapshot")`.

5. **Server routes** — adapt existing API routes to use `pg`:
   - `/api/mcp/server/route.ts` → `pool.query("INSERT INTO mcp_servers ...")`
   - `/api/mcp/[serverId]/[action]/route.ts` → `pool.query("SELECT ... FROM mcp_servers WHERE id = $1 AND user_id = $2")`
   - `/api/share/route.ts` → `pool.query("INSERT INTO shares ...")`
   - `/api/share/[token]/route.ts` → `pool.query("UPDATE shares SET revoked_at = now() WHERE token = $1 AND user_id = $2")`
   - `/api/chat` → `loadMcpServers()` (already server-side, just swap
     the Supabase client for `pg` in `lib/server/mcp/load-servers.ts`)
   - `lib/server/mcp/credentials.ts` → the RPC calls
     (`mcp_get_decrypted_credentials`, `mcp_upsert_server_with_credentials`)
     become regular SQL functions called via `pool.query("SELECT ...")`.
     The encryption key is passed from the server env, same as today.

6. **File search skill** — `/api/chat`'s `searchFiles` tool:
   Replace `supabase.rpc("search_file_sections", ...)` with direct SQL:
   ```ts
   await pool.query("SELECT * FROM search_file_sections($1, $2, $3)", [p_user_id, p_file_id, p_query_query])
   ```
   (The RPC function stays in Postgres; we just call it differently.)

7. **Remove**: `@supabase/supabase-js`, `@supabase/ssr` from
   dependencies. `lib/shared/supabase/types.ts` is replaced by
   hand-written or generated types from the raw schema.

**Verification:**
- Sync: make a local change → sync queue POSTs to `/api/sync/batch` →
  row appears in Postgres directly.
- Reconcile: sign in on a fresh browser → `/api/sync/snapshot` returns
  the user's state → Zustand store populates.
- All server API routes still work (chat, MCP, share, file search).
- RLS equivalent: a second user's request is rejected because the
  `WHERE user_id = $1` clause returns zero or no rows.

### Phase 4 — Storage replacement (≈ 1 day)

**Goal**: Replace Supabase Storage with MinIO or S3.

**What changes:**

1. **New dependency**: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.

2. **New file** `lib/server/storage/s3-client.ts`:
   ```ts
   import { S3Client } from "@aws-sdk/client-s3"
   
   export function getS3Client() {
     return new S3Client({
       endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
       region: process.env.S3_REGION ?? "us-east-1",
       credentials: {
         accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
         secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
       },
       forcePathStyle: true, // Required for MinIO
     })
   }
   ```

3. **New S3 API routes** (or extend existing ones):
   - `POST /api/files/upload` — multipart upload → S3 `PutObject`.
     Returns `{ key, signedUrl }`.
   - `GET /api/files/download?key=...` — creates a presigned GET URL.
   - These replace the current `storage.from('user-files').upload()` and
     `createSignedUrl()` calls.

4. **Client rewrites**:
   - `lib/client/files/persist.ts`: `storage.from('user-files').upload()`
     → `fetch("/api/files/upload", { method: "POST", body: formData })`.
   - `lib/client/files/fetch-blob.ts`: `createSignedUrl()`
     → `fetch("/api/files/download?key=...")`.
   - `lib/client/hooks/use-upload-file.ts`: same pattern.
   - `lib/server/image-storage.ts`: `storage.from('user-files').upload()`
     → direct `PutObject` via the server-side S3 client.

5. **Docker Compose** — add MinIO:
   ```yaml
   minio:
     image: minio/minio:latest
     ports: ["9000:9000", "9001:9001"]
     environment:
       MINIO_ROOT_USER: minioadmin
       MINIO_ROOT_PASSWORD: minioadmin
     command: server /data --console-address ":9001"
     volumes:
       - minio-data:/data
   ```
   The bucket (`user-files`) is created programmatically on first API
   call (if not exists) or via an init script.

6. **Remove**: the `0003_storage.sql` migration — it creates `storage`
   schema objects that are Supabase-specific. The new storage is purely
   S3; no Postgres tables needed.

**Verification:**
- Upload a file → stored in MinIO/S3 at `{userId}/{fileId}.{ext}`.
- Download → signed URL resolves.
- Image generation → generated image stored, signed URL created.
- RLS equivalent: the S3 key prefix (`{userId}/`) prevents cross-user
  access (the API route enforces `userId` matches the authenticated user).

### Phase 5 — Cleanup & harden (≈ 1 day)

**Goal**: Remove all remaining Supabase traces, harden the auth layer,
and update docs.

**What changes:**

1. **Remove** from `package.json`:
   - `@supabase/supabase-js`, `@supabase/ssr`
   - All `supabase:*` scripts → replaced by `migrate`, `pg:*` scripts.

2. **Remove files**:
   - `lib/client/supabase/`, `lib/server/supabase/`, `lib/shared/supabase/`
     (three directories, 6 files total).
   - `docker-compose.supabase.yml`
   - `.docker/supabase/`
   - `supabase/migrations/` → move to `migrations/` (keep the SQL files,
     they're still valid).
   - `docs/SUPABASE_SETUP.md`, `docs/SUPABASE_LOCAL.md`, `docs/SUPABASE_TEST.md`
     → rewrite as `docs/SELF_HOSTED_SETUP.md`.

3. **Harden user scoping** — audit every `pool.query()` call in the
   codebase. Verify every one that reads/writes user data includes
   `WHERE user_id = $1` (or equivalent). Write an ESLint rule or a
   one-shot `grep` script for CI.

4. **Profile auto-creation** — on first sign-in, if no profile row
   exists for the user, create one. This was previously handled by the
   `on_auth_user_created` trigger in `0002_rls_policies.sql`.

5. **Remove RLS policies** — `0002_rls_policies.sql` is no longer
   needed (no GoTrue, so no `auth.uid()`). Drop it from the migration
   sequence.

6. **Update**: `CLAUDE.md`, `ROADMAP.md`, `BACKLOG.md` to reflect the
   new stack.

**Verification:**
- `grep -r "supabase" src/ lib/ app/ docs/` returns only historical
  references (plans, roadmap entries), no active code.
- `bun run check` passes.
- End-to-end: sign up → sync data → sign out → sign in on another device
  → data survives.
- Anonymous mode still works (localStorage only, no API routes touched).

## Total effort

| Phase | What | Days | Depends on |
|---|---|---|---|
| 0 | Decision gates | 1 conversation | — |
| 1 | Database direct access | 1.5 | Phase 0 |
| 2 | Auth replacement | 2 | Phase 1 |
| 3 | API layer for sync + CRUD | 2 | Phase 2 |
| 4 | Storage replacement | 1 | Phase 2 |
| 5 | Cleanup & harden | 1 | Phases 3, 4 |
| **Total** | | **~7.5 days** | |

Phases 3 and 4 can run in parallel after Phase 2 lands (different files,
no shared state).

## Risks

1. **Auth.js v5 stability** — v5 is still in beta. The credentials
   provider is stable, but the middleware API has shifted. Mitigation:
   pin a specific beta version and test thoroughly. Fallback: use a
   lightweight JWT library (`jose`) + hand-written auth routes (~150
   lines). Auth.js is a convenience, not a requirement.

2. **Sync queue reliability** — currently the sync queue has exponential
   backoff and permanent-failure detection. The same logic ports to the
   new `/api/sync/batch` endpoint, but the error taxonomy changes:
   PostgREST errors (PGRST codes) become Postgres errors (SQLSTATE).
   Mitigation: map the 5 SQLSTATE codes that matter (23505 unique
   violation → duplicate/upsert, 23503 FK violation, etc.) in the
   permanent-failure detector.

3. **RLS semantics gap** — RLS enforced `user_id = auth.uid()` at the
   database level, making it impossible to query another user's data
   even with a buggy SQL query. After migration, every query must
   include `WHERE user_id = $1`. One missed filter is a cross-user data
   leak. Mitigations:
   - Lint rule: `pg.query()` without `user_id` in the WHERE clause → error.
   - The `withUserScope(client, userId, fn)` wrapper that rejects
     queries without a SET app.current_user_id GUC.
   - CI audit: a script that inspects all SQL strings for `user_id`.

4. **Migration ordering** — the current migrations reference
   `auth.users(id)` in FK constraints. Phase 2's `0012_users.sql` must
   run before any migration that references `auth.users`. Since this
   plan assumes net-new deployments (not migrating existing Supabase
   data), the migration files can be reordered/renumbered.

5. **Anonymous mode breakage** — the app must still work in anonymous
   mode (localStorage only, no sign-in). The new API routes should
   gracefully handle unauthenticated requests (return 401 for sync
   operations, but never crash the app).

6. **Local dev complexity** — today `bun dev` + `supabase start` runs
   everything. After migration: `bun dev` + `docker compose -f docker-
   compose.postgres.yml up -d` + MinIO. One extra service (MinIO), but
   one less container in total (7 → 2).

## Decision — what this plan does NOT cover

- **Data migration from existing Supabase projects.** This plan is for
  greenfield deployments that never used Supabase. Migrating existing
  user data is a separate concern (dump `public.*` tables from Supabase,
  re-import into raw Postgres, handle the `auth.users` → `users` FK
  shift).

- **What to do about pgvector.** The `PLAN-local-rag.md` decision is
  orthogonal — pgvector is a Postgres extension, not a Supabase feature.
  The FTS fallback (Option Ø) works identically on raw Postgres.

- **Replacing the Supabase Studio UI.** A Postgres GUI is optional.
  Tools like DBeaver, pgAdmin, or `psql` fill this gap.

- **Email sending for magic links.** The current codebase doesn't
  actually use magic links (it's email+password, despite the env var
  comments). If magic links are desired later, a transactional email
  provider (Resend, Postmark) wires into Auth.js's email provider.

## Recommendation

**Do Phase 0 first** — a single conversation to lock in the stack
choices (Auth.js vs. hand-rolled JWT, MinIO vs. R2, migration runner
choice). The rest of the plan is detailed enough to execute but those
three decisions gate everything.

**Start with Phase 1** regardless of auth/storage choices. Standing up
raw Postgres + a migration runner is the foundation. It can even
ship as a parallel dev option (run against Supabase OR raw Postgres by
setting env vars) while the other phases land.

If the migration is approved, this plan should be re-evaluated when
`PLAN-local-rag.md`'s vector decision is made — pgvector on raw Postgres
vs. pgvector on Supabase has different operational implications (index
management, connection pooling, vacuuming).
