# agent-py — Phase 2a (executor pattern + feature flag)

Python implementation of the Hummingbird agent service.

- **Phase 0**: FastAPI scaffolding + JWT auth + OpenAPI codegen.
- **Phase 1**: read-only `task_jobs` poll loop in dry-run mode.
- **Phase 2a (this build)**: live mode + per-user feature flag +
  executor that drives the agent loop end-to-end. Step fn is a stub
  emitting a canned event stream — proves the executor pattern;
  real model + tools land in Phase 2b.

See [`docs/PLAN-agent-api.md`](../../docs/PLAN-agent-api.md) for the
full phased plan.

## What's in Phase 2a

- Everything from Phase 0+1 (health, readiness, auth, OpenAPI
  codegen, asyncpg pool, `claim_next_job` with SKIP LOCKED, dry-run
  release).
- **`events.py`** — TaskEvent IR (status / step_start / step_end /
  token / result), shaped to match `lib/shared/agent/events.ts` so
  rows from either producer flow through the same projection.
- **`emitter.py`** — RunEmitter with monotonic `seq`, settle-once
  semantics. A late callback past the terminal event is silently
  dropped.
- **`store.py`** — append_event (idempotent on `(task_id, seq)`),
  update_run (status / step / finished_at patch), set_task_handler
  (`metadata.handler = 'python'` for postmortem audit),
  is_run_cancelled (cheap probe between steps).
- **`runner.py`** — `run_agent_loop`: pure orchestration, RunStepFn
  injected. status → start_step → step → end_step → cancel-check →
  loop, or settle on done / max_steps.
- **`feature_flag.py`** — `python_executes_for_user` reads the
  per-user opt-out `auth.users.raw_app_meta_data->>'agent_backend'`
  (see "Who executes tasks" below). Defensive on every shape; a DB
  error returns "unknown" and the poller releases the job.
- **`executor.py`** — `execute_start(pool, payload)`: stamps handler,
  builds emitter with DB sink, runs the loop, updates task row to
  terminal, returns `ExecutorOutcome(settled, error)`.
- **Poller** extended: live mode (`WORKER_DRY_RUN=false`) → dispatch
  to the executor and `mark_job_done` / `mark_job_failed`, unless the
  user opted out (see "Who executes tasks" below) → the job and task
  are failed up front with a clear error.
- **Tests**: 62 total (+35 vs Phase 1) covering event IR / emitter
  invariants / runner control flow / feature-flag shapes / executor
  happy/cancel/error paths / poller dispatch decision tree.

## What's in Phase 1

- Everything from Phase 0 (health, readiness, auth smoke test, JWT
  middleware, Dockerfile, OpenAPI codegen).
- **`db.py`** — asyncpg pool lifecycle. Pool opens on app startup
  when `SUPABASE_DB_URL` is set; closes on shutdown.
- **`jobs.py`** — single-statement `claim_next_job` using `FOR UPDATE
  SKIP LOCKED`. `release_job_to_queue` returns claimed-in-dry-run jobs
  to the ready set so the TS worker picks them up.
- **`poller.py`** — async tick loop owned by the FastAPI lifespan.
  Claim → log → release. Survives transient errors. Cancellation
  propagates cleanly on shutdown.
