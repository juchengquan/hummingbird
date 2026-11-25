# agent-ts

## Frozen

**agent-ts is frozen.** It gets bug and security fixes only: no new
endpoints, no new features, no catching up with agent-py.

Why: decision **Q11** of
[`docs/PLAN-frontend-backend-split.md`](../../docs/PLAN-frontend-backend-split.md).
`services/agent-py` is the backend going forward. A TypeScript backend
stays possible, but as a *second implementation of the published
contract*: a future TS backend implements `packages/contract` and has to
pass the shared, language-neutral conformance suite. It will not grow out
of this service. That is also why agent-ts intentionally lacks endpoints
agent-py has or will get (e.g. `/v1/extract-table`,
`/v1/files/refresh-url`).

Q11 also required agent-ts to stop importing the Next app's `lib/`. It
now builds and runs on its own (see [Vendored code](#vendored-code)).

**Known issues (not fixed here, by decision).**
- `generateImage` gives the model Minimax's image URL, which expires
  within hours, so an answer can name a dead link (Q98). Next and
  agent-py give it a stored link or "shown to the user" (Q86). agent-ts
  goes in Phase 5.

---

TypeScript twin of `services/agent-py`, on Bun + Hono, serving the
`/v1/*` surface the frontend reaches with the `'remote'` dispatch option
(`NEXT_PUBLIC_AGENT_TS_URL`). See [`../README.md`](../README.md) for how
the three backends relate and the per-endpoint entry points.

## Vendored code

Everything agent-ts used from the Next app's `lib/` is a **frozen copy**
under `src/vendor/`, mirroring the original paths
(`lib/server/x.ts` → `src/vendor/server/x.ts`,
`lib/shared/x.ts` → `src/vendor/shared/x.ts`). They were copied from
commit `afc33009135d6166adb4196598350638a8aafc3f`, and each file's header
records its source path and that commit.

**Fixes to the Next app originals no longer propagate here.** If a
security fix lands in one of these modules in `lib/`, port it to the copy
by hand.

Only the import specifiers were rewritten (`@/server/*` / `@/shared/*` →
relative paths, `@/config/*` → `@config/*`), with two exceptions, each
marked `VENDOR DEVIATION` in the file:

- `server/supabase/server.ts` drops the `next/headers` + `@supabase/ssr`
  cookie client and throws instead. agent-ts has no Next request scope,
  and the function can't be reached: `src/skills.ts` replaces the shared
  `searchFiles` tool with the Postgres one in `src/search-files.ts`.
- `shared/skills/types.ts` replaces the type-only `lucide-react` import
  with an opaque local type.

The copies (what agent-ts imports directly, plus everything those files
import):

| Folder | Modules |
|---|---|
| `server/` | `extraction`, `model-provider`, `providers-config`, `rate-limit` |
| `server/ai/` | `structured` |
| `server/code-sandbox/` | `config`, `marshal`, `microsandbox-client`, `mime`, `mount-files`, `race-abort`, `runtime`, `select-sandbox`, `semaphore`, `types` |
| `server/embeddings/` | `provider` |
| `server/extraction/` | `heuristics`, `render-pdf`, `vision`, `vision-model`, `zip-guard` |
| `server/mcp/` | `client`, `outbound` |
| `server/skills/` | `code-interpreter`, `file-search`, `image-gen`, `minimax-image-client`, `registry`, `web-fetch`, `web-search` |
| `server/supabase/` | `server` (deviation, see above) |
| `server/url/` | `fetch`, `guarded-fetch`, `validate` |
| `shared/` | `api-errors`, `api-schemas`, `models`, `suggestions-parser`, `types`, `upload-config`, `verify` |
| `shared/artifacts/` | `citation-table`, `column-type` |
| `shared/canvas/` | `types` |
| `shared/generative-ui/` | `schemas` |
| `shared/mcp/` | `credentials` |
| `shared/skills/` | `bounded-int`, `file-search-config`, `image-gen-config`, `types` (deviation, see above), `web-fetch-config`, `web-search-config` |
| `shared/supabase/` | `env`, `types` |

The copies keep their `import "server-only"` fence. `bun run
start|dev|test` pass `--conditions=react-server`, which resolves that
package to its empty shim.

Every npm package the copies need is declared in this `package.json`,
pinned to the version the root lockfile had resolved. Nothing resolves
through the repo root's `node_modules` any more. One shift is
unavoidable: the copies now run on agent-ts's own `ai` (5.0.x) and `zod`
(4.x) resolutions instead of the root's.

CI fails the `agent-ts` job if anything under `services/agent-ts` imports
`@/server`, `@/shared`, `@/client` or a relative `../lib` path.

## Shared configuration

agent-ts still reads two repo-root files. They are configuration, not
code, and every backend uses them, so they are not vendored:

- `config/models.json`: the model catalog (allowlist: its `anthropic/*`
  entries)
- `config/providers.json`: provider credentials and routes, used by the
  vendored `model-provider`

They are imported through the `@config/*` path in `tsconfig.json`, which
points to `../../config/*`. So agent-ts expects to sit at
`services/agent-ts` with `config/` two levels up, both in the repo and in
the Docker image (`/srv/services/agent-ts` + `/srv/config`).

## Running

```bash
cd services/agent-ts
bun install --frozen-lockfile   # its own deps only; no root install needed
bun run dev                     # http://localhost:8001 (SERVICE_PORT)
bun run typecheck
bun run test
```

It reads the repo-level `.env` like the other backends (Anthropic key,
Supabase JWT secret / DB URL, etc.; see `src/env.ts`).

`tests/jobs.test.ts` compares its SQL against
`services/agent-py/src/agent_py/jobs.py`, so the test suite expects the
agent-py sources to sit next to this service. The service itself does
not need them.

## Docker

Build from the **repo root**, because the image needs `config/`:

```bash
docker build -f services/agent-ts/Dockerfile -t hummingbird/agent-ts .
```

The image contains only `services/agent-ts` (production deps from its
own lockfile) and `config/`. It no longer copies `lib/` or installs the
root `node_modules`.
