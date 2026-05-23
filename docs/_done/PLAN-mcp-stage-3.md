# Plan: MCP Stage 3 — cloud credentials, resource lanes, sync

Status: **shipped** (Stages 3a / 3b / 3c).

Finishes the MCP integration. After this stage:

- **Cloud-mode credentials work end-to-end** — encrypted in Postgres,
  decrypted only server-side, never round-trip the client.
- **MCP resources attach to conversations** alongside files — a new
  "MCP" tab in the resources sidebar, two-lane model (workspace +
  conversation-private) matching the file lanes.
- **Resource content is injected into chat turns** — fetched
  server-side at request time, budgeted, with graceful fallback when
  a resource is unavailable.
- **All four MCP slices sync via Supabase** — multi-device support
  for server configs, cached resources, bindings, and conversation
  joins.

Stage 1 (data model + UI scaffolding) and Stage 2 (proxy + tool calls
with local-mode creds) are already shipped. This stage builds on
those without touching the Stage 1 / Stage 2 surface area beyond the
listed extensions.

## What works in both local and cloud Supabase

The same migration file runs identically against both targets. Two
deployment paths:

### Local (Supabase CLI, recommended for dev)

Already covered by `docs/SUPABASE_LOCAL.md`. Add to that doc:

1. Drop the new migration file into `supabase/migrations/0005_mcp.sql`.
   Re-run `bun run supabase:reset` (or `supabase db reset`) — the CLI
   picks it up automatically.
2. Add `MCP_ENCRYPTION_KEY` to `.env.local`. Generate one with
   `openssl rand -base64 32`. Same key for every run; rotating it
   invalidates existing cloud-mode creds (re-add the server).
3. `pgcrypto` is enabled inside the migration via `create extension
   if not exists pgcrypto;` — no separate step needed.

### Local (docker-compose, for fully offline dev)

`.docker/supabase/apply-migrations.sh` already iterates over
`supabase/migrations/*.sql` in order. Same migration, same
`MCP_ENCRYPTION_KEY` env var in `.env.docker`. No script changes.

### Cloud (hosted Supabase)

`docs/SUPABASE_SETUP.md` gets an extra step:

1. Run `0005_mcp.sql` in the SQL Editor (after the existing four
   migrations). The migration enables `pgcrypto` itself — no manual
   extension toggle needed.
2. Set `MCP_ENCRYPTION_KEY` in the Next.js deployment's env (Vercel
   project secrets, Fly secrets, whatever you use). **Not** in
   Supabase itself — see the encryption design below for why the key
   lives in the application tier.
3. **Recommended:** use Supabase Vault for the key in production
   (one extra row in `vault.secrets`), but ad-hoc env var works for
   v1.

### Verification (both paths)

After applying the migration and setting the env var:

```sql
-- in psql or Supabase SQL editor
select pg_extension.extname from pg_extension where extname = 'pgcrypto';
-- expect: 1 row, 'pgcrypto'

select tablename from pg_tables
where tablename in (
  'mcp_servers',
  'mcp_resources',
  'mcp_resource_bindings',
  'conversation_mcp_resources'
);
-- expect: 4 rows

select policyname from pg_policies
where tablename in (
  'mcp_servers',
  'mcp_resources',
  'mcp_resource_bindings',
  'conversation_mcp_resources'
);
-- expect: 4 rows, one "own ..." policy per table
```

And the smoke test in the app: add a server, enable cloud mode,
confirm Discovery succeeds. Then sign in on a second browser; the
server config should appear with the cred available.

## Encryption design

### Where the key lives

The encryption key (`MCP_ENCRYPTION_KEY`, 32 bytes random) lives in
the **Next.js server environment**, not in Postgres. Three reasons:

1. **Single source of truth for rotation.** Updating one env var
   rotates encryption across both local and cloud Supabase setups
   without re-running ALTER DATABASE on each environment.
2. **Local dev simplicity.** Developer sets one `MCP_ENCRYPTION_KEY`
   in `.env.local` — no separate SQL bootstrap step.
3. **Defense in depth.** A read-only attacker with DB credentials
   sees ciphertext only; getting plaintext requires also breaching
   the application tier.

