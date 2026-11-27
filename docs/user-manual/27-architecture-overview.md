<!-- related: CLAUDE.md, docs/MASTER_PLAN.md -->

# Architecture overview

## What it is
The 30,000-foot view of how Hummingbird is put together. Useful
when you're self-hosting and need to know which piece handles
which concern.

## The layers

```
Browser (Next.js client)  ->  services/agent-py (Python)  ->  external services
        ^                              |
Next.js server (pages, CSP)      Supabase (Postgres, Storage, Auth)
```

- **`app/`** - Next.js App Router pages. The Next.js server renders
  pages and sets each request's Content-Security-Policy nonce
  (`proxy.ts`), and serves the static sandbox frame live artifacts and
  MCP apps load (`/sandbox/frame`). It holds no secrets and has no API
  routes: it reads only the `NEXT_PUBLIC_*` variables and `CSP_MODE`.
- **`services/agent-py/`** - the agent service (FastAPI + asyncpg), the
  one backend. Every API surface the browser uses is here: chat (on the
  runs API, `/v1/runs`), background tasks and their worker, the
  scheduler that fires scheduled tasks, the reconciler that fails tasks
  no worker picked up, files and extraction, summaries, the editor AI,
  share links, the MCP proxy, memory, embeddings and CSP reports
  (`/v1/csp-report`). The browser calls it directly at
  `NEXT_PUBLIC_AGENT_PY_URL` (or on the same origin behind a proxy).

The frontend/backend contract is the OpenAPI spec in
`packages/contract/`; a new backend implementation is checked against
its conformance suite.

## Folder fences

The `lib/` folder is split by runtime. The folder name tells you
where the code runs, and a fence import at the top of each file
enforces the boundary at build time:

| Folder | Runtime | Fence | Allowed imports |
|---|---|---|---|
| `lib/client/`  | Browser only | `import "client-only"` | `@/client/*`, `@/shared/*` |
| `lib/server/`  | Node only (the CSP builders `proxy.ts` and the sandbox frame use) | `import "server-only"` | `@/server/*`, `@/shared/*` |
| `lib/shared/`  | Isomorphic (pure, no I/O) | none | `@/shared/*` only |

ESLint enforces the same convention via `no-restricted-imports`
in `eslint.config.mjs`. After a production build, run
`bun run audit:bundle` to confirm no server-only paths or
secret env-var names leaked into `.next/static/chunks/*.js`.

## State management

Zustand with `localStorage` persistence. The store is split into
slices under `lib/client/hooks/store/slices/` (one file per
entity: `ui`, `chat`, `workspaces`, `conversations`, `messages`,
`documents`, `files`, `resources`, `mcp`, `url-bookmarks`,
`notes`, `artifacts`, `project-tasks`, `prompts`, `agents`).
`use-store.ts` is a thin composition + re-export hub.

The persisted localStorage shape + `STORE_VERSION` are a frozen
contract - `store/persist.test.ts` pins the exact persisted key
set. Adding or removing a persisted key needs a matching
`runMigrations` step + version bump.

## Supabase

Local or hosted Postgres + Storage + Auth. SQL lives under
`supabase/migrations/` as numbered files applied in order. See
[Supabase setup](22-supabase-setup.md) for the run order, or
`docs/SUPABASE_LOCAL.md` for the local Docker path.

## Related
- [CLAUDE.md](../../CLAUDE.md) - the developer-oriented companion to this page
- [Model providers](23-model-providers.md)
- [MCP server config](24-mcp-server-config.md)
