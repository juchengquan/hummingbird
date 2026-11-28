# Hummingbird's backend — where it lives

Hummingbird has **one backend**: **agent-py** (`services/agent-py/`,
Python 3.12 · FastAPI · uv · asyncpg · the Anthropic SDK), which the app
requires (wave 13 of `docs/PLAN-frontend-backend-split.md`, Q121). The
browser reaches it at `NEXT_PUBLIC_AGENT_PY_URL` (`/` behind the
same-origin proxy) for every API surface: chat (interactive runs on
`/v1/runs`), tasks (background runs, the `task_jobs` worker, the
schedule dispatcher, the no-worker reconciler), the editor AI, the
signed-out calls and everything account-bound.

The Next.js app is the frontend only: no API routes, no server secrets
(it reads `NODE_ENV`, `CSP_MODE` and `NEXT_PUBLIC_*`, Q143). It stays a
server for the per-request CSP nonce (`apps/web/proxy.ts`, Q128) and serves the
static sandbox frame (`/sandbox/frame`); `apps/web/lib/server` holds just the two
modules behind them. A deploy without `NEXT_PUBLIC_AGENT_PY_URL` builds
and shows a "This deploy has no backend configured" screen (Q137).

What wave 13 removed: the in-Next API routes (`app/api/**`) and the
`lib/server` code behind them, the per-account chat-backend switch
(`ts`, `python`, `ts-service` — and the `in-next` dispatch), agent-ts
(the frozen TypeScript service, Q129), agent-py's `/v1/chat` route (the
AI SDK stream; chat is a run), and the Vercel Cron (`vercel.json`). A
later TypeScript backend would be another deploy URL, not a user
setting, and would start fresh against the contract's conformance suite
(`packages/contract/conformance/`).

## Background tasks — who executes them

**agent-py** executes `task_jobs` (`start` / `continue` / `respond`) for
every user unless an admin opts the user out
(`auth.users.raw_app_meta_data->>'agent_backend'` set to anything but
`'python'` — see `services/agent-py/README.md` § "Who executes tasks").
Its no-worker reconciler (`runs/reconcile.py`) fails a task no worker
started within `TASK_NO_WORKER_TIMEOUT_MINUTES` (default 10) with "No
task worker available".

Recurring runs (`task_schedules`) are enqueued by agent-py's dispatcher
(`scheduler.py`), on by default wherever its worker runs
(`WORKER_DRY_RUN=false` with `SUPABASE_DB_URL`; `SCHEDULER_ENABLED`
overrides, Q130); several replicas share it safely (a guarded
`next_run_at` claim fires each occurrence once). See
`services/agent-py/README.md` § "Scheduled tasks".

## Entry points — quick map

| Surface | agent-py |
|---|---|
| Chat + tasks (`/v1/runs`) | `routers/runs.py` (+ `runs/`: wiring, driver, repositories, event logs, AG-UI encoder + stream, native harness over `chat_loop.py`) |
| Task worker | `poller.py` → `executor.py` |
| Schedule dispatcher | `scheduler.py` |
| No-worker reconciler | `runs/reconcile.py` |
| Editor AI | `routers/editor_ai.py` (+ `editor_ai/`) |
| Models served | `routers/models.py` (`GET /v1/models`) |
| Summarize | `routers/summarize.py` |
| Extract | `routers/extract.py` (+ `extraction_vision.py`) |
| URL fetch | `routers/url.py` |
| MCP proxy + server save | `routers/mcp.py` |
| Refresh image URL | `routers/images.py` |
| Refresh file URL | `routers/files.py` |
| Extract table | `routers/extract_table.py` |
| Share create / revoke / public read | `routers/share.py` (data: `shares.py`) |
| Task schedules (CRUD) | `routers/schedules.py` |
| Embed file | `routers/embed.py` (+ `embeddings.py`, `chunk.py`) |
| Memory extract | `routers/memory.py` (+ `memory_extract.py`) |
| CSP reports | `routers/csp_report.py` (+ `csp_report.py`) |

(Paths under `services/agent-py/src/agent_py/`.) The wire shapes are the
spec-first contract's (`packages/contract/openapi.yaml`, run events in
`packages/contract/RUN_EVENTS.md`), with the browser's Zod schemas in
`apps/web/lib/shared/api-schemas.ts`.