The key gets passed as a function argument on every decrypt call —
see the trade-off note below.

### Trade-off: function argument vs session setting

Passing the key as a function argument is theoretically visible if
someone enables `log_min_duration_statement = 0` or
`pg_stat_statements`. The alternative pattern is `ALTER DATABASE
postgres SET app.mcp_encryption_key TO '...';` plus `current_setting()`
inside the function, which keeps the key out of statement text.

For v1 we ship the argument-passing pattern (simpler, works locally
without extra DB setup). Hardening to session settings is a one-file
follow-up if statement-logging audit ever becomes a concern. Document
the trade-off in `docs/SUPABASE_SETUP.md`.

### SECURITY DEFINER function

```sql
create or replace function public.mcp_get_decrypted_credentials(
  p_server_id uuid,
  p_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  select pgp_sym_decrypt(credentials_encrypted, p_key)::jsonb
  into v_result
  from public.mcp_servers
  where id = p_server_id
    and user_id = auth.uid()       -- RLS-equivalent check
    and credentials_encrypted is not null;
  return v_result;
end;
$$;

revoke all on function public.mcp_get_decrypted_credentials(uuid, text)
  from public;
grant execute on function public.mcp_get_decrypted_credentials(uuid, text)
  to authenticated;
```

Two parallel functions for write:

```sql
create or replace function public.mcp_upsert_server_with_credentials(
  p_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_url text,
  p_credentials jsonb,
  p_key text,
  p_capabilities jsonb default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.mcp_servers (
    id, user_id, workspace_id, name, url, transport,
    credential_mode, credentials_encrypted, capabilities,
    capabilities_fetched_at, enabled,
    created_at, updated_at
  )
  values (
    p_id, auth.uid(), p_workspace_id, p_name, p_url, 'http',
    'cloud', pgp_sym_encrypt(p_credentials::text, p_key), p_capabilities,
    case when p_capabilities is null then null else now() end, true,
    now(), now()
  )
  on conflict (id) do update set
    workspace_id = excluded.workspace_id,
    name = excluded.name,
    url = excluded.url,
    credentials_encrypted = pgp_sym_encrypt(p_credentials::text, p_key),
    capabilities = coalesce(excluded.capabilities, public.mcp_servers.capabilities),
    capabilities_fetched_at = coalesce(
      case when excluded.capabilities is null then null else now() end,
      public.mcp_servers.capabilities_fetched_at
    ),
    updated_at = now()
  where public.mcp_servers.user_id = auth.uid();
end;
$$;

revoke all on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb
) from public;
grant execute on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb
) to authenticated;
```

The `auth.uid()` filter inside the function gives the same row-
ownership guarantee as RLS — the function refuses to decrypt rows
the caller doesn't own.

## Migration `supabase/migrations/0005_mcp.sql`

Schema sketch (full SQL goes in the file):

```sql
create extension if not exists pgcrypto;

create table public.mcp_servers (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  url text not null,
  transport text not null check (transport in ('http')),
  credential_mode text not null check (credential_mode in ('cloud', 'local')),
  credentials_encrypted bytea,
  credential_fingerprint text,
  capabilities jsonb,
  capabilities_fetched_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Invariant: cloud-mode rows have a cred ciphertext; local-mode
  -- rows have a fingerprint (cred lives in the client).
  constraint mcp_servers_cred_shape check (
    (credential_mode = 'cloud' and credential_fingerprint is null)
    or
    (credential_mode = 'local' and credentials_encrypted is null)
  )
);

create table public.mcp_resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  server_id uuid not null references public.mcp_servers(id) on delete cascade,
  uri text not null,
  name text not null,
  description text,
  mime_type text,
  added_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (server_id, uri)            -- idempotent re-discovery
);

create table public.mcp_resource_bindings (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  resource_id uuid not null references public.mcp_resources(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (workspace_id, resource_id)
);

create table public.conversation_mcp_resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  resource_id uuid not null references public.mcp_resources(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (conversation_id, resource_id)
);

-- One per table, same pattern as everything else.
alter table public.mcp_servers enable row level security;
create policy "own mcp_servers" on public.mcp_servers
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.mcp_resources enable row level security;
create policy "own mcp_resources" on public.mcp_resources
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.mcp_resource_bindings enable row level security;
create policy "own mcp_resource_bindings" on public.mcp_resource_bindings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.conversation_mcp_resources enable row level security;
create policy "own conversation_mcp_resources" on public.conversation_mcp_resources
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live-row indexes (partial, skip tombstones).
create index mcp_servers_workspace_live on public.mcp_servers (workspace_id)
  where deleted_at is null;
create index mcp_resources_server on public.mcp_resources (server_id)
  where deleted_at is null;
create index mcp_resource_bindings_workspace
  on public.mcp_resource_bindings (workspace_id);
create index conversation_mcp_resources_conversation
  on public.conversation_mcp_resources (conversation_id);

-- The two helper functions (decrypt + upsert) defined above.
-- ...
```

