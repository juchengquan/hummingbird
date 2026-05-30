# agent-py — Phase 1 (read-only queue replica)

Python implementation of the Hummingbird agent service. **Phase 0**
shipped the FastAPI scaffolding + JWT auth + OpenAPI codegen.
**Phase 1** adds a background poll loop that claims `task_jobs`
alongside the TS worker — in dry-run mode: log + release, never
execute.

See [`docs/PLAN-agent-api.md`](../../docs/PLAN-agent-api.md) for the
full phased plan.

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

## What's NOT in Phase 1

- Any agent-loop logic (Phase 2).
- Tool implementations (Phase 2-3).
- MCP client (Phase 3).
- Event writes / checkpoint reads (Phase 2).
- A real `SELECT 1` reachability check (Phase 2 if false positives show
  up; today `db_pool_open` is the closest proxy).

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
docker build -t agent-py services/agent-py
docker run -p 8000:8000 \
  -e SUPABASE_URL=https://your.supabase.co \
  -e SUPABASE_JWT_SECRET=your-jwt-secret \
  -e SUPABASE_DB_URL=postgresql://... \
  agent-py
```

Or use the repo-level `docker-compose.yml` to spin up alongside the
Next.js dev server (see top-level `CLAUDE.md`).

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

## Configuration

| Env var | Required? | What it does |
|---|---|---|
| `SUPABASE_JWT_SECRET` | Yes for auth endpoints | The JWT secret from your Supabase project's API settings. Without it, every protected endpoint returns 503. |
| `SUPABASE_DB_URL` | Yes to enable the poller | Direct Postgres connection string. Must be the **direct** connection (`db.<project>.supabase.co:5432`), NOT the pooler (`*.pooler.supabase.com:6543`) — `FOR UPDATE SKIP LOCKED` needs an open transaction. Empty → poller no-ops. |
| `WORKER_DRY_RUN` | No | Default `true` (Phase 1). Set `false` only in Phase 2+ once the executor branch lands. |
| `POLL_INTERVAL_SECONDS` | No | Default `5.0`. |
| `SUPABASE_URL` | No (reported by `/readyz`) | Phase 2 will use it for things beyond what `SUPABASE_DB_URL` already gives us. |
| `SERVICE_PORT` | No | Default 8000. |

A repo-level `.env` works — `pydantic-settings` looks for `.env` in the
current working directory. The service shares the same `.env` as the
Next.js app (same Supabase project, same vars).

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

## What ships next (Phase 2)

Phase 2 lands the **executor branch**: when `WORKER_DRY_RUN=false`,
Python actually runs the `start` action end-to-end against a small
tool set (webSearch / webFetch / searchFiles). The release path goes
away — a claim either completes (`mark_job_done`) or fails
(`mark_job_failed`). See `PLAN-agent-api.md` for the full sequence.
