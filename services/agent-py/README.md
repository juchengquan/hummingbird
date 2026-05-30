# agent-py — Phase 0 (scaffolding)

Python implementation of the Hummingbird agent service. Phase 0 ships a
FastAPI app that boots, verifies Supabase JWTs, and exposes health and
auth-smoke-test endpoints. **No agent logic yet.**

See [`docs/PLAN-agent-api.md`](../../docs/PLAN-agent-api.md) for the full
phased plan. This README covers running and shipping Phase 0; later
phases will update it as they land.

## What's in Phase 0

- FastAPI app with `GET /healthz`, `GET /readyz`, `GET /v1/whoami`.
- Supabase JWT verification middleware (HS256 against `SUPABASE_JWT_SECRET`).
- Multi-stage Dockerfile (uv-based build, slim runtime, non-root user).
- pytest suite (8 tests covering health + every auth failure mode).
- Ruff + mypy configs.
- OpenAPI doc at `/openapi.json` — consumed by the Next.js side's TS
  codegen (`scripts/codegen-agent-types.sh`).

## What's NOT in Phase 0

- Any agent-loop logic (Phase 2).
- The `task_jobs` poller (Phase 1).
- Any tool implementations (Phase 2-3).
- MCP client (Phase 3).
- Production deploy config — the deploy target is deliberately TBD; see
  the "Deliberately deferred" section of `PLAN-agent-api.md`. Phase 0
  ships a Dockerfile that runs anywhere; Phase 1 picks the host.

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
# → {"status":"ok","checks":{"supabase_url_configured":false, ...}}
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
  agent-py
```

Or use the repo-level `docker-compose.yml` to spin up alongside the
Next.js dev server (see top-level `CLAUDE.md`).

## Run tests

```bash
uv run pytest               # all tests
uv run pytest -v            # verbose
uv run ruff check .         # lint
uv run mypy src             # type check
```

CI runs all four on every PR — see `.github/workflows/ci.yml` (job
`agent-py`).

## Configuration

| Env var | Required? | What it does |
|---|---|---|
| `SUPABASE_JWT_SECRET` | Yes for auth endpoints | The JWT secret from your Supabase project's API settings. Without it, every protected endpoint returns 503. |
| `SUPABASE_URL` | No (Phase 0) | Reported by `/readyz`. Phase 1 will use it to verify connectivity. |
| `SERVICE_PORT` | No | Default 8000. Honoured by the entry script. |

A repo-level `.env` works — `pydantic-settings` looks for `.env` in the
current working directory. To keep Phase 0 simple, the service shares
the same `.env` as the Next.js app (same Supabase project, same vars).

## What ships next (Phase 1)

Phase 1 adds a **read-only `task_jobs` poller** that claims jobs
alongside the TS worker but logs only — never executes. This proves
Postgres connectivity + RLS + the claim-race semantics safely. See
`PLAN-agent-api.md` for the full sequence.
