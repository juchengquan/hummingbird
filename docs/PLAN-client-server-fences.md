# Plan: Client / server split inside the frontend

Status: **✅ shipped**. Code is split across `lib/client/`, `lib/server/`, `lib/shared/` with `client-only` / `server-only` fences. ESLint enforces import boundaries; `bun run audit:bundle` verifies no server-only paths leak into the client bundle. See the "Frontend module conventions" section in `CLAUDE.md`.

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

## Inventory of `lib/` *(plus the orphan `hooks/`)*

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
| `hooks/use-upload-file.ts` *(top-level orphan)* | Browser Supabase storage |
| `hooks/use-debounce.ts` *(top-level orphan)* | Browser hook |
| `hooks/use-is-touch-device.ts` *(top-level orphan)* | `window` |
| `hooks/use-mobile.ts` *(top-level orphan)* | `matchMedia` |
| `hooks/use-mounted.ts` *(top-level orphan)* | `useEffect` |
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

Two structural smells the inventory surfaced:

- **`hooks/` and `lib/hooks/` both exist.** Five files in the
  top-level `hooks/` are functionally identical in character to the
  five inside `lib/hooks/`. The split is historical (some came in
  via Plate templates, some grew with the app).
- **No fences anywhere.** No `server-only` or `client-only` imports
  exist in the codebase today.

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

## Options considered

### Option A — `server-only` / `client-only` fences alone

Add the matching import to every context-bound file. Mechanical;
build-time enforcement. Doesn't enforce that *new* files in `lib/`
remember to add the marker, and the context isn't visible at the
import line.

### Option B — Folder restructure alone

Move files into `lib/client/`, `lib/server/`, `lib/shared/`. Intent
is visible at every import. Doesn't enforce anything by itself — a
file in `lib/client/` that forgets the runtime guard still bundles
fine on the wrong side.

### Option C — Naming convention (`.client.ts` / `.server.ts`)

Suffix-based. Weak enforcement; needs eslint to bite.

### Option D — Status quo + lint rule listing files

Zero churn but the list drifts from reality.

### Option E — Hybrid (folder + fence + lint rule) **← recommended**

Combines A + B + a small ESLint check that asserts "every file in
`lib/client/` starts with `import 'client-only'`, every file in
`lib/server/` starts with `import 'server-only'`." Either alone has
a hole the other fills: the folder makes the intent visible; the
fence stops the wrong import at build time; the lint rule makes sure
**new** files in those folders carry the matching fence so the
convention doesn't quietly drift.

## Recommendation

**Do Option E (hybrid).** The marginal cost over Option A is small,
and the marginal payoff is real — visible context at every import
line *plus* enforced consistency for files added later.

## Phase 1 — Reshuffle `lib/` into client / server / shared

Mechanical file moves, no behavior change. Single commit, mostly
`git mv`.

### Target layout

```
lib/
  client/         -- browser-only modules
    hooks/        -- all React hooks (consolidates lib/hooks/ + hooks/)
    files/        -- local-store, persist, fetch-blob, use-file-availability
    sync/         -- sync-queue, reconcile (browser side)
    supabase/     -- client.ts (browser Supabase)
    api-client.ts
    extract.ts
    export.ts
    file-utils.tsx
  server/         -- server-only modules
    supabase/     -- admin.ts, server.ts
    share/        -- resolve.ts
    skills/       -- web-search.ts (rest of skills/ is shared)
  shared/         -- pure utilities, types, schemas
    api-errors.ts
    api-schemas.ts
    code-blocks.ts
    markdown-joiner-transform.ts
    models.ts
    types.ts
    uuid.ts
    utils.ts
    upload-config.ts
    branches/     -- tree.ts (pure)
    skills/       -- registry.ts, types.ts (pure)
    smart-paste/  -- actions.ts, detect.ts (pure)
    supabase/     -- env.ts, types.ts (pure)
    sync/         -- handlers.ts (pure diff functions)
```

### tsconfig path aliases

Short import lines, intent at the front of the path:

```jsonc
// tsconfig.json
"paths": {
  "@/*": ["./*"],
  "@/client/*": ["./lib/client/*"],
  "@/server/*": ["./lib/server/*"],
  "@/shared/*": ["./lib/shared/*"]
}
```

`import { useAuth } from "@/client/hooks/use-auth"` reads loudly.

### Consolidate `hooks/` and `lib/hooks/`

The top-level `hooks/` folder *(use-upload-file, use-debounce,
use-is-touch-device, use-mobile, use-mounted)* and the nested
`lib/hooks/` folder *(use-store, use-auth, use-sync,
use-sync-enabled, use-reconcile)* both house React hooks. The split
is historical. Both collapse into `lib/client/hooks/` so there's one
canonical home and Plate-style templates don't keep recreating the
top-level location.

