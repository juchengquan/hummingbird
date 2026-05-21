-- ---------------------------------------------------------------------------
-- MCP (Model Context Protocol) — workspace-scoped server bindings, the
-- resources they expose, and the two attachment lanes (workspace +
-- conversation-private) that mirror the file lanes from 0001/0004.
--
-- See `docs/PLAN-mcp-integration.md` and `docs/PLAN-mcp-stage-3.md` for
-- the design rationale. Credential storage is dual-mode:
--   - 'local' → cred lives in the client's localStorage; this table
--     only carries a stable `credential_fingerprint` so two devices
--     can tell whether they share creds without sharing them.
--   - 'cloud' → cred lives encrypted in `credentials_encrypted` via
--     pgcrypto's `pgp_sym_encrypt`. The encryption key lives in the
--     Next.js server env (`MCP_ENCRYPTION_KEY`) and is passed as an
--     argument to the SECURITY DEFINER helpers below.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

create table public.mcp_servers (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  url text not null,
  transport text not null check (transport in ('http')),
  credential_mode text not null check (credential_mode in ('cloud', 'local')),
  -- For cloud mode: ciphertext of the JSON credential (headers etc.).
  -- For local mode: NULL — cred lives in the client.
  credentials_encrypted bytea,
  -- For local mode: a short SHA-256 prefix of the cred so cross-device
  -- sync can detect "definitely the same cred" vs "different".
  -- For cloud mode: NULL.
  credential_fingerprint text,
  capabilities jsonb,
  capabilities_fetched_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft-delete marker (matches files.deleted_at semantics).
  deleted_at timestamptz,
  -- Invariant: each row carries cred storage in exactly one place.
  constraint mcp_servers_cred_shape check (
    (credential_mode = 'cloud' and credential_fingerprint is null)
    or
    (credential_mode = 'local' and credentials_encrypted is null)
  )
);

-- A resource pointer cached from an MCP server's `resources/list`. The
-- actual content is fetched on demand via `readResource` — these rows
-- store only the addressing tuple.
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
  -- Idempotent re-discovery: hitting `resources/list` twice doesn't
  -- duplicate rows. Matches the client-side `upsertMcpResource`
  -- behaviour added in Stage 1.
  unique (server_id, uri)
);

-- Workspace-library lane (parallel to `resources` for files).
create table public.mcp_resource_bindings (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  resource_id uuid not null references public.mcp_resources(id) on delete cascade,
  added_at timestamptz not null default now(),
  -- One binding per (workspace, resource). Re-add is a no-op.
  unique (workspace_id, resource_id)
);

-- Conversation-private lane (parallel to `conversation_files`).
create table public.conversation_mcp_resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  resource_id uuid not null references public.mcp_resources(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (conversation_id, resource_id)
);

-- RLS — own your rows, same pattern as every other table.
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

-- Partial indexes — common query is "give me live (non-tombstoned) rows".
create index mcp_servers_workspace_live on public.mcp_servers (workspace_id)
  where deleted_at is null;
create index mcp_resources_server on public.mcp_resources (server_id)
  where deleted_at is null;
create index mcp_resource_bindings_workspace
  on public.mcp_resource_bindings (workspace_id);
create index conversation_mcp_resources_conversation
  on public.conversation_mcp_resources (conversation_id);

-- ---------------------------------------------------------------------------
-- Encryption helpers
--
-- `mcp_get_decrypted_credentials` returns the decrypted JSON cred for a
-- single server, but only when the caller owns the row. The `auth.uid()`
-- check inside the function gives the same row-ownership guarantee as
-- RLS — even though the function runs with elevated privilege it refuses
-- to decrypt rows belonging to a different user.
--
-- `mcp_upsert_server_with_credentials` performs the encrypt-and-write
-- atomically so the client never holds plaintext-roundtripped-via-DB. The
-- key is passed by the application server (NOT stored in Postgres) — see
-- `docs/PLAN-mcp-stage-3.md` "Encryption design" for the trade-off note.
-- ---------------------------------------------------------------------------

create or replace function public.mcp_get_decrypted_credentials(
  p_server_id uuid,
  p_key text
)
returns jsonb
language plpgsql
security definer
-- Pin search_path to defend against schema-shadowing attacks if a
-- malicious user creates an `auth` or `mcp_servers` object in their
-- own schema and changes the session search_path. Standard Supabase
-- hardening pattern for SECURITY DEFINER functions.
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
begin
  select pgp_sym_decrypt(credentials_encrypted, p_key)::jsonb
  into v_result
  from public.mcp_servers
  where id = p_server_id
    and user_id = auth.uid()
    and credentials_encrypted is not null;
  return v_result;
end;
$$;

revoke all on function public.mcp_get_decrypted_credentials(uuid, text)
  from public;
grant execute on function public.mcp_get_decrypted_credentials(uuid, text)
  to authenticated;

create or replace function public.mcp_upsert_server_with_credentials(
  p_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_url text,
  p_credentials jsonb,
  p_key text,
  p_capabilities jsonb default null,
  p_enabled boolean default true
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.mcp_servers (
    id, user_id, workspace_id, name, url, transport,
    credential_mode, credentials_encrypted,
    capabilities, capabilities_fetched_at, enabled,
    created_at, updated_at
  )
  values (
    p_id, auth.uid(), p_workspace_id, p_name, p_url, 'http',
    'cloud', pgp_sym_encrypt(p_credentials::text, p_key),
    p_capabilities,
    case when p_capabilities is null then null else now() end,
    p_enabled,
    now(), now()
  )
  on conflict (id) do update set
    workspace_id = excluded.workspace_id,
    name = excluded.name,
    url = excluded.url,
    credentials_encrypted = pgp_sym_encrypt(p_credentials::text, p_key),
    capabilities = coalesce(excluded.capabilities, public.mcp_servers.capabilities),
    capabilities_fetched_at = case
      when excluded.capabilities is null then public.mcp_servers.capabilities_fetched_at
      else now()
    end,
    enabled = excluded.enabled,
    updated_at = now()
  where public.mcp_servers.user_id = auth.uid();
end;
$$;

revoke all on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean
) from public;
grant execute on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean
) to authenticated;
