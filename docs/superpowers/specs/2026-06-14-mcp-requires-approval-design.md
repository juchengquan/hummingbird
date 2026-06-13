# Per-MCP-server "requires approval" flag — Design

Status: **approved design — ready for implementation plan.**
Origin: `docs/PLAN-small-followups.md` §7 ("Per-tool server-side approval flags").

## Why

Today an agent task's gated-tool set is `body.requireApprovalFor` — an explicit, client-supplied list of prefixed tool names. There's no way to say "this MCP server is sensitive: gate everything it exposes" as **server-side policy** that a client can't opt out of. This adds a per-server `requires_approval` flag: when set, every tool from that server (`mcp__<serverId>__*`) is HITL-gated in a task, regardless of what the client sends.

## Scope

- **Whole-server only.** Per-tool granularity within a server, and "always-gate destructive verbs" defaults, are out of scope (Item 7).
- **Cloud-mode servers only.** `/api/tasks` rejects local-mode MCP in task mode, and the task backend only loads `credential_mode = 'cloud'` servers — so the flag is inherently cloud-only; no decision or extra handling for local-mode.
- **Enforced in agent-py only (today).** agent-py is the only backend that executes tasks + builds MCP tools + gates. The in-Next worker is retired (rejects MCP-in-tasks); agent-ts is a dry-run stub with no executor/MCP. Enforcing in agent-py IS complete server-side enforcement for tasks today. A documented note records that agent-ts's future executor must apply the same union (no dead code written now).

## Enforcement (agent-py)

The provider already suspends a tool call when `tool_name in config.gated_tool_names` (`anthropic_provider.py`). Today that set is `_gated_tools_from(checkpoint)` = `requireApprovalFor ∪ ALWAYS_GATED_TOOL_NAMES`. We add the flagged servers' tools to it.

- `services/agent-py/.../mcp_tools.py`:
  - `_LOAD_SERVERS_SQL`: add `requires_approval` to the SELECT.
  - `CloudMcpServerRow`: add `requires_approval: bool = False`; `load_workspace_cloud_servers` maps `row["requires_approval"]`.
  - New **pure** helper `gated_tool_names_for(servers: list[CloudMcpServerRow]) -> set[str]`: for each server with `requires_approval`, expand its `capabilities.tools` into `mcp_tool_name(server.id, tool)` names and return the union. (Servers without cached `capabilities.tools` contribute nothing — there are no tool names to gate; the model can't call a tool that wasn't registered anyway.)
- Wiring: `extend_registry_with_mcp` already loads the servers + builds the `mcp__…` tools. It will surface the flagged-server gated names to the caller (via a mutable `gated_out: set[str]` param it adds to — mirroring how it already mutates the passed `extra_tools` dict — OR by returning them alongside the registry; the plan picks the exact shape after reading the function). The executor unions those names into the set it builds from `_gated_tools_from(checkpoint)` before passing `gated_tool_names` to the step config.

The **pure** `gated_tool_names_for` is where the correctness lives and where the tests go.

## Persistence

### Migration `0024_mcp_requires_approval.sql`
1. `ALTER TABLE public.mcp_servers ADD COLUMN requires_approval boolean NOT NULL DEFAULT false;`
2. Extend the cloud-upsert RPC. Postgres can't add a parameter via `create or replace` (it would create a second overload), so **drop the old signature and recreate**:
   ```sql
   DROP FUNCTION public.mcp_upsert_server_with_credentials(
     uuid, uuid, text, text, jsonb, text, jsonb, boolean
   );
   CREATE FUNCTION public.mcp_upsert_server_with_credentials(
     p_id uuid, p_workspace_id uuid, p_name text, p_url text,
     p_credentials jsonb, p_key text,
     p_capabilities jsonb DEFAULT NULL,
     p_enabled boolean DEFAULT true,
     p_requires_approval boolean DEFAULT false
   ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
     SET search_path = pg_catalog, public AS $$ ... $$;
   ```
   The body is the existing insert + `ON CONFLICT` update, plus `requires_approval` in the insert column list/values and in the `do update set`. Re-`REVOKE ALL` + `GRANT EXECUTE` on the new signature (mirror the existing grants at the bottom of `0005_mcp.sql`).

### Types
- `bun run supabase:types` → regenerate `lib/shared/supabase/types.ts` (adds `requires_approval` to the Row/Insert/Update shapes).
- `lib/shared/types.ts`: add `requiresApproval?: boolean` to the `McpServer` interface.

