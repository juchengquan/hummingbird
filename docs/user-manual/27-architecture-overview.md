<!-- related: CLAUDE.md, docs/MASTER_PLAN.md -->

# Architecture overview

## What it is
The 30,000-foot view of how Hummingbird is put together. Useful
when you're self-hosting and need to know which piece handles
which concern.

## The three layers

```
Browser (Next.js client)  ->  /api/* (Next.js route handlers)  ->  external services
                                        |
                              services/agent-py  (Python)
                              services/agent-ts  (TypeScript, Phase 5+)
```

- **`app/`** - Next.js App Router pages and route handlers. This
  is the primary backend surface: chat streaming, MCP proxy, file
  extraction, share links, summarize.
- **`services/agent-py/`** - the Python agent service. FastAPI +
  asyncpg. Runs the long-running agent task loop and (Phase 2b+)
  the real model call for flagged users.
- **`services/agent-ts/`** - the TypeScript agent service
  (Phase 5). Same dispatch shape as the Python one; uses the
  Vercel AI SDK instead of asyncpg + Anthropic.

The frontend picks one per account via
`lib/client/api/backend-resolver.ts`'s `DispatchOption`
(`'in-next'` / `'remote'`). Both backends stay live
indefinitely.

## Folder fences

The `lib/` folder is split by runtime. The folder name tells you
where the code runs, and a fence import at the top of each file
enforces the boundary at build time:

| Folder | Runtime | Fence | Allowed imports |
|---|---|---|---|
| `lib/client/`  | Browser only | `import "client-only"` | `@/client/*`, `@/shared/*` |
| `lib/server/`  | Node only (route handlers, server components) | `import "server-only"` | `@/server/*`, `@/shared/*` |
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
`supabase/migrations/` as seventeen files (0001-0017). See
[Supabase setup](22-supabase-setup.md) for the run order, or
`docs/SUPABASE_LOCAL.md` for the local Docker path.

## Related
- [CLAUDE.md](../../CLAUDE.md) - the developer-oriented companion to this page
- [Model providers](23-model-providers.md)
- [MCP server config](24-mcp-server-config.md)