- **`/readyz`** now reports `supabase_db_configured` + `db_pool_open`.
- pytest suite up to 27 tests (Phase 0's 10 + 17 new for db/jobs/poller).

## What's NOT in Phase 2a

- The real model call. The step fn is a stub. **Phase 2b** swaps it
  for an Anthropic SDK call streaming through the runner.
- Tool implementations. Phase 2b adds webFetch / webSearch /
  searchFiles.
- `continue` / `respond` actions. Phase 3 handles HITL pause/resume.
- MCP client. Phase 3.
- Checkpoint reads + writes (`save_checkpoint` / `load_checkpoint`).
  Phase 3 lands them alongside `continue`.
- A real `SELECT 1` reachability check on `/readyz`. Phase 2b if false
  positives surface; today `db_pool_open` is the closest proxy.

## Run locally

Requires Python 3.12+ and [uv](https://github.com/astral-sh/uv).

```bash
cd services/agent-py
uv sync                     # resolve + install (creates .venv)
uv run uvicorn agent_py.main:app --reload --port 8000
```

Then:

```bash
curl localhost:8000/healthz
# → {"status":"ok","service":"agent-py","version":"0.1.0"}

curl localhost:8000/readyz
# → {"status":"ok","checks":{
#       "supabase_url_configured":false,
#       "supabase_db_configured":false,
#       "jwt_secret_configured":false,
#       "db_pool_open":false}}
```

With `SUPABASE_DB_URL` set, startup logs show the poller starting:

```
lifespan.poller.started interval=5.0 dry_run=True
```

Whenever a `task_jobs` row goes ready, the poller logs:

```
poller.claimed       job_id=… task_id=… user_id=… action=continue attempts=1
poller.released      job_id=… released=True reason=dry_run
```

To exercise auth, set `SUPABASE_JWT_SECRET` and mint a test token (any
HS256 signer works — the secret is shared with Supabase's `auth.users`
JWT signer in production).

## Run via Docker

```bash
# Context is the repo root: the image ships config/models.json (the model allowlist).
docker build -f services/agent-py/Dockerfile -t agent-py .
docker run -p 8000:8000 \
  -e SUPABASE_URL=https://your.supabase.co \
  -e SUPABASE_JWT_SECRET=your-jwt-secret \
  -e SUPABASE_DB_URL=postgresql://... \
  agent-py
```

Or use the repo-level `docker-compose.yml` to spin up alongside the
Next.js dev server (see top-level `CLAUDE.md`).

### Behind the same-origin proxy

`docker compose up proxy agent-py` also starts a Caddy reverse proxy
on <http://localhost:8080> (`.docker/proxy/Caddyfile`): `/v1/*`,
`/healthz` and `/readyz` reach this service, everything else reaches
the Next dev server on the host. Set `NEXT_PUBLIC_AGENT_PY_URL=/` so
the browser calls `/v1/...` on that origin
(`docs/PLAN-frontend-backend-split.md` Q21).

```bash
curl localhost:8080/healthz   # → this service, via the proxy
```

- **Client IP.** The per-IP rate limits (`rate_limit.py`) key on the
  `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` places from the right.
  Caddy discards any client-sent `X-Forwarded-For` and sets it to the
  peer it saw, so there is exactly one trusted hop; the compose file
  pins `TRUSTED_PROXY_HOPS=1` and clears `CLIENT_IP_HEADER` (Caddy
  passes arbitrary headers through, so a platform header would be
  client-controlled). A deployment with more proxies in front (a CDN
  plus Caddy, say) raises the hop count to match.
- **CORS.** None needed and none configured: the browser sees one
  origin. The bearer JWT still goes on every request, so moving the
  service to its own origin later is a configuration change.
- **SSE.** The proxy flushes every chunk (`flush_interval -1`) and does
  not compress, so `/v1/chat` and task event streams arrive unbuffered.

## Error responses

Every non-streaming error is the flat envelope the frontend and the
contract (`packages/contract/openapi.yaml`, `ApiError`) expect — never
FastAPI's default `{"detail": ...}`:

```jsonc
{ "code": "auth", "message": "Invalid token." }                 // 401
{ "code": "invalid_request", "message": "body.storagePath: Field required",
  "issues": [{ "loc": ["body", "storagePath"], "msg": "Field required", "type": "missing" }] } // 422
```

The exception handlers live in `src/agent_py/error_envelope.py`
(installed by `create_app()`); status codes and exception headers
(`WWW-Authenticate`, `Retry-After`) pass through unchanged.

- **Raise** `HTTPException(status_code=..., detail={"code": ..., "message": ...})`
  — the dict is returned flat; extra keys (`reason`, `status`, ...) are
  kept. Prefer this: pick the `code` the matching Next.js route uses.
- A **string** `detail` still works: its `code` comes from the status
  table `STATUS_CODES` in `error_envelope.py` (400/422 `invalid_request`,
  401 `auth`, 403 `forbidden`, 404 `not_found`, 405
  `method_not_allowed`, 408/504 `timeout`, 409 `conflict`, 413
  `payload_too_large`, 415 `unsupported_content_type`, 429 `rate_limit`,
  500 `unknown`, 502 `provider`, 503 `unavailable`; any other 4xx
  `invalid_request`, any other 5xx `unknown`).
- **Request validation** keeps FastAPI's 422, as `invalid_request` with
  the problems in `issues` (`loc` / `msg` / `type` only — the caller's
  input is not echoed).
- An **uncaught exception** is a 500 `{"code": "unknown", "message":
  "Internal server error."}`; the exception is logged, not echoed.
- Hand-built responses (the body-size middleware's 413 / 400) use
  `error_body(code, message)` from the same module.

SSE in-stream `error` events on `/v1/chat` are a separate protocol
(`docs/API.md`) and are unaffected.

## Run tests

```bash
uv run pytest               # all tests
uv run pytest -v            # verbose
uv run ruff check .         # lint
uv run ruff format --check . # format
uv run mypy src             # type check
```

CI runs all four on every PR — see `.github/workflows/ci.yml` (job
`agent-py`).

## Share links (`/v1/share`)

`routers/share.py` (HTTP) + `shares.py` (SQL) — the Python side of
sharing, mirroring the Next.js routes and `lib/server/share/resolve.ts`.
Contract: the `sharing` operations in `packages/contract/openapi.yaml`.

| Operation | Auth | What |
|---|---|---|
| `POST /v1/share` | bearer | Body `{kind: "conversation", conversationId}` or `{kind: "document", documentId}` → `{token, kind}`. Ownership check + insert in one transaction under the caller's RLS (`store._set_user_context`). Token: 16 random bytes, base64url, 22 chars (same as Next). Foreign / missing target → 404; body cap 16 KiB. |
| `DELETE /v1/share/{token}` | bearer | Stamps `revoked_at` under the caller's RLS → `{ok: true}`; another user's token and an unknown one are the same 404. |
| `GET /v1/share/{token}` | **none** | What the share pages render (`ResolvedShare`: title, messages or document body, `createdAt` — no user ids). Reads with the pool's own role (the service-role equivalent), filtering every target read by the share creator's `user_id`. Unknown, revoked, foreign-target, no-DB and read errors are all the same 404 `not_found`. Rate limited: 60 / minute / client IP (in-process). At most 1000 messages (PostgREST's default `max_rows`, which bounds the Next.js resolver). |

All three need `SUPABASE_DB_URL`; without it create / revoke answer 503
and the public read answers 404 (as the Next.js page does without the
service-role key).

## Runs (`/v1/runs`)

The runs API of [`docs/PLAN-frontend-backend-split.md`](../../docs/PLAN-frontend-backend-split.md)
Phase 2 — contract: the `runs` operations in
`packages/contract/openapi.yaml`, events per `packages/contract/RUN_EVENTS.md`.
`routers/runs.py` (HTTP) reads every service from `runs/wiring.py` (the
wiring seam: stores, event logs, encoder, harness, stream, driver).

| Operation | Auth | What |
|---|---|---|
| `POST /v1/runs` | bearer or none | Body: AG-UI `RunAgentInput`, options in `forwardedProps`. Interactive (default) → `200` SSE, executed in this process by `runs/driver.py`; background → `202 {runId, status}`: `create_run` + `status: queued` (seq 1) + `enqueue_task_job('start')`, then the poller runs it. Client-minted `runId`: the owner's repeat (same thread + mode) replays; any other use of a taken id → `409 run_id_conflict`. `resume[]` must answer exactly the open interrupts of `forwardedProps.previousRunId` (else `409 invalid_state`); one live resume per interrupted run (0042 — a second is `409 run_already_resumed` until the first fails or is cancelled). Anonymous: interactive only, `X-Run-Token` in the response. |
| `GET /v1/runs` | bearer | The caller's runs, newest first, `threadId` / repeated `status` / `parentRunId` / `mode` filters, keyset token paging. |
| `GET /v1/runs/{id}` | bearer or `X-Run-Token` | The `Run` resource. Missing / foreign / wrong token → the same 404. |
| `GET /v1/runs/{id}/events` | bearer or `X-Run-Token` | Replay after `after` / `Last-Event-ID`, then live, then the closing event (from the row). Malformed or out-of-range cursor → 400. |
| `POST /v1/runs/{id}/cancel` | bearer or `X-Run-Token` | Idempotent; returns the run as it now stands. |

**Where runs live.** Signed-in runs are `tasks` rows (migration 0041,
`runs/repository_pg.py`: owner-scoped calls run as the user under RLS,
system writes as the DSN role). Anonymous runs — and signed-in runs when
`SUPABASE_DB_URL` is unset — live in memory (`runs/repository_memory.py`)
until `RUNS_MEMORY_TTL_SECONDS` after they end, then 404. Without a
database, background runs answer `503 unavailable` ("Supabase is not
configured."), like the schedules routes; interactive runs still work.

**Interactive execution (Q28).** The driver runs the harness detached
from the request (a dropped connection does not stop the run; the
stream is a reader of the run's event log, so a retry or a rejoin gets
exactly the same events). It heartbeats the run's lease every
`RUNS_HEARTBEAT_SECONDS`; a heartbeat finding the row no longer live
(cancelled through another replica, or reaped) stops the harness — the
cross-process cancel path. A cancel served by this process reaches the
run at once. The maintenance loop (every `RUNS_REAPER_INTERVAL_SECONDS`)
fails interactive runs whose lease lapsed (`worker_lost` — never handed
to another process) and drops expired in-memory runs. Shutdown fails
this process's live runs as `worker_lost`.

**Anonymous runs (Q16/Q20).** `X-Run-Token` (192 random bits; only its
SHA-256 is kept) is the run's only credential, accepted by status,
rejoin and cancel; `startRun` uses a presented token only to recognise a
retry of its run or a resume of its interrupted run. `REQUIRE_AUTH_FOR_AI`
refuses anonymous starts with `401 auth_required`. Per-IP limits:
`RUNS_RATE_PER_MINUTE` (everyone) plus `RUNS_ANONYMOUS_RATE_PER_MINUTE`,
`RUNS_ANONYMOUS_DAILY_BUDGET` and `RUNS_ANONYMOUS_MAX_CONCURRENT` →
`429 rate_limit`.

**What runs wire to** (`runs/wiring.py`, one instance of each per
process). Event logs: `runs/event_log_pg.py` over `task_events` for
signed-in runs with a database, `runs/event_log_memory.py` (TTL'd,
capped — a run past a cap fails `limit_reached`) otherwise. Streams:
`runs/stream.py` with the AG-UI encoder of `runs/agui_encoder.py`; a
stream pulls its first frame before answering, so a cursor beyond the
log is `400` before any byte is sent. The driver emits through
`runs/coalescer.py` (text deltas merged before they get a seq). The
harness is `runs/native_harness.py` — today's chat loop
(`chat_loop.py`) as an adapter, AG-UI history → model input by
`runs/history.py` — or the model-free stub under `RUNS_STUB_HARNESS`.
An interrupted run stores its harness checkpoint with its outcome
(`tasks.checkpoint` / memory); the run that resumes it reads it as its
own owner and continues the turn with the full tool results. Unknown
`forwardedProps.model` → `400 unknown_model` before any row exists.
`forwardedProps` are parsed by `runs/options.py` (`RunOptions`; the
contract-0.4.0 options are typed there but not acted on until wave 5b),
and local MCP credentials are taken out of `state["hummingbird.localMcp"]`
into `RunInput.local_mcp_credentials` (`runs/credentials.py`: memory
only, never stored or logged). The native harness is assembled from
hooks — system prompt sections, tool contributors, taint seeds, the
model resolver, the post-success step (`runs/hook_types.py`), registered
in `runs/harness_hooks.py` — and every tool call gets the run-scoped
`RunToolContext` (client key, per-IP budget, `localFilesOnly`), anonymous
runs included. The citation verifier client is `verify_client.py`. The
maintenance loop also runs `runs/compaction.py`'s retention sweep every
10 min when a database is configured (compact ended interactive logs
after 24 h, purge them — and the run's stored checkpoint — after 30
days; background logs and checkpoints untouched).

## Configuration

| Env var | Required? | What it does |
|---|---|---|
| `SUPABASE_JWT_SECRET` | Yes for auth endpoints | The JWT secret from your Supabase project's API settings. Without it, every protected endpoint returns 503. |
| `SUPABASE_DB_URL` | Yes to enable the poller | Direct Postgres connection string. Must be the **direct** connection (`db.<project>.supabase.co:5432`), NOT the pooler (`*.pooler.supabase.com:6543`) — `FOR UPDATE SKIP LOCKED` needs an open transaction. Empty → poller no-ops. |
| `WORKER_DRY_RUN` | No | Default `true` (claim + log + release only). Set `false` in every deployment that should run tasks — agent-py is the only executor. |
| `POLL_INTERVAL_SECONDS` | No | Default `5.0`. |
| `JOB_LEASE_SECONDS` | No | Default `120`. Lease a claim holds on a `task_jobs` row (`lease_expires_at`, migration 0032). A job whose worker died is reclaimed once it lapses (or reaped as failed, with its task, once `max_attempts` is spent). |
| `JOB_HEARTBEAT_SECONDS` | No | Default `30` (clamped to a third of the lease). How often an executing job extends its lease. |
| `SHUTDOWN_GRACE_SECONDS` | No | Default `8`. On shutdown the in-flight job may finish within this window; after it, the job is cancelled and handed back (lease expired on the spot) for the next worker. Keep it under the container stop timeout (Docker's default is 10 s). The stop starts on SIGTERM itself (the server's signal handler is chained), not after uvicorn has drained open SSE streams; the image also runs uvicorn with `--timeout-graceful-shutdown 8` so the lifespan (which closes the DB pool) isn't held past the stop timeout by a chat stream. `/readyz` reports `poller_alive` / `poller_last_tick_age_seconds` and turns `status: degraded` if the loop died. |
| `SCHEDULER_ENABLED` | No | Default `false`. Run the schedule dispatcher loop (`scheduler.py`) in this process: it fires due `task_schedules` rows exactly like the Vercel Cron's `/api/tasks/jobs/tick`. Needs `SUPABASE_DB_URL`. Safe alongside that cron and on several replicas — see [Scheduled tasks](#scheduled-tasks-replacing-the-vercel-cron). `/readyz` reports `scheduler_alive` / `scheduler_last_tick_age_seconds` and turns `status: degraded` if the loop died. |
| `SCHEDULER_INTERVAL_SECONDS` | No | Default `60` (the Vercel Cron's cadence). Seconds between dispatcher ticks. |
| `REQUIRE_AUTH_FOR_AI` | No | Default off. `true` / `1` (with `SUPABASE_JWT_SECRET` set) refuses anonymous runs with `401 auth_required`. Strict values (`true` / `false` / `1` / `0`); anything else fails anonymous starts with 500 — never silently open. Same variable as the Next.js routes. |
| `RUNS_STUB_HARNESS` | No | Default `false` (runs use the native harness and `ANTHROPIC_API_KEY`; without a key every run fails `unavailable`). `true` runs every run on the model-free stub (`runs/stub_harness.py`, steered by `forwardedProps.conformance`) — for the contract conformance suite only. |
| `RUNS_LEASE_SECONDS` / `RUNS_HEARTBEAT_SECONDS` | No | Defaults `60` / `5`. An executing interactive run's lease and how often it is extended (also the latency of a cancel served by another replica). |
| `RUNS_REAPER_INTERVAL_SECONDS` | No | Default `15`. Runs maintenance loop: reap lapsed interactive runs, drop expired in-memory runs and their logs (the Postgres retention sweep runs every 10 min regardless). |
| `RUNS_MEMORY_TTL_SECONDS` / `RUNS_MEMORY_MAX_RUNS` | No | Defaults `900` / `2000`. How long an in-memory run is kept after it ends; how many runs memory holds at once (past it, starts answer 503). |
| `RUNS_RATE_PER_MINUTE` | No | Default `30`. Run starts per client IP per minute, every caller. |
| `RUNS_ANONYMOUS_RATE_PER_MINUTE` / `RUNS_ANONYMOUS_DAILY_BUDGET` / `RUNS_ANONYMOUS_MAX_CONCURRENT` | No | Defaults `10` / `200` / `3`. Anonymous starts per IP per minute, per rolling 24 h, and live anonymous runs per IP. |
| `MINIMAX_IMAGE_RATE_LIMIT_PER_MINUTE` | No | Default `5`. Per-IP `generateImage` calls per minute on interactive runs (signed in or not, keyed on the client IP), refused with the Next route's text past it. Same variable and parsing as the Next chat route: not a positive number → `5`, floored, capped at `60`. |
| `WEB_TOOL_RATE_LIMIT_PER_MINUTE` | No | Default `20` (the Next chat route's fixed window). Per-IP webSearch + webFetch + searchFiles calls per minute on interactive runs, one shared window. |
| `SUPABASE_URL` | No (reported by `/readyz`) | Phase 2 will use it for things beyond what `SUPABASE_DB_URL` already gives us. |
| `SERVICE_PORT` | No | Default 8000. |
| `CORS_ALLOWED_ORIGINS` | No | Default empty (no CORS). Comma-separated exact origins allowed to call the API from a browser on another origin, e.g. `http://localhost:3000` when Next calls agent-py on `:8000`. Not needed behind the same-origin proxy. `*` and non-origin values are ignored; credentialed CORS is never enabled (auth is a bearer JWT). |
| `TRUSTED_PROXY_HOPS` | No | Default `1`. How many reverse proxies in front of the service append to `X-Forwarded-For`; the rate-limit key is the entry this many places from the right. `0` ignores the header and keys on the socket peer. Pinned to `1` in `docker-compose.yml` (one Caddy hop). |
| `CLIENT_IP_HEADER` | No | Empty by default. A single-value header a trusted edge overwrites with the client IP (e.g. `cf-connecting-ip`); wins over `X-Forwarded-For` when present. Only set it if the edge overwrites it. Cleared in `docker-compose.yml`. |
| `EMBEDDINGS_BASE_URL` | No | OpenAI-compatible embedder for `/v1/embed` (`<base>/embeddings`, e.g. `http://localhost:11434/v1`). Same var, precedence and defaults as the Next.js provider. Neither this nor `OLLAMA_BASE_URL` set → embedding is off (`/v1/embed` answers `skipped / not_configured`). Operator config, so it is called without the SSRF guard (a localhost Ollama works). |
| `EMBEDDINGS_API_KEY` | No | Bearer key for `EMBEDDINGS_BASE_URL`; empty → `OLLAMA_API_KEY` → a placeholder (Ollama ignores auth). |
| `EMBEDDINGS_MODEL` | No | Default `nomic-embed-text` (768-dim, matching `file_sections.embedding vector(768)`). |
| `OLLAMA_BASE_URL` / `OLLAMA_API_KEY` | No | Fallback embedder when `EMBEDDINGS_BASE_URL` is unset — the same Ollama host the Next.js app uses. |
| `MEMORY_EXTRACT_MODEL` | No | Catalog id for `/v1/memory/extract`. Used only when it is an allowed `anthropic/*` entry of `config/models.json`; otherwise (or empty — the Next.js default is `google/gemini-2.5-flash`) `AGENT_DEFAULT_MODEL`. Needs `ANTHROPIC_API_KEY`; without it extraction is skipped (still `{ok: true}`). |

A repo-level `.env` works — `pydantic-settings` looks for `.env` in the
current working directory. The service shares the same `.env` as the
Next.js app (same Supabase project, same vars).

## Scheduled tasks (replacing the Vercel Cron)

Recurring runs live in `task_schedules` (a task spec + a cron expression
+ an IANA timezone). agent-py serves their CRUD at
`/v1/tasks/schedules[/{id}]` (`routers/schedules.py`, the contract's
`schedules` tag) and can run the dispatcher that fires them
(`scheduler.py` → `schedules.dispatch_due_schedules`), replacing the
Vercel Cron that calls `/api/tasks/jobs/tick` every minute
(`docs/PLAN-frontend-backend-split.md`, Q9).

- **CRUD runs as the caller.** Each query runs in a transaction after
  `SET LOCAL ROLE authenticated` + `request.jwt.claims`
  (`store._set_user_context`), so RLS, 0031's workspace-ownership check
  (→ 403), and 0035's column grants and guard trigger (coarse cron floor,
  20 enabled schedules per user → 409 `limit_reached`) apply exactly as
  they do to the Next routes' PostgREST calls.
- **Same cron semantics as the TS side.** `cron.py` is a port of
  cron-parser 5.5.0 + the luxon date math it uses — DST quirks
  included — because both backends write and fire the same rows.
  `tests/test_cron_parity.py` replays ~1950 cases computed by the TS
  functions (`lib/server/agent/schedules.parity.test.ts`, which fails if
  the committed fixture drifts from cron-parser). Not comparable, by
  nature: `H` (hashed) fields are random per parse on both sides; zones
  resolve through `zoneinfo` (tzdata, case-insensitive like ICU), so a
  name only ICU still knows (e.g. `US/Pacific-New`) is rejected here.
- **Same dispatch as the TS tick.** Up to 500 due rows (earliest
  `next_run_at` first), a fair batch of at most 50 fires per tick and 5
  per user, a 4-minute minimum gap since the last fire (deferred, not
  fired), invalid cron/timezone → the row is disabled, and every fire is
  claimed first with a guarded `UPDATE … WHERE next_run_at = <value
  read>`. A fire writes what `fireSchedule` writes — conversation
  (`Scheduled: <name>`), queued task + checkpoint, `status: queued`
  event, `start` job, `last_run_task_id` — in one transaction (the TS
  path writes them one by one, so a failure there can leave a partial
  run).

**Switching from the Vercel Cron.** Both dispatchers can run at the same
time: the guarded claim lets exactly one of them fire each occurrence
(tested with concurrent dispatchers against Postgres, including the TS
dispatcher racing this one).

1. Set `SCHEDULER_ENABLED=true` (with `SUPABASE_DB_URL`) on one or more
   agent-py instances and deploy. Look for `lifespan.scheduler.started`,
   then `scheduler.fired` as schedules come due; `/readyz` shows
   `scheduler_alive: true`.
2. Remove the `/api/tasks/jobs/tick` entry from `vercel.json`'s `crons`
   (and, once nothing calls the route, `CRON_SECRET`). Until then the
   two simply share the work.

## Crash recovery and side-effecting tools

A reclaimed job resumes from the task's checkpoint behind a
`status: running` marker carrying `resumedFromSeq` (see `poller.
reclaim_decision`). Two guards keep a resume from repeating or skipping
work (`tool_ledger.py`):

- **Side-effecting tools never run twice.** Every MCP tool
  (`ToolDescriptor.side_effecting`) and every approval-gated tool is
  bracketed by an execution record in the checkpoint
  (`inflight_tools`), saved before it runs and again once its result is
  in. A reclaim that finds a tool started but unfinished does not re-run
  it: the model gets an "interrupted, outcome unknown" tool result and
  can verify or ask. Built-in tools are read-only and simply re-run.
- **Unanswered gated calls pause again.** A checkpoint saved on a
  suspend whose task never reached `paused` re-emits the approval /
  input request + `status: paused` and pauses the task.

## Phase 1 verification (production observation)

After Phase 1 deploys:

1. Watch the service logs for `lifespan.poller.started`. Confirms the
   pool opened and the loop is running.
2. With light task traffic, observe `poller.claimed` / `poller.released`
   pairs. Each claim is followed within ~milliseconds by a release.
3. Check `task_jobs` in Postgres — no rows stuck in `running` after
   the release (the release sets `status='queued'`, clears
   `started_at`).
4. Check that `attempts` ticks up for jobs Python claims twice in a
   row before the TS worker picks them up. Expected at the rate
   `~POLL_INTERVAL_SECONDS / TS-worker-tick` (today's TS cron is 1 min,
   so Phase 1 should win the race roughly 1-in-N times where N is the
   cron-to-Python ratio).

## Who executes tasks — the opt-out flag

agent-py executes **every** user's tasks (`start`, `continue`,
`respond`) once `WORKER_DRY_RUN=false`. Nothing else does: agent-ts has
no executor (its poller is off unless `AGENT_TS_POLLER_ENABLED`) and
the Next.js app runs no worker. So the per-user flag
`auth.users.raw_app_meta_data->>'agent_backend'` is an **opt-out**
(`feature_flag.python_executes_for_user`):

| `agent_backend` | Python |
|---|---|
| absent / `null` / `'python'` | executes |
| anything else (`'off'`, `'none'`, `'ts'`, …) | releases the job — nothing runs it |
| lookup failed (DB blip) | releases; retried after the release backoff |

It is `app_metadata`, not `user_metadata`, on purpose: users can write
their own `user_metadata` via `supabase.auth.updateUser`, but only the
service role can write `app_metadata`.

```sql
-- opt a user out
UPDATE auth.users
SET raw_app_meta_data =
    COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"agent_backend":"off"}'::jsonb
WHERE id = '<user-uuid>';

-- undo
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data - 'agent_backend'
WHERE id = '<user-uuid>';
```

The poller reads the flag on every claim; no restart needed.

**Opted-out users.** Nothing else executes their jobs, so the poller
fails the job (fenced on the claim's attempts) and settles the task
failed with "Background tasks are disabled for this account…" instead
of releasing it — a release would be re-claimed forever.

**Safety net.** A task no worker ever starts (agent-py down or still in
dry-run) would otherwise sit `queued` forever: a dry-run release refunds
the claim's attempt, so its job always looks claimable. The Next.js
stale-run reconciler (`reconcileStaleRuns` in
`lib/server/agent/store.ts`, run by `/api/tasks/sweep` and the task
stream) fails a task that is still `queued`, has no event past the
route's `status: queued` marker, is older than
`TASK_NO_WORKER_TIMEOUT_MINUTES` (default 10), has no job under a live
lease, AND no worker has executed anything in that window
(`task_worker_active_within`, migration 0040) — with "No task worker
available…". A busy worker's backlog keeps waiting. A job claimed later
for a task that is already terminal is settled done without running.

## What ships next (Phase 2b)

The **real model + tools**: a step fn that calls the Anthropic SDK
(streaming + tool use), the tool registry shape, and at minimum the
`webFetch` tool. The runner control flow doesn't change — only the
default `make_step_fn` factory swaps. The dispatch path in the
poller stays exactly as it is today.