The share pages read every share from agent-py's public `GET
/v1/share/{token}` in the browser (Q127). CSP reports go to agent-py's
`/v1/csp-report`: `apps/web/proxy.ts` points `report-uri` / `Reporting-Endpoints`
there (`/` → same-origin `/v1/csp-report`; an absolute URL →
`<base>/v1/csp-report`; `cspReportUri` in `apps/web/lib/server/security/csp.ts`);
with no agent-py URL the policy carries no `report-uri` (Q140). A
cross-origin agent-py needs the frontend's origin in
`CORS_ALLOWED_ORIGINS` (Reporting-API deliveries are CORS requests with
a preflight).

Ports of logic first written in TypeScript — the embedding chunker, the
memory prompt + merge, CSP report sanitising, the editor AI prompts, the
cron math — are pinned by golden files under
`services/agent-py/tests/fixtures/`, frozen since the TypeScript
originals were deleted (Q141): each names the commit it was generated
at. agent-py is now their source of truth; change the Python and its
golden file together.

## Model allowlist

One list governs the backend: `config/models.json`. agent-py (wave 10)
accepts every catalog id and serves each on its provider
(`agent_py/model_routes.py`). It speaks one wire format, Anthropic's
Messages API, to every provider: the Vercel AI Gateway
(`/v1/messages`), OpenRouter (`/api/v1/messages`), Ollama (≥ 0.14) and
Minimax (already `"type": "anthropic"`). The providers come from
`config/providers.json` and the variables it names; a model takes its
catalog `routes` in order, the first whose provider is configured,
except that an `anthropic/*` model goes to Anthropic directly when
`ANTHROPIC_API_KEY` is set (its `anthropicModelId`:
`anthropic/claude-sonnet-4.6` → `claude-sonnet-4-6`). A provider whose
URL is plain http, loopback or private is skipped with a warning unless
it is `allowInsecureBaseUrl` (Ollama). A catalog id without a configured
provider is still valid: its calls answer 503 (`unavailable` / `auth`).
`GET /v1/models` lists the ids that do run, and the browser's picker
offers those; with none it says so plainly (Q131). Anything outside the
catalog is `400 {"code": "unknown_model", "message"}`.

What a model can do follows the catalog's flags:

- `supportsStructuredOutput`: a forced tool call (structured output) runs
  on the model only when set; otherwise on `AGENT_DEFAULT_MODEL` — the
  editor's tool choice and its comment / table elements, memory
  extraction. (The wave-10 probe found Minimax answers a forced
  `tool_choice` in plain text.) `/v1/extract-table` takes the
  structured path when flagged, the lenient JSON text path otherwise.
- `supportsReasoningEffort`: thinking is sent only to these.
- `supportsTools: false`: chat only — no tools on runs, refused as a task
  (no catalog entry sets it today).
- `thinksUnprompted`: the model thinks before answering without being
  asked (MiniMax M2.7 / M3 / M3.1 Flash); ghost text gives it room.
- Images go to every model.
- OpenRouter `fallbacks` go as OpenRouter's `models` list.

Where it's enforced:

- **`/v1/runs`** — `forwardedProps.model` is optional (absent →
  `AGENT_DEFAULT_MODEL`); present, it must be a catalog id, checked
  before the run exists and before the provider check (`400
  unknown_model`, no row). A background run also refuses `auto` and a
  model without tools (Q55, Q117).
- **`/v1/summarize`** — `model` is optional; absent →
  `AGENT_DEFAULT_MODEL`, present → must be a catalog id.
- **Follow-up suggestions** — always `AGENT_DEFAULT_MODEL`, on its own
  provider's client.
- **Task executor** — `tasks.checkpoint.config.model` is re-checked
  before the run calls its provider. The checkpoint row is owner-writable
  under RLS, so a tampered id fails the run (`result: failed`, task
  `failed`) instead of reaching a model.
- **`/v1/extract-table`** — `model` is optional; absent
  → `AGENT_DEFAULT_MODEL`, present → must be a catalog id.
- **`/v1/memory/extract`** — no request model; the
  operator's `MEMORY_EXTRACT_MODEL` is used when it is a catalog id with
  structured output that a provider serves here, otherwise (and when
  unset) `AGENT_DEFAULT_MODEL`. Always the forced-tool structured path
  (as `generateObject`).
- `/v1/extract`, `/v1/url/fetch`, `/v1/embed` (its embedder is an
  OpenAI-compatible endpoint, `EMBEDDINGS_*` / `OLLAMA_*`, not a chat
  model), `/v1/csp-report`, MCP and image / file refresh take no model
  id.

Config:

- `AGENT_DEFAULT_MODEL` (default `anthropic/claude-haiku-4.5`,
  empty → default) — validated at boot: a value outside the allowlist
  stops the service from starting.
- `MODELS_CONFIG_PATH` (agent-py) — path to the catalog. Empty →
  searched upward from the package. agent-py's Docker image is built
  from the **repo root** (`docker build -f services/agent-py/Dockerfile .`,
  as `docker-compose.yml` does) and ships the file at
  `/app/config/models.json`.
  A missing or invalid catalog fails boot.

`VERIFY_MODEL` (agent-py's citation verifier) is an operator setting,
not request input, and is not checked against the allowlist.