### Write paths (client → cloud)
There are **two** cloud writes for an MCP server; both must carry the flag:
1. **Dialog credential upsert (RPC):** `components/.../workspace-mcp-section.tsx` → `apiClient.mcp.upsertCloudServer` → `app/api/mcp/server/route.ts` → `lib/server/mcp/credentials.ts` `upsertServerWithCredential` → the `mcp_upsert_server_with_credentials` RPC. Add the field to: the api-client body type, the route `BodySchema` + pass-through, and the credentials RPC call (`p_requires_approval`, default `false`).
2. **Metadata sync push (direct upsert):** `lib/client/sync/handlers.ts` `diffMcpServers` builds an upsert `row` of metadata columns (creds excluded). Add `requires_approval: s.requiresApproval ?? false` to that `row`, and add `requiresApproval` to `mcpServerEquals` so a flag change is detected and pushed.

### Read path (cloud → store/UI)
- `lib/client/sync/reconcile.ts`: the `mcp_servers` `.select(...)` (the pull) gains `requires_approval`; the row→`McpServer` map sets `requiresApproval: s.requires_approval`. This is the store-hydration path the dialog reads, so the toggle shows current state.

(Out of scope: `lib/server/mcp/load-servers.ts` / chat-mode tool gating — that builds `EffectiveMcpServer` for the chat route, a separate concern from task gating. Item 7 is about tasks.)

### Store
- `lib/client/hooks/store/slices/mcp.ts`: `addMcpServer` input + new-server object carry `requiresApproval`; `updateMcpServer` patch already permissive — confirm it threads `requiresApproval`.

## UI

`components/panels/workspace-mcp-section.tsx` (the add/edit MCP server dialog): add a `Switch` (already imported) labelled "Require approval for all tools from this server", backed by local state initialised from the server's current `requiresApproval`, included on submit (passed to `addMcpServer`/the upsert body). Place it after the credential-storage section.

## Error handling / safety

- Default `false` everywhere — existing servers and any omitted field are "not gated" (no behavior change for current users).
- A flagged server with no cached `capabilities.tools` contributes no gated names (nothing to gate; harmless).
- agent-py server-load already degrades to `[]` on RLS reject / DB error (best-effort) — the gating helper over `[]` is the empty set, so a load failure can't crash the run (it just means no MCP gating that run, same as no MCP).

## Testing

- **agent-py (the real logic):** unit-test the pure `gated_tool_names_for`:
  - a server with `requires_approval=True` + `capabilities.tools=[{name:"write"},{name:"read"}]` → `{mcp__<id>__write, mcp__<id>__read}`;
  - a server with `requires_approval=False` → contributes nothing;
  - a flagged server with no `capabilities`/empty tools → empty;
  - mixed list → only the flagged server's tools.
  Plus a check that `load_workspace_cloud_servers` maps the `requires_approval` column (mock the row, like existing agent-py MCP tests). No model/live MCP needed.
- **TS:** `bun run typecheck` + `bun run lint` cover the plumbing (route schema, store, api-client, load-servers mapping). The migration/RPC has no automated harness — verified by the agent-py gating test + the migration applying cleanly.

## Touch-point summary

| File | Change |
|---|---|
| `supabase/migrations/0024_mcp_requires_approval.sql` | **new** — column + drop/recreate the upsert RPC |
| `lib/shared/supabase/types.ts` | regenerated |
| `lib/shared/types.ts` | `McpServer.requiresApproval?` |
| `lib/client/api-client.ts` | `mcpUpsertCloudServer` body field |
| `app/api/mcp/server/route.ts` | `BodySchema` field + pass-through |
| `lib/server/mcp/credentials.ts` | RPC call passes `p_requires_approval` |
| `lib/client/sync/reconcile.ts` | pull select + row→`McpServer` map |
| `lib/client/sync/handlers.ts` | `diffMcpServers` upsert row + `mcpServerEquals` |
| `lib/client/hooks/store/slices/mcp.ts` | mutators carry `requiresApproval` |
| `components/panels/workspace-mcp-section.tsx` | dialog `Switch` |
| `services/agent-py/.../mcp_tools.py` | SQL + row field + pure `gated_tool_names_for` |
| `services/agent-py/.../executor.py` | union flagged-server names into `gated_tool_names` |
| `services/agent-py/.../tests/` | `gated_tool_names_for` + row-map tests |
| `docs/PLAN-small-followups.md` / agent-ts note | mark §7 done; note agent-ts future executor must apply the same union |

## Scope

**M** — ~12 files. The enforcement logic (a pure helper + a one-line union) is small; most of the surface is persistence plumbing, and the one sharp edge is the **drop/recreate** of the SECURITY-DEFINER upsert RPC in the migration.
