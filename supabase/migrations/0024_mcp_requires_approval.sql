-- Per-server approval policy: when true, every tool the server exposes
-- (mcp__<serverId>__*) is HITL-gated in agent tasks regardless of the
-- client's requireApprovalFor. See docs/superpowers/specs/2026-06-14-mcp-requires-approval-design.md.

alter table public.mcp_servers
  add column requires_approval boolean not null default false;

-- The upsert RPC gains a p_requires_approval param. create-or-replace
-- cannot add a parameter (it would create a second overload), so drop
-- the old signature and recreate.
drop function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean
);

create function public.mcp_upsert_server_with_credentials(
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
  insert into public.mcp_servers (
    id, user_id, workspace_id, name, url, transport,
    credential_mode, credentials_encrypted,
    capabilities, capabilities_fetched_at, enabled, requires_approval,
    created_at, updated_at
  )
  values (
    p_id, auth.uid(), p_workspace_id, p_name, p_url, 'http',
    'cloud', pgp_sym_encrypt(p_credentials::text, p_key),
    p_capabilities,
    case when p_capabilities is null then null else now() end,
    p_enabled, p_requires_approval,
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