### Mechanics

- All moves via `git mv` so `git blame` follows files.
- One mechanical commit: moves only, no fence additions.
- Import-path rewrites done in the same commit via a sed pass so
  intermediate commits never have broken imports.

**Effort**: ~1–2 hours mostly mechanical. ~70 files modified
(the moves themselves plus every import update).

## Phase 2 — Add the fences + ESLint rule

Smaller, surgical commit on top of the reshuffle.

### Dependencies

```bash
bun add server-only client-only
```

Both are tiny (~100 bytes each), zero runtime cost.

### Codemod

A 10-line script adds the matching `import` line to every file in
each folder:

```bash
# scripts/add-fences.sh — pseudocode
for f in lib/client/**/*.{ts,tsx}; do
  grep -q '"client-only"' "$f" || sed -i '1i import "client-only"\n' "$f"
done
for f in lib/server/**/*.{ts,tsx}; do
  grep -q '"server-only"' "$f" || sed -i '1i import "server-only"\n' "$f"
done
```

Run once, commit the result. After this, adding the fence to a new
file is a `bun run fix:fences` away.

### ESLint rule

A `no-restricted-imports` config (or 30-line custom rule) checks that
every file under `lib/client/` contains `import "client-only"` and
every file under `lib/server/` contains `import "server-only"`. New
files added without the marker fail CI.

### Verification

1. `bunx tsc --noEmit` — no type errors.
2. `bun run build` — completes; no client bundle includes any
   server-only path.
3. **Bundle audit (real test):** run `bun run build` with
   `@next/bundle-analyzer`, grep the output `client.html` /
   `client.js` for any path containing `lib/server/` or names of
   server-only deps (`pdf-parse`, `mammoth`, `@ai-sdk/gateway`).
   Fail if any match. Wire this into CI as `bun run audit:bundle`.
4. **Deliberate-break smoke test:** add `import "@/server/supabase/admin"`
   to a client component, confirm `bun run build` fails with a clear
   error. Revert.
5. `grep -rL '"client-only"' lib/client` returns nothing — every file
   has the fence.

### `CLAUDE.md` update

Adds a short rule paragraph:

> Frontend code lives in `lib/client/` (browser-only),
> `lib/server/` (Node-only, secrets), or `lib/shared/` (pure: no
> I/O, no DOM, no Node API). Every file in `lib/client/` starts with
> `import "client-only"`; every file in `lib/server/` starts with
> `import "server-only"`. The matching pre-commit / CI check enforces
> this — see `scripts/audit-fences.sh`. Shared files must avoid
> runtime-heavy dependencies (no `pdf-parse`, `mammoth`, etc.) — pure
> functions and types only.

## What this doesn't solve

- **Components folder split**. `components/` is already
  client-dominated; the few server components (share pages) live in
  `app/` not `components/`. No reorg needed there.
- **Type sharing with the future Python backend**. The Zod schemas in
  `lib/shared/api-schemas.ts` are the durable shared surface;
  nothing to move.
- **Bundle size from Plate.js / shadcn**. Those are large but are
  legitimately client-side. Out of scope for this plan.

## Suggested commit shape

Single PR, two commits — splittable for easy review and revert:

```
chore(lib): reshuffle into client/server/shared folders
  - git mv only; updates every import path; consolidates hooks/ + lib/hooks/
  - adds tsconfig path aliases @/client, @/server, @/shared
  - ~70 files touched (mostly import paths)
  - no behavior change

feat(lib): server-only/client-only fences + ESLint rule
  - bun add server-only client-only
  - codemod adds the matching import to every file under lib/client/
    and lib/server/
  - ESLint rule asserts the convention so new files can't drift
  - scripts/audit-fences.sh for CI
  - bundle-analyzer script to catch transitive leaks
  - CLAUDE.md "Frontend module conventions" section
  - ~25 files touched (the fence additions + the eslint config)
```

## Effort summary

| Phase | Work | Hours | Pays off in |
|---|---|---|---|
| 1 | Folder reshuffle (B) | 1–2 | Every future code review |
| 1 | Collapse `hooks/` + `lib/hooks/` | 0.25 | Stops the parallel-locations confusion |
| 1 | tsconfig path aliases | 0.25 | Every import in those folders |
| 2 | `server-only` / `client-only` fences (A) | 0.5 | Whenever someone crosses the line |
| 2 | Codemod for fence-add | 0.25 | Adding new files |
| 2 | ESLint folder-fence rule | 1 | New files in those folders |
| 2 | Bundle audit script | 1 | Catching transitive leaks |
| 2 | `CLAUDE.md` doc update | 0.25 | Onboarding |

**Total**: ~4–5 hours, single PR, two commits.