The two `unique` constraints (`mcp_resources(server_id, uri)`,
`mcp_resource_bindings(workspace_id, resource_id)`,
`conversation_mcp_resources(conversation_id, resource_id)`) match the
client-side idempotency checks added in Stage 1 — re-discovery and
double-attach are silent no-ops on both sides.

## Server-side cred resolution

### Where the chat route gets the server list

After Stage 2, the chat route receives **local-mode** servers in the
request body. After Stage 3, it also needs **cloud-mode** servers
from Supabase. Both lists merge, both contribute tools.

New helper `lib/server/mcp/load-servers.ts`:

```ts
export async function loadEffectiveMcpServers(
  req: NextRequest,
  workspaceId: string,
  localServers: McpRequestServer[]
): Promise<EffectiveMcpServer[]> {
  // 1. local-mode: passed through as-is, cred already attached
  const out: EffectiveMcpServer[] = localServers.map(toEffective)

  // 2. cloud-mode: only available when the user has a Supabase session
  const supabase = getServerSupabaseClient(req)
  if (!supabase) return out

  const { data: rows } = await supabase
    .from('mcp_servers')
    .select('id, name, url, transport, capabilities')
    .eq('workspace_id', workspaceId)
    .eq('credential_mode', 'cloud')
    .eq('enabled', true)
    .is('deleted_at', null)

  for (const row of rows ?? []) {
    const cred = await fetchDecryptedCred(supabase, row.id)
    if (!cred) continue   // no cred → skip silently
    out.push({ ...row, credentials: cred })
  }
  return out
}

async function fetchDecryptedCred(
  client: SupabaseClient,
  serverId: string
): Promise<McpCredentials | null> {
  const key = process.env.MCP_ENCRYPTION_KEY
  if (!key) return null
  const { data, error } = await client.rpc('mcp_get_decrypted_credentials', {
    p_server_id: serverId,
    p_key: key,
  })
  if (error || !data) return null
  return data as McpCredentials
}
```

Reuses `getServerSupabaseClient` from `lib/server/supabase/server.ts`
(which already cookies-parses the session). The chat route gets a
single call: `await loadEffectiveMcpServers(req, workspaceId, body.mcpServers ?? [])`.

### Proxy route extension

`app/api/mcp/[serverId]/[action]/route.ts` (Stage 2 supports
`X-MCP-Credentials` header for local mode). Stage 3 adds: when the
header is absent, look up the row in Supabase by `serverId`, decrypt,
forward. Returns 401 when there's no session and no header.

Pseudo:
```ts
let credentials = decodeCredentialHeader(req.headers.get(MCP_CRED_HEADER))
let serverFromDb: McpServer | null = null
if (!credentials) {
  const supabase = getServerSupabaseClient(req)
  if (!supabase) return NextResponse.json({ error: 'no_session' }, { status: 401 })
  // Fetch row + decrypted cred in two calls (could fold into one RPC).
  serverFromDb = await fetchServerById(supabase, serverId)
  if (!serverFromDb) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  credentials = await fetchDecryptedCred(supabase, serverId)
}
// Existing Stage 2 dispatch using `credentials` + `serverFromDb ?? body.server`
```

## Resource attachment

### Store + UI

Stage 1 already added the four slices and the mutators. Stage 3 lights
up the **UI** that exercises them.

New tab in the resources sidebar — extend the `resourcesSidebarTab`
union (already done in Stage 1):

