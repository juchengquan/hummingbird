# Hummingbird backends — where they live

Hummingbird ships with **three interchangeable backends** for the chat
turn (`/v1/chat`-shaped wire) plus the non-chat endpoints
(`summarize`, `extract`, `url/fetch`, `images/refresh-url`, `mcp/...`;
agent-py also serves `files/refresh-url`, `extract-table`, `share`,
`tasks/schedules`, `embed`, `memory/extract` and `csp-report`).
Two live here under `services/`; the third lives split across `app/api/`
and `lib/server/` at the repo root because Next.js's App Router owns
those paths. The frontend picks one per account via
`lib/client/api/backend-resolver.ts`'s `DispatchOption` union (`'in-next'`
/ `'remote'`).

Both `services/` backends stay live and the user picks one per account
via the Phase 4-2 selector (`PLAN-agent-api.md`). **agent-ts is frozen**,
though: bug and security fixes only, no new endpoints (decision Q11 of
`docs/PLAN-frontend-backend-split.md`; see
[`agent-ts/README.md`](agent-ts/README.md) § Frozen). It is
self-contained: what it used from the Next app's `lib/` is vendored
under `services/agent-ts/src/vendor/` as frozen copies.

| Backend | Where | Stack | DispatchOption | Notes |
|---|---|---|---|---|
| **Next.js (original TS)** | `app/api/**/route.ts` + `lib/server/**` | Next.js App Router · `@ai-sdk/*` · Vercel AI Gateway | `'in-next'` | Co-located with the frontend; route handlers can't move out of `app/` without giving up App Router routing. Shared by Server Components too. |
| **agent-py** | `services/agent-py/` | Python 3.12 · FastAPI · uv · asyncpg · Anthropic SDK | `'remote'` (`NEXT_PUBLIC_AGENT_PY_URL`) | Standalone container. Owns the `task_jobs` poller + executor. |
| **agent-ts** | `services/agent-ts/` | Bun · Hono · `@ai-sdk/*` · `postgres` (pg under RLS impersonation) | `'remote'` (`NEXT_PUBLIC_AGENT_TS_URL`) | Standalone container. **Frozen** (Q11): mirrors agent-py's surface as of the freeze; no new endpoints. Doesn't import the Next app's `lib/`. |

## Background tasks — who executes them

