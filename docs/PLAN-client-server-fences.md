# Plan: Client / server split inside the frontend

Status: **draft** — survey + recommendations only. Not yet
implemented.

## Why

Phase 1 of `docs/PLAN-backend-extraction.md` separated **frontend
from backend** at the wire-protocol level (every cross-process call
goes through `lib/api-client.ts`). This plan separates **client from
server** *inside* the Next.js app: making sure browser bundles never
pull in server-only code, and server-only code can't accidentally be
imported into a "use client" component.

Concretely the things we want to prevent:

- **Secrets leaking into the client bundle** — service-role Supabase
  key, Tavily key, AI Gateway key get inlined if a server-only module
  is referenced from a browser-rendered file.
- **Bundle bloat** — `pdf-parse` / `mammoth` / `xlsx` /
  `node-html-parser` only run server-side in extraction. If something
  imports them from a client context, Webpack tries to bundle them
  for the browser, ballooning the JS payload.
- **Runtime errors from `window` / `document` references** during
  SSR, or `process.env.SECRET` references in the browser.
- **Audit churn** — today there's no way to tell at a glance whether
  a file in `lib/` is meant for client, server, or both.

The boundary is enforceable. Next.js ships two zero-runtime packages
(`server-only` and `client-only`) that throw at build time when a
module crosses contexts. We're not using either today.

## Inventory of `lib/`

What's actually in there, classified by where it can run safely:

### Pure shared (no I/O, no browser/Node specifics)

| File | What it is |
|---|---|
| `lib/api-errors.ts` | error categorisation map (pure functions) |
| `lib/api-schemas.ts` | Zod schemas + inferred TS types |
| `lib/code-blocks.ts` | markdown fence extractor |
| `lib/markdown-joiner-transform.ts` | stream transform for AI SDK |
| `lib/models.ts` | static `CHAT_MODELS` array |
| `lib/skills/registry.ts` | static `SKILLS` array |
| `lib/skills/types.ts` | type + resolveSkill helper |
| `lib/smart-paste/actions.ts` | action labels + prompt templates |
| `lib/smart-paste/detect.ts` | pure detector |
| `lib/supabase/env.ts` | reads `process.env` — works in both, sees nothing on the client for `_PUBLIC_*` only |
| `lib/supabase/types.ts` | hand-rolled DB types |
| `lib/types.ts` | TS interfaces only |
| `lib/upload-config.ts` | static config |
| `lib/utils.ts` | `cn` helper |
| `lib/uuid.ts` | crypto.randomUUID wrapper |
| `lib/branches/tree.ts` | pure tree builder |
| `lib/sync/handlers.ts` | pure diff functions |

### Client-only (uses `window`, `indexedDB`, React hooks, Zustand)

| File | Signal |
|---|---|
| `lib/hooks/use-store.ts` | Zustand store + persist middleware |
| `lib/hooks/use-auth.ts` | `useEffect` against browser Supabase client |
| `lib/hooks/use-sync.ts` | Browser-side queue + sync |
| `lib/hooks/use-sync-enabled.ts` | Reads from Zustand |
| `lib/hooks/use-reconcile.ts` | Browser-side reconcile against Supabase |
| `lib/files/local-store.ts` | IndexedDB wrapper |
| `lib/files/use-file-availability.ts` | React hook |
| `lib/files/persist.ts` | Reads Zustand + calls Storage from browser |
| `lib/files/fetch-blob.ts` | Browser fetch + IDB |
| `lib/supabase/client.ts` | Browser Supabase client |
| `lib/sync/sync-queue.ts` | Uses `localStorage` |
| `lib/sync/reconcile.ts` | Browser-side Supabase reads + writes |
| `lib/file-utils.tsx` | Returns JSX |
| `lib/export.ts` | Uses `document.createElement('a')` for downloads |
| `lib/extract.ts` | Uses browser `FormData` / `FileReader`; calls `apiClient` |
| `lib/api-client.ts` | Thin browser fetch wrapper |

### Server-only (process secrets, server SDKs)

| File | Signal |
|---|---|
| `lib/supabase/admin.ts` | service-role key |
| `lib/supabase/server.ts` | server Supabase client (cookies API) |
| `lib/share/resolve.ts` | uses admin client |
| `lib/skills/web-search.ts` | reads `TAVILY_API_KEY`, calls Tavily |
| `app/api/*/route.ts` | all route handlers; `createGateway`, `pdf-parse`, etc. |