```ts
'files' | 'notes' | 'artifacts' | 'skills' | 'pins' | 'mcp'
```

New tab body: `components/panels/mcp-tab.tsx`. Layout mirrors the
files tab:

- **"This conversation"** stack on top — `useConversationPrivateMcpResources()`
  rendered as rows. Per-row Remove button calls
  `removeConversationMcpResource`.
- **"Workspace MCP resources"** stack below — `useWorkspaceMcpResources()`
  rendered as tickable rows. Tick state comes from
  `useConversationSelectedMcpResourceIds()`; toggle calls
  `toggleConversationMcpResourceSelection`.
- **"Add resource" picker** — opens a small dialog listing every
  resource grouped by server (`server.capabilities.resources`),
  filterable. Picking one calls `upsertMcpResource` (cache the
  pointer) + either `addConversationMcpResource` (private) or
  `addMcpResourceBinding` (workspace) depending on which section
  the picker was opened from.

The icon column in the resources sidebar (`components/sidebars/resources.tsx`)
gains a Plug-icon entry (or similar from Lucide) for the new tab.

### Chat-route payload merge

`app/api/chat/route.ts` currently builds the system prompt from
`body.files`. Stage 3 also resolves and injects attached MCP
resources. The flow:

1. From the request body, collect `attachedMcpResourceIds` —
   union of (workspace-ticked via `selectedMcpResourceIds`) +
   (conversation-pinned via `conversationMcpResources`).
2. Look each one up against the effective server list (local + cloud).
3. Call `readResource(server, cred, uri)` concurrently with
   `Promise.allSettled` and a 5s per-call timeout.
4. Inject the text content into the system prompt under a synthetic
   `--- {server.name}: {resource.name} ---` header, sharing the
   `TOTAL_ATTACHMENT_BUDGET` with files (file budget gets priority;
   MCP resources fill the remainder).
5. On timeout / error: replace the body with an inline
   `[MCP resource "X" unavailable — server returned <error>]`
   so the model knows the resource was attempted.

New helper `lib/server/mcp/inject-resources.ts` keeps the logic out
of the route file.

The client adds the resource ids + server-id mapping to the request
body so the route knows which server owns each resource. New
schema fragment:

```ts
mcpResources: z.array(z.object({
  id: z.string(),                    // McpResource.id
  serverId: z.string(),
  uri: z.string(),
  name: z.string(),                  // for the prompt header + error message
  mimeType: z.string().optional(),
})).max(20).optional()
```

Client populates from `useConversationSelectedMcpResourceIds()` +
`useConversationPrivateMcpResources()`, joined against the workspace
resource cache, de-duped.

## Sync handlers

New diff functions in `lib/client/sync/handlers.ts`:

- `diffMcpServers(prev, next)` — handles tombstones via `deleted_at`.
  For cloud-mode servers with a newly-set local cred, switches the
  upsert to call `supabase.rpc('mcp_upsert_server_with_credentials', ...)`
  with the cred pulled from `localStorage` *one last time* before
  writing (the cred then lives only in Supabase encrypted; the local
  copy gets cleared via `removeLocalCred(serverId)`). Plain upsert
  to `mcp_servers` works for local-mode rows and metadata-only
  changes to cloud-mode rows.
- `diffMcpResources(prev, next)` — straightforward upsert / delete /
  tombstone.
- `diffMcpResourceBindings(prev, next)` — same shape as `diffResources`.
- `diffConversationMcpResources(prev, next)` — same shape as
  `diffConversationFiles`.

Wire into `lib/client/hooks/use-sync.ts` alongside the existing diffs.
Snapshot type gains the four new slices.

`fetchCloudSnapshot` in `lib/client/sync/reconcile.ts` pulls all four
tables. **It does not pull `credentials_encrypted`** — that column
stays server-side. Cloud-mode servers come back with no `credentials`
field on the store; the chat route handles the decrypt at request time.

`bulkUploadLocalState` ships new tables in order:
servers → resources → bindings → conversation joins. For cloud-mode
servers in the local snapshot, calls `mcp_upsert_server_with_credentials`
with the cred from `localStorage`, then clears the local cred (now
the canonical copy lives in the cloud, encrypted).

## Generated types + docs

