-- verify-supabase-types: skip (function bodies + private helpers only; public signatures unchanged)
-- 0038_mcp_pgcrypto_schema.sql — make the MCP credential RPCs find pgcrypto.
--
-- `mcp_get_decrypted_credentials` (0005) and
-- `mcp_upsert_server_with_credentials` (0005 → 0024 → 0031) call
-- `pgp_sym_decrypt` / `pgp_sym_encrypt` unqualified under a pinned
-- `search_path = pg_catalog, public`. 0005's `create extension if not
-- exists pgcrypto` only puts the functions in `public` when the
-- extension wasn't installed yet. On Supabase — hosted, the CLI stack
-- and the `supabase/postgres` image in docker-compose.supabase.yml —
-- pgcrypto is pre-installed in the `extensions` schema, so that
-- statement is a no-op and both RPCs fail with
-- `function pgp_sym_encrypt(text, text) does not exist`: cloud-mode MCP
-- credentials can be neither saved nor read. Plain Postgres (pgcrypto
-- created by 0005 into `public`) happened to work.
--
-- Fix: two tiny wrappers in the non-exposed `private` schema whose
-- bodies call pgcrypto SCHEMA-QUALIFIED, with the schema looked up from
-- `pg_extension` at migration time — so they are correct wherever the
-- extension lives (`extensions` on Supabase, `public` on plain
-- Postgres, anything else an operator chose). The RPCs call the
-- wrappers, keeping their pinned search_path free of a
-- user-influenced schema. Adding `extensions` to the RPCs' search_path
-- would also work on Supabase but silently break again anywhere
-- pgcrypto lives elsewhere.
--
-- If pgcrypto is ever moved (`alter extension pgcrypto set schema …`),
-- re-run this migration to repoint the wrappers.
--
-- The upsert's body is otherwise unchanged here (0039 changes its
-- foreign-id behaviour). Signatures, grants and return types are the
-- same. Idempotent: `create … if not exists` / `create or replace`.

create schema if not exists private;

do $migration$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_schema is null then
    -- Not installed at all (0005 normally does this). Prefer Supabase's
    -- convention when its `extensions` schema exists.
    if exists (select 1 from pg_catalog.pg_namespace where nspname = 'extensions') then
      create extension if not exists pgcrypto with schema extensions;
    else
      create extension if not exists pgcrypto;
    end if;
    select n.nspname into v_schema
      from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'pgcrypto';
  end if;

  execute format(
    $f$
    create or replace function private.mcp_encrypt(p_data text, p_key text)
    returns bytea
    language sql
    volatile
    set search_path = ''
    as 'select %I.pgp_sym_encrypt(p_data, p_key)'
    $f$,
    v_schema
  );

  execute format(
    $f$
    create or replace function private.mcp_decrypt(p_data bytea, p_key text)
    returns text
    language sql
    volatile
    set search_path = ''
    as 'select %I.pgp_sym_decrypt(p_data, p_key)'
    $f$,
    v_schema
  );
end
$migration$;

-- Only the SECURITY DEFINER RPCs (running as the owner) call these.
revoke all on function private.mcp_encrypt(text, text) from public, anon, authenticated;
revoke all on function private.mcp_decrypt(bytea, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- mcp_get_decrypted_credentials (0005) — body otherwise unchanged
-- ---------------------------------------------------------------------------
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
  select private.mcp_decrypt(credentials_encrypted, p_key)::jsonb
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

-- ---------------------------------------------------------------------------
-- mcp_upsert_server_with_credentials (0031) — body otherwise unchanged
-- ---------------------------------------------------------------------------
create or replace function public.mcp_upsert_server_with_credentials(
  p_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_url text,
  p_credentials jsonb,
  p_key text,
  p_capabilities jsonb default null,
  p_enabled boolean default true,
  p_requires_approval boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.workspaces w
    where w.id = p_workspace_id and w.user_id = auth.uid()
  ) then
    raise exception 'workspace not found' using errcode = '42501';
  end if;

  insert into public.mcp_servers (
    id, user_id, workspace_id, name, url, transport,
    credential_mode, credentials_encrypted,
    capabilities, capabilities_fetched_at, enabled, requires_approval,
    created_at, updated_at
  )
  values (
    p_id, auth.uid(), p_workspace_id, p_name, p_url, 'http',
    'cloud', private.mcp_encrypt(p_credentials::text, p_key),
    p_capabilities,
    case when p_capabilities is null then null else now() end,
    p_enabled, p_requires_approval,
    now(), now()
  )
  on conflict (id) do update set
    workspace_id = excluded.workspace_id,
    name = excluded.name,
    url = excluded.url,
    credential_mode = 'cloud',
    credential_fingerprint = null,
    credentials_encrypted = private.mcp_encrypt(p_credentials::text, p_key),
    capabilities = coalesce(excluded.capabilities, public.mcp_servers.capabilities),
    capabilities_fetched_at = case
      when excluded.capabilities is null then public.mcp_servers.capabilities_fetched_at
      else now()
    end,
    enabled = excluded.enabled,
    requires_approval = excluded.requires_approval,
    updated_at = now()
  where public.mcp_servers.user_id = auth.uid();
end;
$$;

revoke all on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) from public;
grant execute on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) to authenticated;
