# Hummingbird backends — where they live

Hummingbird ships with **three interchangeable backends** for the chat
turn (`/v1/chat`-shaped wire) plus the non-chat endpoints
(`summarize`, `extract`, `url/fetch`, `images/refresh-url`, `mcp/...`;
agent-py also serves `files/refresh-url` and `extract-table`).
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

Recurring runs (`task_schedules`) are enqueued by a dispatcher: today the
Vercel Cron calling `/api/tasks/jobs/tick` every minute, and — when
`SCHEDULER_ENABLED=true` — agent-py's own loop (`scheduler.py`). The two
can run side by side (a guarded `next_run_at` claim fires each occurrence
once); see `services/agent-py/README.md` § "Scheduled tasks".

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
| Task schedules (CRUD) | `app/api/tasks/schedules/**/route.ts` | `routers/schedules.py` | — (frozen; client uses the Next.js routes) |
| Schedule dispatcher | `app/api/tasks/jobs/tick/route.ts` (Vercel Cron) | `scheduler.py` (`SCHEDULER_ENABLED`) | — |

Shared by all three: the Zod wire schemas in `lib/shared/api-schemas.ts`
(agent-ts uses a frozen copy, `src/vendor/shared/api-schemas.ts`) and
the streaming SSE protocol documented in `docs/API.md`.

agent-ts is frozen (no new endpoints — `docs/PLAN-frontend-backend-split.md`,
Q11), so surfaces added after the freeze exist only in agent-py. For
those (`files/refresh-url`, `extract-table`, `tasks/schedules`) `lib/client/api-client.ts`
dispatches remotely only when the account's backend is agent-py
(`agentPyOnlyDispatch`); `ts-service` accounts stay on the Next.js route.

## Model allowlist

One list governs every backend: `config/models.json`. The Next.js
routes accept any id in it (`selectModel` → 400 `unknown_model`
otherwise, unless the request brings its own gateway key). The two
services call Anthropic directly, so they accept **only its
`anthropic/*` entries** and send each one's `anthropicModelId` upstream
(`anthropic/claude-sonnet-4.6` → `claude-sonnet-4-6`; the catalog id
uses a dot, the Anthropic API id a dash, so every `anthropic/*` entry
sets the field — without it the service strips the `anthropic/`
prefix). Anything else — a non-Anthropic catalog id, a raw API id, a
typo — is a 400 `unknown_model`:

| | agent-py | agent-ts |
|---|---|---|
| Rule | `agent_py/model_allowlist.py` (reads the JSON itself) | `src/models.ts` over `ANTHROPIC_SERVICE_MODELS` in `src/vendor/shared/models.ts` (frozen copy of `lib/shared/models.ts`; reads `config/models.json` via `@config/*`) |
| 400 body | `{"detail": {"code": "unknown_model", "message"}}` (FastAPI `HTTPException`) | `{code: "unknown_model", message}` (Next.js envelope) |

Where it's enforced:

- **`/v1/chat`** — `model` is required and must be allowed; checked
  before the API-key check, like the Next.js route.
- **`/v1/summarize`** — `model` is optional; absent →
  `AGENT_DEFAULT_MODEL`, present → must be allowed.
- **Follow-up suggestions** — always `AGENT_DEFAULT_MODEL`.
- **Task executor** — `tasks.checkpoint.config.model` is re-checked
  before the run calls Anthropic. `/api/tasks` validated the id at
  creation, but the checkpoint row is owner-writable under RLS, so a
  tampered id fails the run (`result: failed`, task `failed`) instead
  of reaching Anthropic.
- **`/v1/extract-table`** (agent-py only) — `model` is optional; absent
  → `AGENT_DEFAULT_MODEL` (the Next.js route defaults to
  `google/gemini-2.5-flash`, which this service can't call), present →
  must be allowed. The entry's `supportsStructuredOutput` flag picks the
  native structured path first, as on the Next.js route.
- `/v1/extract`, `/v1/url/fetch`, MCP and image / file refresh take no
  model id.

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