- `lib/shared/supabase/types.ts` — add the four tables and the two RPC
  function signatures.
- `CLAUDE.md` — bump migration count to five.
- `docs/SUPABASE_SETUP.md` — add the `MCP_ENCRYPTION_KEY` step, the
  recommended Vault path, and the verification SQL.
- `docs/SUPABASE_LOCAL.md` — add the local env-var step.
- `docs/PLAN-mcp-integration.md` — mark Stage 3 complete in the final
  commit.

## Phasing inside Stage 3

Three sub-commits so each is independently reviewable:

| Sub-stage | Scope | Lines |
|---|---|---|
| **3a** | Migration + encryption: SQL file, generated types, env var docs, server-side `loadEffectiveMcpServers` + `fetchDecryptedCred`. Proxy route extended for cloud lookup. Chat route uses the merged server list for tool calls. Add-server dialog re-enables the Cloud radio. | ~350 |
| **3b** | Resource lanes UI: new MCP tab, picker dialog, mount in resources sidebar. Chat-route payload merge for resource content injection (concurrent read, 5s timeout, budget). | ~250 |
| **3c** | Sync handlers + reconcile pulls + bulk upload. Multi-device verified. | ~250 |

Each sub-stage typechecks + lints clean before the next starts. **3a
unlocks cloud-mode end-to-end**, which is the biggest user-visible
shift — would be a reasonable place to PR + pause for review before
3b / 3c.

## Verification

End-to-end smoke (do this after deploying 3c, manually walked):

1. **Schema applied (local + cloud).** Verification SQL above passes.
2. **Env var set.** `process.env.MCP_ENCRYPTION_KEY` non-empty in the
   Next.js server. Confirm with a one-off log line on first decrypt.
3. **Local-mode roundtrip still works** (regression check from
   Stage 2). Add a local-mode server, discover, call a tool from
   chat — same UX as before.
4. **Cloud-mode add.** Add a server with the Cloud radio. Token
   stored encrypted in `mcp_servers.credentials_encrypted`. Check
   via SQL: `select credentials_encrypted is not null, credential_fingerprint from mcp_servers where id = '<id>'`
   — expect `true, NULL`.
5. **Cloud-mode discovery.** Refresh capabilities; proxy route uses
   the encrypted cred. Confirm with a deliberate auth failure
   (delete the row's `credentials_encrypted`) — discover should 502
   gracefully, not crash.
6. **Cloud-mode tool call.** Send a chat that should invoke a tool;
   confirm the tool-call pill renders with the right server name and
   the result arrives.
7. **Resource attach.** Add a resource to the workspace lane, tick
   it for a conversation, send a message that needs that resource —
   confirm the model has access (its answer references the content).
8. **Resource read failure handled.** Block the MCP endpoint
   temporarily; confirm the system prompt includes the
   "unavailable" marker for that resource and the chat still
   succeeds.
9. **Multi-device sync.** On a second browser signed in as the same
   user: server appears, capabilities cached, resource bindings
   visible, tool calls work.
10. **Sign-out preserves local.** Sign out on device A; local-mode
    server config (local cred only) persists in localStorage and
    still works.
11. **Tombstone cascade.** Remove a server; all dependent rows
    (resources, bindings, conversation joins) tombstone/drop
    atomically, both locally and on Supabase.
12. **RLS sanity.** As user A, try to query
    `select * from mcp_servers where user_id = '<user B id>'` —
    expect zero rows.

## Out of scope (carry-over)

Unchanged from `docs/PLAN-mcp-integration.md`:

- stdio transport (cloud serverless can't host long-running
  subprocesses).
- OAuth 2.1 PKCE per the MCP auth spec (bearer-token v1 ships first;
  OAuth can land as a `credentialMode = 'oauth'` variant later).
- MCP prompts (the third MCP primitive). Lower priority for the
  chat-centric UX; could land as a "saved prompts" entry in skills.
- Per-tool toggles (v1 toggles per server only).
- Resource pre-caching (v1 fetches on-demand at chat time).
- Polymorphic merge with files (separate lanes for now).
- Hardening the encryption key from function-argument to
  session-setting / Vault pattern. One-file follow-up if
  statement-logging audit becomes a concern.
