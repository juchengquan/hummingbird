# Plan: MCP integration (tools + resources)

Status: **shipped** — Stages 1, 2, and 3 are live on `claude/dev-followups`. See `docs/PLAN-mcp-stage-3.md` for the Stage 3 sub-stage breakdown.

Add support for [Model Context Protocol](https://modelcontextprotocol.io)
servers as a workspace-level configuration. One MCP server unlocks a
family of capabilities (GitHub, Notion, Linear, Postgres, filesystem,
…) without writing a connector per service. Two surfaces:

- **Tools** — model can call MCP-exposed functions during a chat turn
  (e.g. `github.search_repos`). Slots into the existing tool map in
  `app/api/chat/route.ts:240`.
- **Resources** — MCP-exposed read-only data items (e.g. a Notion
  page, a file in a repo) become attachable in the resources panel.
  Mirrors the file model: workspace-library lane + conversation-private
  lane.

## Decisions baked in upfront

- **HTTP / Streamable HTTP transport only.** No stdio in v1 — the app
  is cloud-deployed on serverless, no subprocess management. Covers
  remote MCP servers (Cloudflare Workers MCPs, hosted services, self-
  hosted-by-URL). Stdio could land later as an opt-in self-hosted mode.
- **Per-workspace config.** Same scoping as `Workspace.systemPrompt`,
  `defaultModel`, `skillPrefs`. A "Research" workspace can wire arxiv
  + GitHub; a "Personal" workspace can wire Notion. Matches how tools
  naturally cluster by intent.
- **Two credential storage modes:**
  - **Cloud (server-side)** — credentials live encrypted in a new
    `mcp_servers.credentials` JSONB column, RLS-protected. A new
    `/api/mcp/*` proxy is the only thing that decrypts + forwards.
    Synced across devices for the user.
  - **Local (client-side)** — credentials live in `localStorage`
    (`mcp_creds_v1` keyed by serverId), excluded from sync `partialize`.
    The proxy still forwards the request but reads the cred from the
    request header instead of Supabase. Good for sensitive personal
    tokens or signed-out users.
  - Per-server toggle in the MCP settings UI. Defaults to **cloud**
    when signed in (matches the existing local-files-vs-cloud default),
    **local** when signed out.

Both modes go through the proxy because direct browser → MCP server
fetches will fail CORS for most MCP servers. The proxy is the only
component that talks to MCP servers from a server-allowed origin.

## Data model

### `lib/shared/types.ts`

```ts
export type McpTransport = 'http'  // 'stdio' deferred

export type McpCredentialMode = 'cloud' | 'local'

export interface McpServer {
  id: string                       // uuid
  workspaceId: string
  name: string                     // user-facing label
  url: string                      // MCP server endpoint
  transport: McpTransport
  /** Where the cred lives. 'cloud' = encrypted Supabase row; 'local'
   *  = localStorage on this device only. */
  credentialMode: McpCredentialMode
  /**
   * For 'cloud' mode: nothing here — read from the cloud row.
   * For 'local' mode: a stable hash of the local cred (so two
   * devices don't both think they have the *same* cred when they
   * don't). Not the cred itself.
   */
  credentialFingerprint?: string
  /** Server-reported capabilities, cached from the last discovery. */
  capabilities?: {
    tools?: { name: string; description?: string; inputSchema?: unknown }[]
    resources?: { uri: string; name?: string; description?: string; mimeType?: string }[]
    prompts?: { name: string; description?: string }[]
  }
  capabilitiesFetchedAt?: Date
  /** Soft-disable without removing the row. */
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date                 // tombstone (same pattern as files)
}

export interface McpResource {
  id: string                       // uuid (local row id)
  workspaceId: string
  serverId: string                 // FK -> McpServer.id
  uri: string                      // MCP resource URI (stable on server)
  name: string                     // cached display name
  description?: string
  mimeType?: string
  addedAt: Date
  deletedAt?: Date                 // tombstone
}

/** Workspace-library lane for MCP resources (parallel to `resources`). */
export interface McpResourceBinding {
  id: string
  workspaceId: string
  resourceId: string               // FK -> McpResource.id
  addedAt: Date
}

/** Conversation-private lane (parallel to `conversationFiles`). */
export interface ConversationMcpResource {
  id: string
  conversationId: string
  resourceId: string
  addedAt: Date
}
```

Three new join tables (servers / resources / bindings) plus the
conversation-private join. Mirrors the files / resources /
conversationFiles trio we just shipped — same mental model, same
tombstone semantics, same cascade rules.

### Why not polymorphic with files?

Tempting (one `attachments` table; type discriminator) but the lifecycle
differs in three ways that would force conditional logic in every
join:

1. **Lifecycle source of truth.** Files live in our blob registry;
   MCP resources live on the remote server and we cache a pointer.
   Re-fetch semantics differ.
2. **Content shape.** Files have `extractedText` + `imageDataUrl`;
   MCP resources have a `uri` we fetch on-demand at chat time (or
   pre-cache via `resources/read`).
3. **Visibility.** A file is gone forever if `removeFile` runs; an
   MCP resource removal just detaches our binding — the server still
   has it.

Keeping the tables parallel-but-separate is more SQL but cleaner code.

## Server-side proxy: `app/api/mcp/[serverId]/[action]/route.ts`

One route, three actions:

- `POST /api/mcp/[serverId]/discover` — fetch the server's
  `tools/list`, `resources/list`, `prompts/list`, persist into
  `mcp_servers.capabilities`. Triggered by the UI on server add /
  refresh, and on a TTL (24h) when the chat route loads tools.
- `POST /api/mcp/[serverId]/call` — invoke a tool. Body
  `{ tool: string, input: unknown }`. Returns the MCP response
  (cleaned of any sensitive headers).
- `POST /api/mcp/[serverId]/read` — read a resource. Body
  `{ uri: string }`. Returns `{ contents: [{ uri, mimeType, text }] }`
  in MCP's standard shape.

Auth resolution per request:

```
1. Look up McpServer row by [serverId]. Verify userId matches (RLS).
2. If credentialMode === 'cloud':
     creds = decrypt(server.credentials_encrypted)
3. If credentialMode === 'local':
     creds = req.headers['x-mcp-credentials']  // base64 JSON
     (server-side never logs or persists this header)
4. Forward to MCP server with creds in the configured location
   (Authorization: Bearer ..., or per-server custom).
5. Stream/return the response; strip Set-Cookie and other transit
   headers.
```

Critical: the proxy is the *only* thing that holds creds at runtime.
The client builds the request URL with serverId but never sees the
cred for cloud-mode servers.

## MCP client library

Use `@modelcontextprotocol/sdk` (the official TypeScript SDK).
HTTP/Streamable HTTP transport. Server-only (`lib/server/mcp/client.ts`
behind the `server-only` fence).

Wrap with a thin facade:

```ts
// lib/server/mcp/client.ts
export async function discover(server: McpServer, creds: Creds):
  Promise<McpServer['capabilities']>

export async function callTool(server: McpServer, creds: Creds,
  tool: string, input: unknown): Promise<unknown>

export async function readResource(server: McpServer, creds: Creds,
  uri: string): Promise<{ text?: string; mimeType?: string }>
```

## Tool registration in the chat route

`app/api/chat/route.ts` currently builds tools from the enabled-skills
list (`enabledSkillIds.includes('webSearch')`). After the change, also
load enabled MCP server tools:

```ts
// For each enabled MCP server in the active workspace:
//   read cached capabilities.tools (refresh if TTL expired)
//   for each tool, synthesize an AI SDK tool whose `execute` calls
//   our /api/mcp/[serverId]/call proxy server-side (in-process, not
//   over HTTP — direct function call to the same module).
const mcpServers = await loadEnabledMcpServers(userId, body.workspaceId)
for (const server of mcpServers) {
  for (const t of server.capabilities?.tools ?? []) {
    tools[`mcp__${server.id}__${t.name}`] = makeProxyTool(server, t)
  }
}
```

Tool name prefix `mcp__<serverId>__<toolName>` keeps namespaces
clean and makes the message log show provenance.

`stopWhen: stepCountIs(5)` already in place handles multi-step tool
loops; bump to `stepCountIs(8)` to give MCP server chains more
headroom.

System-prompt note: tell the model what MCP tools / resources are
available, the same way `webSearch` is announced today.

## Resources in the payload

`components/panels/chat.tsx` builds `attachedFiles` from the union
of workspace `selectedFileIds` + conversation `conversationFiles`.
After this, also merge:

- workspace `mcpResourceBindings` ticked into a new
  `selectedMcpResourceIds` field on `Conversation` (parallel to
  `selectedFileIds`)
- conversation `ConversationMcpResource[]` for the active conversation

Resolve each id → `McpResource`, fetch its content lazily via
`readResource(server, creds, uri)` server-side, and inject into the
chat payload as a synthetic "file" with `text` content set. Keeps the
chat route's downstream prompt-builder unchanged.

Cap content by character budget like files (`extractionTruncated`
equivalent applies).

## UI

### Workspace settings — new "MCP servers" section

New panel inside the existing workspace settings sheet
(`components/panels/workspaces.tsx` area). For each row:

- Name, URL, transport badge, enabled toggle.
- Credential mode pill (Cloud / Local) — click to switch.
- Cred field (write-only for cloud; show fingerprint hash for local).
- Test connection button (calls `discover` + reports tool/resource counts).
- Capabilities summary (tools: 5, resources: 12).
- Remove button (tombstones the server).

Add server flow: name + URL + cred mode → POST `/discover` → on
success, save the row and surface the discovered counts.

### Resources sidebar — new "MCP" tab

Adds to the existing tab strip (`'files' | 'notes' | 'artifacts' | 'skills' | 'pins'`)
a new `'mcp'` tab. Two sections inside, matching the files panel:

- **This conversation** — `ConversationMcpResource` rows for the
  active chat. Pick from a dropdown of (`Server → Resource`); click
  the `×` to detach.
- **Workspace MCP resources** — `McpResourceBinding` rows for the
  active workspace. Tickable to attach to the conversation (mirroring
  workspace files' `selectedMcpResourceIds`).

The chat input `+` button gets a small split: file (default) /
MCP resource (dropdown). Or a separate `@` shortcut — TBD in
implementation.

### Skills tab — list MCP tools

Surface enabled MCP tools alongside built-in skills (webSearch) in
the Skills tab, so users can see what the model can actually call.
Toggle = enable/disable per server (not per tool — simpler v1).

## Credentials: encrypt-at-rest

For cloud mode, use Postgres-level symmetric encryption with
`pgcrypto`'s `pgp_sym_encrypt` keyed by a server-side env var
(`MCP_ENCRYPTION_KEY`). Column shape:

```sql
credentials_encrypted bytea  -- pgp_sym_encrypt(jsonb_text, key)
```

The proxy decrypts with `pgp_sym_decrypt` via a SECURITY DEFINER
SQL function so the client never sees the cred. Standard PCI-ish
pattern. Key rotation = re-encrypt all rows with the new key.

Alternative considered: Supabase Vault. Skipped because it's project-
wide and we want per-user RLS naturally.

For local mode, creds live under `localStorage['mcp_creds_v1']` as
`{ [serverId]: { ...cred } }`. Excluded from `partialize`. On a
chat-route call, the client sends `X-MCP-Credentials: base64(json)`
in the request header. The proxy reads it, forwards to MCP, never
persists it.

## Cascade rules (parallel to files)

- **Remove MCP server** (`removeMcpServer`): tombstone the server,
  drop matching `McpResourceBinding` + `ConversationMcpResource` +
  workspace `selectedMcpResourceIds` references atomically. Cached
  resource rows tombstone too (cascade GC).
- **Remove MCP resource binding**: drop the workspace tick; if no
  conversation-private join still references it, GC + tombstone the
  underlying `McpResource`.
- **Remove conversation-private MCP resource**: same as
  `removeConversationFile`'s pattern.
- **Delete conversation**: drop `ConversationMcpResource` rows;
  cascade GC orphaned `McpResource` rows.
- **Delete workspace**: cascade through servers, resources, bindings,
  conversation joins. Tombstones for everything (history-resolvable
  in message references).

Defensive prune in `onRehydrateStorage` extends to MCP joins.

## Supabase migration `supabase/migrations/0005_mcp.sql`

```sql
create table mcp_servers (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  url text not null,
  transport text not null check (transport in ('http')),
  credential_mode text not null check (credential_mode in ('cloud', 'local')),
  credentials_encrypted bytea,            -- null when credential_mode = 'local'
  credential_fingerprint text,            -- non-null when credential_mode = 'local'
  capabilities jsonb,
  capabilities_fetched_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table mcp_resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  server_id uuid not null references mcp_servers(id) on delete cascade,
  uri text not null,
  name text not null,
  description text,
  mime_type text,
  added_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table mcp_resource_bindings (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  resource_id uuid not null references mcp_resources(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table conversation_mcp_resources (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  resource_id uuid not null references mcp_resources(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- RLS — same per-row "own your rows" pattern as every other table.
alter table mcp_servers enable row level security;
create policy "own mcp_servers" on mcp_servers
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table mcp_resources enable row level security;
create policy "own mcp_resources" on mcp_resources
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table mcp_resource_bindings enable row level security;
create policy "own mcp_resource_bindings" on mcp_resource_bindings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table conversation_mcp_resources enable row level security;
create policy "own conversation_mcp_resources" on conversation_mcp_resources
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index mcp_servers_workspace_live
  on mcp_servers (workspace_id) where deleted_at is null;
create index mcp_resources_server
  on mcp_resources (server_id) where deleted_at is null;
create index conversation_mcp_resources_conversation
  on conversation_mcp_resources (conversation_id);
```

Also need: `pgcrypto` extension enabled, `MCP_ENCRYPTION_KEY` env var,
SECURITY DEFINER decrypt helper function. Documented in
`docs/SUPABASE_SETUP.md` follow-up.

## Implementation phases

Same staging discipline as the files lane:

| Stage | Scope | Lines |
|---|---|---|
| **1** | Types, store slices (4 new), v17 migration, cascade + GC, dual-mode cred storage on client side (server-side proxy stub only), workspace settings UI for adding servers + discovery flow | ~500 |
| **2** | Tool registration in the chat route, server-side proxy with cloud/local mode resolution, pgcrypto wiring, MCP SDK wrapper | ~400 |
| **3** | Resource lanes (workspace + conversation-private), payload merge in chat route, new MCP tab in resources sidebar, sync handlers for all 4 new tables, Supabase migration 0005 | ~500 |

Total ~1400 lines. **Substantial** — recommend a real branch off
`dev` and PR review at each stage. Suggest doing Stage 1 first,
verifying the discovery flow against a real public MCP server
(e.g. Cloudflare's [MCP demo](https://github.com/cloudflare/agents-starter)),
then proceeding.

## Verification

A real-world sanity check at each stage. Pick a target MCP server
(GitHub MCP, Notion MCP, or filesystem-over-HTTP) and walk:

1. Add server → discover succeeds, capabilities cached.
2. Cloud mode: cred stored encrypted; client never sees it.
3. Local mode: cred stored in localStorage, sent via header on call.
4. Tool call from chat: model invokes `mcp__{id}__{tool}`, proxy
   forwards, result streams back.
5. Attach an MCP resource to a conversation; next chat turn
   includes the resource text in the system prompt.
6. Remove server → all bindings cascade-tombstone; message references
   resolve to "🗑 removed" labels.
7. Multi-device sync (signed in, cloud mode): adding a server on
   device A makes it appear on device B; tool calls work from both.
8. Multi-device sync (signed in, local mode): server config syncs;
   each device prompts for its own cred.

## Out of scope (follow-ups)

- **stdio transport** — would need a sidecar container or self-
  hosted-only mode. Defer until there's user demand and a clean
  deployment story.
- **OAuth 2.1 PKCE per the MCP auth spec** — bearer-token v1 ships
  first; OAuth lands as a credentialMode='oauth' variant once we
  have a server that requires it.
- **Prompts** — MCP's third primitive (alongside tools + resources).
  Lower priority for the chat-centric UX; could land as a "saved
  prompts" entry in the skills tab later.
- **Tool-level enable/disable** — v1 toggles enable per server.
  Per-tool toggling is a follow-up if the per-server granularity
  proves too coarse.
- **Resource pre-caching** — v1 fetches resource content on-demand
  at chat time. A background prefetch (every few minutes) would
  speed up the first turn after switching conversations.
- **Polymorphic merge with files** — keep separate for now. If
  patterns converge enough after both ship, a future refactor could
  unify into a single `attachments` lane.