Only **agent-py** executes `task_jobs` (`start` / `continue` /
`respond`), for every user unless an admin opts the user out
(`auth.users.raw_app_meta_data->>'agent_backend'` set to anything but
`'python'` — see `services/agent-py/README.md` § "Who executes tasks").
agent-ts has no executor; its poll loop only claims and releases, so it
is off unless `AGENT_TS_POLLER_ENABLED=true` (each release pushes the
job's `scheduled_at` back and delays agent-py). The Next.js app runs no
worker; its stale-run reconciler fails a task no worker started within
`TASK_NO_WORKER_TIMEOUT_MINUTES` (default 10) with "No task worker
available".

Recurring runs (`task_schedules`) are enqueued by a dispatcher:
agent-py's own loop (`scheduler.py`), on by default wherever its worker
runs (`WORKER_DRY_RUN=false` with `SUPABASE_DB_URL`; `SCHEDULER_ENABLED`
overrides, Q130), and — until wave 13 deletes it — the now-redundant
Vercel Cron calling `/api/tasks/jobs/tick` every minute. The two can run
side by side (a guarded `next_run_at` claim fires each occurrence once);
see `services/agent-py/README.md` § "Scheduled tasks".

## Why the third backend doesn't live under `services/`

Next.js's App Router resolves URLs by the filesystem layout under
`app/`. Moving `app/api/chat/route.ts` to `services/agent-next/...`
would lose the route entirely. The two structural options were:

1. **Thin shims under `app/api/`** that delegate to
   `services/agent-next/` — pure indirection, no runtime win,
   doubled the discovery cost.
2. **A parallel Hono server alongside Next.js** — duplicates the
   transport layer + breaks the `lib/server/*` imports that Server
   Components rely on.

Neither earned its keep, so the layout above is the deliberate
choice. If Hummingbird ever ships a TS backend without Next.js
(no current roadmap), the natural unwind is option 2 + a path-alias
sweep of `@/server/*` to point at the new location.

## Entry points — quick map

If you're looking for the chat-route equivalent in each backend:

| Surface | Next.js (`'in-next'`) | agent-py | agent-ts |
|---|---|---|---|
| Chat | `app/api/chat/route.ts` | `services/agent-py/src/agent_py/routers/chat.py` | `services/agent-ts/src/routes/chat.ts` |
| Summarize | `app/api/summarize/route.ts` | `routers/summarize.py` | `routes/summarize.ts` |
| Extract | `app/api/extract/route.ts` | `routers/extract.py` | `routes/extract.ts` |
| URL fetch | `app/api/url/fetch/route.ts` | `routers/url.py` | `routes/url-fetch.ts` |
| MCP proxy | `app/api/mcp/[serverId]/[action]/route.ts` | `routers/mcp.py` | `routes/mcp-proxy.ts` |
| Refresh image URL | `app/api/images/refresh-url/route.ts` | `routers/images.py` | `routes/refresh-url.ts` |
| Refresh file URL | `app/api/files/refresh-url/route.ts` | `routers/files.py` | — (frozen; client uses the Next.js route) |
| Extract table | `app/api/extract-table/route.ts` | `routers/extract_table.py` | — (frozen; client uses the Next.js route) |
| Share create / revoke | `app/api/share/route.ts`, `app/api/share/[token]/route.ts` | `routers/share.py` (data: `shares.py`) | — (frozen; client uses the Next.js routes) |
| Share public read | `lib/server/share/resolve.ts` (server-rendered in `app/share/*/[token]/page.tsx`) | `routers/share.py` — `GET /v1/share/{token}`, no auth | — |
| Task schedules (CRUD) | `app/api/tasks/schedules/**/route.ts` | `routers/schedules.py` | — (frozen; client uses the Next.js routes) |
| Schedule dispatcher | `app/api/tasks/jobs/tick/route.ts` (Vercel Cron) | `scheduler.py` (`SCHEDULER_ENABLED`) | — |
| Embed file | `app/api/embed/route.ts` | `routers/embed.py` (+ `embeddings.py`, `chunk.py`) | — (frozen; client uses the Next.js route) |
| Memory extract | `app/api/memory/extract/route.ts` | `routers/memory.py` (+ `memory_extract.py`) | — (frozen; client uses the Next.js route) |
| CSP reports | `app/api/csp-report/route.ts` | `routers/csp_report.py` (+ `csp_report.py`) | — |
| Runs (`/v1/runs`, Phase 2) | — (the old task routes read the same `tasks` rows, background only) | `routers/runs.py` (+ `runs/`: wiring, driver, repositories, event logs, AG-UI encoder + stream, native harness over `chat_loop.py`) | — |

Shared by all three: the Zod wire schemas in `lib/shared/api-schemas.ts`
(agent-ts uses a frozen copy, `src/vendor/shared/api-schemas.ts`) and
the streaming SSE protocol documented in `docs/API.md`.

agent-ts is frozen (no new endpoints — `docs/PLAN-frontend-backend-split.md`,
Q11), so surfaces added after the freeze exist only in agent-py. For
those (`files/refresh-url`, `extract-table`, share create / revoke,
`tasks/schedules`, `embed`, `memory/extract`)
`lib/client/api-client.ts` dispatches remotely only when the account's
backend is agent-py (`agentPyOnlyDispatch`); `ts-service` accounts stay
on the Next.js route.

The share pages are not per-account (their viewers are usually
anonymous): when `NEXT_PUBLIC_AGENT_PY_URL` is set they read every share
from agent-py's public `GET /v1/share/{token}` in the browser
(`components/share/backend-share-view.tsx` → `apiClient.share.resolve`);
unset, they resolve it server-side with the service-role key as before.
For a cross-origin agent-py the page's origin must be in agent-py's
`CORS_ALLOWED_ORIGINS`.

CSP reports are not per-account: the browser posts them wherever the
page's policy says. `proxy.ts` points `report-uri` /
`Reporting-Endpoints` at agent-py's `/v1/csp-report` whenever
`NEXT_PUBLIC_AGENT_PY_URL` is set (`/` → same-origin `/v1/csp-report`;
an absolute URL → `<base>/v1/csp-report`; `cspReportUri` in
`lib/server/security/csp.ts`), else at the Next.js route. A
cross-origin agent-py needs the frontend's origin in
`CORS_ALLOWED_ORIGINS`: Reporting-API deliveries
(`application/reports+json`) are CORS requests with a preflight.

Ports of TypeScript logic that must behave identically — the embedding
chunker, the memory prompt + merge, CSP report sanitising — are pinned
by parity fixtures generated from the TS originals
(`bun run codegen:agent-py-parity` → `services/agent-py/tests/fixtures/`;
`scripts/__tests__/agent-py-parity.test.ts` fails when a TS original
changes without regenerating them).

## Model allowlist

One list governs every backend: `config/models.json`. The Next.js
routes accept any id in it (`selectModel` → 400 `unknown_model`
otherwise, unless the request brings its own gateway key).

**agent-py** (wave 10) accepts every catalog id too and serves each on
its provider (`agent_py/model_routes.py`). It speaks one wire format,
Anthropic's Messages API, to every provider Next uses: the Vercel AI
Gateway (`/v1/messages`), OpenRouter (`/api/v1/messages`), Ollama (≥ 0.14)
and Minimax (already `"type": "anthropic"`). The providers come from
`config/providers.json` and the variables it names; a model takes its
catalog `routes` in order, the first whose provider is configured, as
`lib/server/model-provider.ts` picks it, except that an `anthropic/*`
model goes to Anthropic directly when `ANTHROPIC_API_KEY` is set (its
`anthropicModelId`: `anthropic/claude-sonnet-4.6` → `claude-sonnet-4-6`).
A provider whose URL is plain http, loopback or private is skipped with
a warning unless it is `allowInsecureBaseUrl` (Ollama), as Next's
`isSafeBaseUrl` does. A catalog id without a configured provider is still
valid: its calls answer 503 (`unavailable` / `auth`), as a missing
Anthropic key did. `GET /v1/models` lists the ids that do run, and the
browser's picker offers those.

**agent-ts** (frozen) still accepts only the `anthropic/*` entries and
calls Anthropic directly. Anything else is a 400 `unknown_model` there.

| | agent-py | agent-ts |
|---|---|---|
| Rule | `agent_py/model_allowlist.py` + `model_routes.py` (read the JSON themselves) | `src/models.ts` over `ANTHROPIC_SERVICE_MODELS` in `src/vendor/shared/models.ts` (frozen copy of `lib/shared/models.ts`; reads `config/models.json` via `@config/*`) |
| 400 body | `{"code": "unknown_model", "message"}` | `{code: "unknown_model", message}` (Next.js envelope) |

What a model can do follows the catalog's flags, as on Next:

- `supportsStructuredOutput`: a forced tool call (structured output) runs
  on the model only when set; otherwise on `AGENT_DEFAULT_MODEL` — the
  editor's tool choice and its comment / table elements, memory
  extraction. (The wave-10 probe found Minimax answers a forced
  `tool_choice` in plain text.) `/v1/extract-table` keeps Next's rule:
  structured path when flagged, the lenient JSON text path otherwise.
- `supportsReasoningEffort`: thinking is sent only to these.
- `supportsTools: false`: chat only — no tools on runs, refused as a task
  (no catalog entry sets it today).
- `thinksUnprompted`: the model thinks before answering without being
  asked (MiniMax M2.7 / M3 / M3.1 Flash); ghost text gives it room.
- Images go to every model as on Next (Next doesn't refuse them either).
- OpenRouter `fallbacks` go as OpenRouter's `models` list.

Where it's enforced:

- **`/v1/chat`** — `model` is required and must be a catalog id; checked
  before the provider check, like the Next.js route.
- **`/v1/summarize`** — `model` is optional; absent →
  `AGENT_DEFAULT_MODEL`, present → must be a catalog id.
- **Follow-up suggestions** — always `AGENT_DEFAULT_MODEL`, on its own
  provider's client.
- **Task executor** — `tasks.checkpoint.config.model` is re-checked
  before the run calls its provider. The checkpoint row is owner-writable
  under RLS, so a tampered id fails the run (`result: failed`, task
  `failed`) instead of reaching a model.
- **`/v1/extract-table`** (agent-py only) — `model` is optional; absent
  → `AGENT_DEFAULT_MODEL`, present → must be a catalog id.
- **`/v1/memory/extract`** (agent-py only) — no request model; the
  operator's `MEMORY_EXTRACT_MODEL` is used when it is a catalog id with
  structured output that a provider serves here, otherwise (and when
  unset) `AGENT_DEFAULT_MODEL`. Always the forced-tool structured path
  (as `generateObject`).
- `/v1/extract`, `/v1/url/fetch`, `/v1/embed` (its embedder is an
  OpenAI-compatible endpoint, `EMBEDDINGS_*` / `OLLAMA_*`, not a chat
  model), `/v1/csp-report`, MCP and image / file refresh take no model
  id.

Config:

- `AGENT_DEFAULT_MODEL` (both; default `anthropic/claude-haiku-4.5`,
  empty → default) — validated at boot: a value outside the allowlist
  stops the service from starting.
- `MODELS_CONFIG_PATH` (agent-py) — path to the catalog. Empty →
  searched upward from the package. agent-py's Docker image is built
  from the **repo root** (`docker build -f services/agent-py/Dockerfile .`,
  as `docker-compose.yml` does) and ships the file at
  `/app/config/models.json`; agent-ts's image already copies `config/`.
  A missing or invalid catalog fails boot.

`VERIFY_MODEL` (agent-py's citation verifier) is an operator setting,
not request input, and is not checked against the allowlist.