### Mixed / SSR-ambiguous

| File | Why |
|---|---|
| `lib/api-schemas.ts` | shared; route handlers parse with it, frontend infers types from it. Pure schemas — safe on both sides. |

## Risks today

Without fences, there's no compile-time check that browser bundles
exclude the server-only files. Three concrete things would break
silently if someone moved code:

1. Importing `lib/supabase/admin.ts` from a client component would
   inline `SUPABASE_SERVICE_ROLE_KEY` into the browser bundle (if
   it's a `NEXT_PUBLIC_*` it's intentional; the service role isn't —
   though Next won't expose non-`NEXT_PUBLIC_*` envs, the import
   would still fail at runtime).
2. Importing `lib/skills/web-search.ts` from the client would pull
   `tool({...})` from `ai` into the browser bundle and never run.
3. Importing `lib/supabase/server.ts` from a client component throws
   on the `cookies()` from `next/headers` import — Next does catch
   this one, but the error is opaque ("Cookies() can only be called
   from a Server Component").

Today these don't happen because of careful manual discipline. The
issue is **nothing enforces the discipline**.

## Options

### Option A — `server-only` / `client-only` fences (recommended)

Add `import "server-only"` at the top of every server-only module and
`import "client-only"` at the top of every client-only one. These are
zero-runtime-cost markers that Next.js / the bundler turn into
build-time errors if anything in the wrong context imports them.

**Files getting `server-only`:**

- `lib/supabase/admin.ts`
- `lib/supabase/server.ts`
- `lib/share/resolve.ts`
- `lib/skills/web-search.ts`
- *(route handlers under `app/api/*/route.ts` don't need it — Next.js
  already treats them as server-only by routing)*

**Files getting `client-only`:**

- `lib/hooks/use-store.ts`
- `lib/hooks/use-auth.ts`
- `lib/hooks/use-sync.ts`
- `lib/hooks/use-sync-enabled.ts`
- `lib/hooks/use-reconcile.ts`
- `lib/files/local-store.ts`
- `lib/files/use-file-availability.ts`
- `lib/files/persist.ts`
- `lib/files/fetch-blob.ts`
- `lib/supabase/client.ts`
- `lib/sync/sync-queue.ts`
- `lib/sync/reconcile.ts`
- `lib/file-utils.tsx`
- `lib/export.ts`
- `lib/extract.ts`
- `lib/api-client.ts`

**Pros**: Build-time enforcement. ~1-line addition per file. Reversible
— remove the import to relax. The bundle never gets the wrong thing.

**Cons**: New compile error every time someone crosses the line by
mistake — friction during refactors. Forgetting to add it to a new
file is silent (no checker yet that "every file in `lib/hooks/`
should be client-only").

**Effort**: ~30 minutes mechanical.

### Option B — Folder restructure (`lib/client/` and `lib/server/`)

Move the files into context-named subfolders so imports tell you the
context at a glance:

```
lib/
  shared/      -- pure utils, types, schemas
  client/      -- browser-only
  server/      -- server-only
```

**Pros**: Most readable. Convention scales to new files automatically.
Easy to grep: `import "@/lib/server/*"` from a client file is an
instant red flag.

**Cons**: Moves ~25 files. Every import path in the app changes. Big
diff that obscures actual content changes for weeks. Forces a
decision on the "mixed but pure" files (api-schemas, api-errors,
types, utils) — they go in `shared/` but that adds another folder.

**Effort**: 1 day moving + import-path rewrites, ~70 files touched.

### Option C — Naming convention (`.client.ts` / `.server.ts`)

Suffix-based: `lib/foo.server.ts` is server-only, `lib/foo.client.ts`
is client-only, plain `lib/foo.ts` is shared. Some codebases pair this
with eslint rules that disallow cross-context imports.

**Pros**: Visible at the import line. No folder reshuffle.

**Cons**: Doesn't enforce anything by itself — needs eslint rules
that don't exist in this repo today. Suffixes get noisy when half the
files have them.

**Effort**: ~3 hours rename + eslint config.

### Option D — Status quo + lint-rule

Don't move or mark anything; add an eslint rule that flags imports
from listed server-only files inside client components.

**Pros**: Zero file churn.

**Cons**: The "list" duplicates information the filesystem could
encode. Easy to forget when adding new files.

## Recommendation

**Do Option A.** It's mechanical, reversible, and the only one that
produces a real build-time error rather than relying on convention or
review. It pairs naturally with the existing folder layout — every
`lib/hooks/*.ts` becomes `client-only`, every `lib/supabase/admin.ts`
becomes `server-only`, and the bundle is auto-audited from then on.

**Skip Option B** unless the team grows. The folder reshuffle's cost
(every import path in the app changes) outweighs the readability win
for a solo codebase.

**Defer Option C and D**. Both are weaker enforcement than A, and A
makes them unnecessary.

## Phase 1 — Add `server-only` and `client-only` fences

**New dependencies**: `server-only` and `client-only` packages. Both
are tiny (~100 bytes each), zero runtime cost, ship with Next.js's
recommendations.

```bash
bun add server-only client-only
```

**File changes**: ~20 files get one new import line:

```ts
import "server-only" // or "client-only"
```

at the top. No other changes.

**Verification**:

1. `bunx tsc --noEmit` — no type errors.
2. `bun run build` — completes; no client bundle includes any
   server-only path.
3. As a smoke test, deliberately add `import "@/lib/supabase/admin"`
   to a component file and confirm `bun run build` fails with a clear
   error message. Then revert.
4. `grep -rn '^import "server-only"' lib/` and verify it matches the
   expected file list.

**Risk**: One file in the "client-only" list might transitively be
imported by a server-side path I missed (e.g., `lib/extract.ts` is
called from the chat panel, but its `apiClient` underpinning is
browser-only — that's correct, but if a route handler ever imports
from `lib/extract.ts`, the fence catches it). The first build after
adding the fences will tell us.

## Phase 2 — Optional: tighten the "shared" surface

After fences are in place, audit what's actually in the shared bucket.
Today it's everything pure (schemas, types, utils, models). Two small
improvements possible:

1. **`lib/shared/`** folder for the genuinely-shared modules
   (`api-schemas`, `api-errors`, `types`, `models`, `utils`, `uuid`,
   `code-blocks`, `markdown-joiner-transform`, `smart-paste/`,
   `skills/registry`, `skills/types`, `branches/tree`,
   `sync/handlers`). Same idea as Option B but applied to only ~14
   files; less churn.

2. **Audit large transitive deps**. Run `bun run build` and inspect
   `.next/analyze/client.html` (or use `next-bundle-analyzer`).
   Anything heavy in the client bundle that looks server-shaped is
   smoke from a missing fence.

Defer until Phase 1 is in.

## What this doesn't solve

- **Components folder split**. `components/` is already
  client-dominated; the few server components (share pages) live in
  `app/` not `components/`. No reorg needed there.
- **Type sharing with the future Python backend**. The Zod schemas in
  `lib/api-schemas.ts` are the durable shared surface; nothing to
  move.
- **Bundle size from Plate.js / shadcn**. Those are large but are
  legitimately client-side. Out of scope for this plan.

## Suggested commit shape

Single commit, ~20 files modified, one new package dependency:

```
chore(boundaries): mark client-only and server-only modules

Adds `server-only` / `client-only` imports to every module under
lib/ that genuinely runs in just one context. Makes the boundary
build-enforced instead of convention-policed.

Files getting `server-only`:
  - lib/supabase/admin.ts
  - lib/supabase/server.ts
  - lib/share/resolve.ts
  - lib/skills/web-search.ts

Files getting `client-only`:
  - lib/hooks/use-store.ts and the rest of lib/hooks/*
  - lib/files/*
  - lib/supabase/client.ts
  - lib/sync/sync-queue.ts, lib/sync/reconcile.ts
  - lib/file-utils.tsx, lib/export.ts, lib/extract.ts, lib/api-client.ts

Pure modules (api-schemas, api-errors, types, models, utils, etc.)
stay unfenced — those are intentionally shared.
```

Adds a sentence to `CLAUDE.md` documenting the rule: "Any new module
that uses a browser API or a server secret must start with the
matching `import 'server-only'` or `import 'client-only'`. Pure
modules (no I/O, no DOM, no Node API) stay unfenced."
