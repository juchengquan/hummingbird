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
| `SUPABASE_URL` | No (reported by `/readyz`) | Phase 2 will use it for things beyond what `SUPABASE_DB_URL` already gives us. |
| `SERVICE_PORT` | No | Default 8000. |
| `CORS_ALLOWED_ORIGINS` | No | Default empty (no CORS). Comma-separated exact origins allowed to call the API from a browser on another origin, e.g. `http://localhost:3000` when Next calls agent-py on `:8000`. Not needed behind the same-origin proxy. `*` and non-origin values are ignored; credentialed CORS is never enabled (auth is a bearer JWT). |
| `TRUSTED_PROXY_HOPS` | No | Default `1`. How many reverse proxies in front of the service append to `X-Forwarded-For`; the rate-limit key is the entry this many places from the right. `0` ignores the header and keys on the socket peer. Pinned to `1` in `docker-compose.yml` (one Caddy hop). |
| `CLIENT_IP_HEADER` | No | Empty by default. A single-value header a trusted edge overwrites with the client IP (e.g. `cf-connecting-ip`); wins over `X-Forwarded-For` when present. Only set it if the edge overwrites it. Cleared in `docker-compose.yml`. |

A repo-level `.env` works — `pydantic-settings` looks for `.env` in the
current working directory. The service shares the same `.env` as the
Next.js app (same Supabase project, same vars).

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
