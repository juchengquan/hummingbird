-- verify-supabase-types: skip (function body only; public signature unchanged)
-- 0039_mcp_upsert_foreign_id.sql — stop reporting success for a no-op.
--
-- `mcp_upsert_server_with_credentials` upserts with
--   on conflict (id) do update … where mcp_servers.user_id = auth.uid()
-- so when `p_id` already belongs to ANOTHER user the WHERE filters the
-- update out, nothing is written, and the function still returns
-- normally. Every caller (/api/mcp/server, agent-py and agent-ts
-- `/v1/mcp/server`) then answered `{ ok: true }` for a credential that
-- was never stored.
--
-- Now the function checks the row count and raises:
--   * id owned by another user → SQLSTATE 23505, message prefixed
--     `mcp_server_id_conflict` (the callers map it to 409);
--   * workspace not the caller's → SQLSTATE P0002 `workspace not found`
--     (was 42501; the callers map it to 404).
-- The filtered-out upsert wrote nothing, so raising discards no work.
--
-- Body otherwise identical to 0038 (pgcrypto via the private wrappers).
-- Same signature + grants. Idempotent: `create or replace`.

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
    raise exception 'workspace not found' using errcode = 'P0002';
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

  -- Zero rows: the id exists and the conflict update was filtered out by
  -- the owner check — the row is someone else's.
  if not found then
    raise exception 'mcp_server_id_conflict: server id belongs to another user'
      using errcode = '23505';
  end if;
end;
$$;

revoke all on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) from public;
grant execute on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) to authenticated;
