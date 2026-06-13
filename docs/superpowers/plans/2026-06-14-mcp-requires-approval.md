# Per-MCP-server `requires_approval` Flag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloud MCP server flagged `requires_approval` gates ALL its tools (`mcp__<serverId>__*`) for HITL approval in agent tasks, as server-side policy a client can't bypass.

**Architecture:** Persist a `requires_approval` column (+ extend the upsert RPC), round-trip it through the client store/sync + dialog toggle, and enforce it in agent-py (the only live task backend) via a pure `gated_tool_names_for` helper unioned into the run's gated-tool set. Other backends don't execute tasks yet (documented note for agent-ts's future executor).

**Tech Stack:** Postgres (Supabase migration + SECURITY DEFINER RPC), TypeScript (Zod, Zustand, sync layer), Python (agent-py, `pytest`).

Design spec: `docs/superpowers/specs/2026-06-14-mcp-requires-approval-design.md`.

---

### Task 1: DB migration + types

**Files:**
- Create: `supabase/migrations/0024_mcp_requires_approval.sql`
- Modify: `lib/shared/supabase/types.ts` (regen or hand-edit)
- Modify: `lib/shared/types.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0024_mcp_requires_approval.sql`. It adds the column, then DROPs + recreates the upsert RPC with a new trailing `p_requires_approval` param (Postgres can't add a param via `create or replace`):

```sql
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
) from public, anon;
grant execute on function public.mcp_upsert_server_with_credentials(
  uuid, uuid, text, text, jsonb, text, jsonb, boolean, boolean
) to authenticated, service_role;
```

(Verify the `revoke`/`grant` roles match the originals at the bottom of `supabase/migrations/0005_mcp.sql` — copy whatever roles it grants to; the above is the typical Supabase set. Read 0005 and mirror it exactly.)

- [ ] **Step 2: Regenerate Supabase types (or hand-edit)**

If a local Supabase is running: `bun run supabase:types` (regenerates `lib/shared/supabase/types.ts`).

If not running, hand-edit `lib/shared/supabase/types.ts`: in the `mcp_servers` table block, add `requires_approval: boolean` to `Row`, and `requires_approval?: boolean` to both `Insert` and `Update`. (Find the `mcp_servers:` key under `public.Tables`.)

- [ ] **Step 3: Add the field to the shared `McpServer` type**

In `lib/shared/types.ts`, add to the `McpServer` interface (after `enabled`):

```ts
  /** Server-side policy: when true, every tool this server exposes is
   *  HITL-gated in agent tasks regardless of the client's
   *  requireApprovalFor. Cloud-mode only. Absent = false. */
  requiresApproval?: boolean
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: clean. (The type addition is optional so nothing breaks yet.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0024_mcp_requires_approval.sql lib/shared/supabase/types.ts lib/shared/types.ts
git commit -m "feat(mcp): add requires_approval column + extend upsert RPC + type"
```

---

### Task 2: agent-py enforcement (the gating core)

**Files:**
- Modify: `services/agent-py/src/agent_py/mcp_tools.py`
- Modify: `services/agent-py/src/agent_py/executor.py`
- Test: `services/agent-py/tests/test_mcp_tools.py` (append; create if absent)

- [ ] **Step 1: Write the failing test for `gated_tool_names_for`**

Append to `services/agent-py/tests/test_mcp_tools.py` (create the file with the import header if it doesn't exist):

```python
from agent_py.mcp_tools import (
    CloudMcpServerRow,
    gated_tool_names_for,
    mcp_tool_name,
)


def _server(id: str, *, requires_approval: bool, tools: list[str]) -> CloudMcpServerRow:
    return CloudMcpServerRow(
        id=id,
        name=id,
        url="https://x",
        capabilities={"tools": [{"name": t} for t in tools]},
        requires_approval=requires_approval,
    )


def test_gated_tool_names_for_flagged_server() -> None:
    servers = [_server("s1", requires_approval=True, tools=["write", "read"])]
    assert gated_tool_names_for(servers) == {
        mcp_tool_name("s1", "write"),
        mcp_tool_name("s1", "read"),
    }


def test_gated_tool_names_for_skips_unflagged() -> None:
    servers = [_server("s1", requires_approval=False, tools=["write"])]
    assert gated_tool_names_for(servers) == set()


def test_gated_tool_names_for_flagged_no_tools() -> None:
    servers = [
        CloudMcpServerRow(id="s1", name="s1", url="https://x",
                          capabilities=None, requires_approval=True),
    ]
    assert gated_tool_names_for(servers) == set()


def test_gated_tool_names_for_mixed() -> None:
    servers = [
        _server("s1", requires_approval=True, tools=["danger"]),
        _server("s2", requires_approval=False, tools=["safe"]),
    ]
    assert gated_tool_names_for(servers) == {mcp_tool_name("s1", "danger")}
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd services/agent-py && uv run pytest tests/test_mcp_tools.py -q`
Expected: FAIL — `cannot import name 'gated_tool_names_for'` (and `CloudMcpServerRow` has no `requires_approval`).

- [ ] **Step 3: Add the column read + row field + pure helper in `mcp_tools.py`**

In `services/agent-py/src/agent_py/mcp_tools.py`:

(a) Add `requires_approval` to `_LOAD_SERVERS_SQL`:
```python
_LOAD_SERVERS_SQL = """
SELECT id::text, name, url, capabilities, requires_approval
FROM public.mcp_servers
WHERE workspace_id = $1::uuid
  AND credential_mode = 'cloud'
  AND enabled = true
  AND deleted_at IS NULL;
"""
```

(b) Add the field to `CloudMcpServerRow` (after `capabilities`):
```python
    capabilities: dict[str, Any] | None = None
    requires_approval: bool = False
```

(c) In `load_workspace_cloud_servers`, set it when mapping rows:
```python
        out.append(
            CloudMcpServerRow(
                id=row["id"],
                name=row["name"],
                url=row["url"],
                capabilities=_decode_jsonb(row["capabilities"]),
                requires_approval=bool(row["requires_approval"]),
            )
        )
```

(d) Add the pure helper (place it after `mcp_tool_name`):
```python
def gated_tool_names_for(servers: list[CloudMcpServerRow]) -> set[str]:
    """Tool names to HITL-gate by server policy: for every server with
    `requires_approval`, the `mcp__<id>__<tool>` name of each tool in its
    cached capabilities. Pure — derived from the server rows, independent
    of whether the tool actually registered (gating a non-registered name
    is a harmless no-op). Servers without `requires_approval` or without
    cached tools contribute nothing."""
    names: set[str] = set()
    for server in servers:
        if not server.requires_approval:
            continue
        for descriptor in _tools_from_capabilities(server.capabilities):
            names.add(mcp_tool_name(server.id, descriptor.name))
    return names
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd services/agent-py && uv run pytest tests/test_mcp_tools.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Thread the gated set through discovery → executor**

(a) In `mcp_tools.py`, give `discover_mcp_tools_for_workspace` an optional `gated_out` it fills from the loaded `servers` (it already has them in scope). Change its signature + add the fill right after `servers = await load_workspace_cloud_servers(...)`:
```python
async def discover_mcp_tools_for_workspace(
    pool: asyncpg.Pool,
    *,
    user_id: str,
    workspace_id: str,
    encryption_key: str | None = None,
    gated_out: set[str] | None = None,
) -> dict[str, ToolDescriptor]:
    # ... existing docstring ...
    servers = await load_workspace_cloud_servers(pool, user_id=user_id, workspace_id=workspace_id)
    if gated_out is not None:
        gated_out.update(gated_tool_names_for(servers))
    if not servers:
        return {}
    # ... rest unchanged ...
```

(b) `extend_registry_with_mcp` passes `gated_out` through. Update its signature + the inner call:
```python
async def extend_registry_with_mcp(
    registry: dict[str, ToolDescriptor],
    *,
    pool: asyncpg.Pool,
    user_id: str,
    workspace_id: str,
    encryption_key: str | None = None,
    gated_out: set[str] | None = None,
) -> dict[str, ToolDescriptor]:
    # ... docstring ...
    mcp_tools = await discover_mcp_tools_for_workspace(
        pool,
        user_id=user_id,
        workspace_id=workspace_id,
        encryption_key=encryption_key,
        gated_out=gated_out,
    )
    registry.update(mcp_tools)
    return registry
```

(c) In `executor.py` `_run_chunk`, collect the gated set and pass it into the step-fn builder. Find the block (around the `extend_registry_with_mcp` call):
```python
        if make_step_fn is None:
            extra_tools: dict[str, ToolDescriptor] = {}
            mcp_gated: set[str] = set()
            if workspace_id:
                await extend_registry_with_mcp(
                    extra_tools,
                    pool=pool,
                    user_id=payload.user_id,
                    workspace_id=workspace_id,
                    gated_out=mcp_gated,
                )
            step_fn = _default_make_step_fn(
                payload,
                checkpoint,
                live_messages,
                tool_context,
                extra_tools=extra_tools or None,
                extra_gated_tool_names=mcp_gated or None,
            )
```
(Match the exact existing argument list/indentation when editing; only `mcp_gated` + the `gated_out=` arg + the `extra_gated_tool_names=` arg are new.)

(d) In `_default_make_step_fn`, accept the new kwarg and union it where the gated set is built. Add the param:
```python
    extra_gated_tool_names: set[str] | None = None,
```
and where it computes the gated set from the checkpoint (the "Phase 3b: read the run's gated-tool allow-list" block, `gated = _gated_tools_from(checkpoint)`), union it:
```python
    gated = _gated_tools_from(checkpoint)
    if extra_gated_tool_names:
        gated = gated | extra_gated_tool_names
```
(Read the exact existing variable name the step config uses for the gated set and union into it; keep the rest as-is.)

- [ ] **Step 6: Full agent-py gate**

Run: `bun run check:agent-py`
Expected: ruff check + ruff format --check + mypy + pytest all pass (incl. the 4 new tests). If ruff format flags the new code, run `cd services/agent-py && uv run ruff format .` and re-stage.

- [ ] **Step 7: Commit**

```bash
git add services/agent-py/src/agent_py/mcp_tools.py services/agent-py/src/agent_py/executor.py services/agent-py/tests/test_mcp_tools.py
git commit -m "feat(agent-py): gate all tools of a requires_approval MCP server"
```

---

### Task 3: Client store + sync round-trip

**Files:**
- Modify: `lib/client/hooks/store/slices/mcp.ts`
- Modify: `lib/client/sync/reconcile.ts`
- Modify: `lib/client/sync/handlers.ts`

- [ ] **Step 1: Store — carry `requiresApproval` through `addMcpServer`**

In `lib/client/hooks/store/slices/mcp.ts`: (a) add `requiresApproval?: boolean` to the `addMcpServer` input type in the `McpSlice` interface (find `addMcpServer: (input: { ... }) => McpServer`); (b) thread it in the mutator:
```ts
  addMcpServer: ({ workspaceId, name, url, credentialMode, credentialFingerprint, enabled = true, requiresApproval }) => {
    const now = new Date()
    const newServer: McpServer = {
      id: uuid(),
      workspaceId,
      name,
      url,
      transport: "http",
      credentialMode,
      credentialFingerprint,
      enabled,
      requiresApproval,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({ mcpServers: [...state.mcpServers, newServer] }))
    return newServer
  },
```
`updateMcpServer(serverId, patch)` already spreads `patch`, so a `{ requiresApproval }` patch works with no change — just confirm the patch type (`Partial<...>`) permits it (it spreads `McpServer` fields).

- [ ] **Step 2: Reconcile — pull the column into the store**

In `lib/client/sync/reconcile.ts`: (a) add `requires_approval` to the `mcp_servers` `.select(...)` string (the one listing `id, user_id, workspace_id, name, url, transport, credential_mode, credential_fingerprint, capabilities, capabilities_fetched_at, enabled, created_at, updated_at, deleted_at`); (b) in the row→`McpServer` map, set it (after `enabled: s.enabled,`):
```ts
        enabled: s.enabled,
        requiresApproval: s.requires_approval ?? undefined,
```

- [ ] **Step 3: Sync push — include it in the upsert row + change detector**

In `lib/client/sync/handlers.ts`: (a) in `diffMcpServers`, add to the upsert `row` (after `enabled: s.enabled,`):
```ts
          enabled: s.enabled,
          requires_approval: s.requiresApproval ?? false,
```
(b) in `mcpServerEquals`, add a comparison (so a toggle triggers a push) — add this line alongside the other `&&` comparisons (e.g. after `a.enabled === b.enabled &&`):
```ts
    (a.requiresApproval ?? false) === (b.requiresApproval ?? false) &&
```

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean. (The reconcile `s.requires_approval` access is typed once Task 1's `types.ts` regen/edit landed; the upsert `row` accepts the new column from the regenerated Insert type.)

- [ ] **Step 5: Commit**

```bash
git add lib/client/hooks/store/slices/mcp.ts lib/client/sync/reconcile.ts lib/client/sync/handlers.ts
git commit -m "feat(mcp): round-trip requiresApproval through store + sync"
```

---

### Task 4: Cloud RPC write path + dialog toggle

**Files:**
- Modify: `lib/client/api-client.ts`
- Modify: `app/api/mcp/server/route.ts`
- Modify: `lib/server/mcp/credentials.ts`
- Modify: `components/panels/workspace-mcp-section.tsx`

- [ ] **Step 1: api-client — add the field to the upsert body type**

In `lib/client/api-client.ts`, `mcpUpsertCloudServer`'s `body` type — add after `enabled?: boolean`:
```ts
    requires_approval?: boolean
```
(The body is JSON-stringified as-is, so no other change in this function.)

- [ ] **Step 2: Route — accept + pass through**

In `app/api/mcp/server/route.ts`: (a) add to `BodySchema` (after `enabled: z.boolean().optional(),`):
```ts
  requires_approval: z.boolean().optional(),
```
(b) in the `upsertServerWithCredential(supabase, { ... })` call, add (after `enabled: parsed.data.enabled,`):
```ts
    requiresApproval: parsed.data.requires_approval,
```

- [ ] **Step 3: credentials.ts — pass to the RPC**

In `lib/server/mcp/credentials.ts` `upsertServerWithCredential`: (a) add `requiresApproval?: boolean` to the `params` type (after `enabled?: boolean`); (b) pass it to the RPC call (after `p_enabled: params.enabled ?? true,`):
```ts
    p_requires_approval: params.requiresApproval ?? false,
```

- [ ] **Step 4: Dialog — the Switch**

In `components/panels/workspace-mcp-section.tsx` (the add/edit MCP server dialog): (a) add state near the other `useState`s:
```ts
  const [requiresApproval, setRequiresApproval] = useState(false)
```
(b) add a toggle section after the credential-storage block (mirror the existing label/control styling; `Switch` is already imported):
```tsx
        <div>
          <label className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] font-medium">
            Approval
          </label>
          <div className="mt-1 flex items-center gap-2">
            <Switch
              checked={requiresApproval}
              onCheckedChange={setRequiresApproval}
              aria-label="Require approval for all tools from this server"
            />
            <span className="text-xs">Require approval for all tools from this server</span>
          </div>
        </div>
```
(c) include it on submit: pass `requiresApproval` to the `addMcpServer({ ... })` call, and add `requires_approval: requiresApproval` to the `apiClient.mcp.upsertCloudServer({ ... })` body. (If the dialog also supports editing an existing server, initialise `requiresApproval` state from the server's current `requiresApproval` — read the dialog to see whether it's add-only or edit too, and mirror how it initialises the other fields like `name`/`url`.)

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors; pre-existing warnings unrelated).

- [ ] **Step 6: Commit**

```bash
git add lib/client/api-client.ts app/api/mcp/server/route.ts lib/server/mcp/credentials.ts components/panels/workspace-mcp-section.tsx
git commit -m "feat(mcp): requires-approval toggle in the server dialog + cloud write path"
```

---

### Task 5: Docs + full gate + PR

**Files:**
- Modify: `docs/PLAN-small-followups.md`
- Modify: `docs/PLAN-agent-api.md` (or the agent-ts followups doc) — the agent-ts note

- [ ] **Step 1: Mark the followup done + agent-ts note**

In `docs/PLAN-small-followups.md` §7, mark it shipped (strike the heading like the other done items, add a one-line "shipped" note: column + RPC + store/sync round-trip + dialog toggle + agent-py gating). Add a sentence: "Enforced in agent-py (the only live task backend); when agent-ts's executor lands it must apply the same union — gate `mcp__<id>__*` for servers with `requires_approval` — in its tool-registry build." Mirror that note wherever agent-ts's task TODO lives (e.g. a line in `docs/PLAN-agent-api.md`'s agent-ts section if present).

- [ ] **Step 2: Commit docs**

```bash
git add docs/PLAN-small-followups.md docs/PLAN-agent-api.md
git commit -m "docs: mark per-server MCP approval shipped; agent-ts follow-up note"
```

- [ ] **Step 3: Full gate**

Run: `bun run typecheck && bun run lint` → clean.
Run: `bun run check:agent-py` → all pass.
Run: `bun run docs:user-manual:check` → up to date (no env vars/panels added; if it flags drift, `bun run docs:user-manual:build` and commit).

- [ ] **Step 4: Push + open the PR**

```bash
git push -u origin feat/mcp-requires-approval
gh pr create --base dev --title "feat: per-MCP-server requires_approval gating" --body "Implements docs/superpowers/specs/2026-06-14-mcp-requires-approval-design.md."
```

(Per the repo's PR rules, auto-subscribe if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **Where the real test coverage is:** Task 2's pure `gated_tool_names_for` tests. The TS tasks are persistence plumbing verified by typecheck + lint (no MCP route/sync test harness exists; adding one is out of scope).
- **Default-false everywhere:** the column, the type (`requiresApproval?`), the RPC param, and the sync row all default to `false`/absent → existing servers and any omitted field are "not gated" (no behavior change for current users).
- **Migration sharp edge:** the upsert RPC must be DROP+CREATE (not create-or-replace) because a new parameter changes the signature. Re-grant after recreate. Mirror the exact `revoke`/`grant` roles from `0005_mcp.sql`.
- **agent-py wiring:** the gated set is filled from the loaded `servers` inside `discover_mcp_tools_for_workspace` (single load, no extra query), surfaced via `gated_out`, and unioned in `_default_make_step_fn`. Only the `_run_chunk` (start/continue) path registers MCP tools — the respond path doesn't, so there's nothing to gate there.
- **Scope:** cloud-mode + whole-server only; chat-mode tool gating (`load-servers.ts`/`EffectiveMcpServer`) is deliberately untouched (Item 7 is task gating).
