#!/bin/bash
# e2e-live/stack.sh <command...>: the real stack, then <command> against it.
#
# Throwaway Postgres + GoTrue + PostgREST (Supabase's own images), every
# migration, a stand-in for Kong (proxy.ts), the real agent-py with its
# worker, a production build of Next, a scripted Anthropic Messages server
# and an MCP server that counts effects (fakes.py). Nothing calls a real
# model unless LIVE_ANTHROPIC_KEY / LIVE_ANTHROPIC_URL say so (smoke.py).
# Starts and removes only its own containers and processes; never reads a
# .env. Ports: 54871 (Supabase), 3171 (Next), 8171 (agent-py), 8172/8173
# (fakes). See e2e-live/README.md.
set -uo pipefail
L=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$L/.." && pwd)
LOG="$ROOT/test-results/live"; mkdir -p "$LOG"
[ -e "$ROOT/.env" ] || [ -e "$ROOT/.env.local" ] && { echo "refusing: worktree has a .env"; exit 1; }
REG=public.ecr.aws/supabase
PW=$(openssl rand -hex 16); SECRET=$(openssl rand -hex 32); MCPKEY=$(openssl rand -base64 32)
PIDS=""; CS=""
cleanup(){ for p in $PIDS; do kill "$p" 2>/dev/null; done; for c in $CS; do docker rm -f -v "$c" >/dev/null 2>&1; done; echo "stack down"; }
trap cleanup EXIT
nap(){ perl -e 'select(undef,undef,undef,1)'; }
wait_http(){ for _ in $(seq 1 120); do curl -s -o /dev/null "$1" && return 0; nap; done; echo "not up: $1"; exit 1; }
DB=$(docker run -d --rm --pull missing -p 127.0.0.1::5432 -p 127.0.0.1::9999 -p 127.0.0.1::3000 -e POSTGRES_PASSWORD="$PW" $REG/postgres:17.12.0.000) || exit 1
CS="$DB"
port(){ docker port "$DB" "$1/tcp" | head -1 | sed 's/.*://'; }
q(){ local u=$1; shift; docker exec -i -e PGPASSWORD="$PW" "$DB" psql -h 127.0.0.1 -U "$u" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
ok=0; for _ in $(seq 1 120); do if q postgres -c 'select 1' >/dev/null 2>&1; then ok=$((ok+1)); [ $ok -ge 3 ] && break; else ok=0; fi; nap; done
q supabase_admin -c "alter role supabase_auth_admin with login password '$PW'" -c "alter role authenticator with login password '$PW'" || exit 1
AUTHC=$(docker run -d --rm --pull missing --network "container:$DB" \
 -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://127.0.0.1:54871/auth/v1 \
 -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$PW@127.0.0.1:5432/postgres" \
 -e GOTRUE_SITE_URL=http://127.0.0.1:3171 -e GOTRUE_JWT_SECRET="$SECRET" -e GOTRUE_JWT_AUD=authenticated \
 -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_EXP=3600 -e GOTRUE_DISABLE_SIGNUP=false \
 -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_RATE_LIMIT_HEADER=X-None \
 $REG/gotrue:v2.198.0) || exit 1
CS="$AUTHC $CS"
wait_http "http://127.0.0.1:$(port 9999)/health"
q supabase_admin <<'SQL'
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
grant usage on schema storage to postgres, anon, authenticated, service_role;
SQL
for f in "$ROOT"/supabase/migrations/[0-9]*.sql; do q postgres < "$f" >>"$LOG/migrations.log" 2>&1 || { echo "migration failed: $f"; exit 1; }; done
RESTC=$(docker run -d --rm --pull missing --network "container:$DB" \
 -e PGRST_DB_URI="postgres://authenticator:$PW@127.0.0.1:5432/postgres" -e PGRST_DB_SCHEMAS=public \
 -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$SECRET" $REG/postgrest:v16.5) || exit 1
CS="$RESTC $CS"
PY="$ROOT/services/agent-py/.venv/bin/python"
jwt(){ S="$SECRET" R="$1" "$PY" -c "import os,jwt,time;print(jwt.encode({'role':os.environ['R'],'iss':'supabase','exp':int(time.time())+86400},os.environ['S'],algorithm='HS256'))"; }
ANON=$(jwt anon); SVC=$(jwt service_role)
DSN="postgresql://postgres:$PW@127.0.0.1:$(port 5432)/postgres"
AUTH="http://127.0.0.1:$(port 9999)" REST="http://127.0.0.1:$(port 3000)" bun "$L/proxy.ts" > "$LOG/proxy.log" 2>&1 & PIDS="$PIDS $!"
"$PY" -B "$L/fakes.py" > "$LOG/fakes.log" 2>&1 & PIDS="$PIDS $!"
wait_http http://127.0.0.1:8172/state
( cd "$ROOT/services/agent-py" && exec env SUPABASE_URL=http://127.0.0.1:54871 SUPABASE_JWT_SECRET="$SECRET" SUPABASE_DB_URL="$DSN" \
 SUPABASE_SERVICE_ROLE_KEY="$SVC" ANTHROPIC_API_KEY="${LIVE_ANTHROPIC_KEY:-fake-key}" ANTHROPIC_BASE_URL="${LIVE_ANTHROPIC_URL-http://127.0.0.1:8172}" MINIMAX_CN_API_KEY=fake-minimax MINIMAX_CN_BASE_URL=http://127.0.0.1:8172/v1 WORKER_DRY_RUN=false \
 POLL_INTERVAL_SECONDS=0.2 SCHEDULER_ENABLED=true SCHEDULER_INTERVAL_SECONDS=2 MCP_ENCRYPTION_KEY="$MCPKEY" \
 MCP_ALLOW_PRIVATE_HOSTS=true CORS_ALLOWED_ORIGINS=http://127.0.0.1:3171 TRUSTED_PROXY_HOPS=0 RUNS_RATE_PER_MINUTE=1000 \
 "$PY" -B "$L/agent_live.py" ) > "$LOG/agent.log" 2>&1 & PIDS="$PIDS $!"
wait_http http://127.0.0.1:8171/healthz
NEXT_VARS=(NEXT_DIST_DIR=.next-e2e NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54871 NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON" \
 NEXT_PUBLIC_AGENT_PY_URL=http://127.0.0.1:8171 NEXT_PUBLIC_AGENT_TS_URL= NEXT_PUBLIC_API_BASE_URL= \
 SUPABASE_SERVICE_ROLE_KEY="$SVC" MCP_ENCRYPTION_KEY="$MCPKEY" MCP_ALLOW_PRIVATE_HOSTS=true AI_GATEWAY_API_KEY=fake-unused-key)
( cd "$ROOT" && env "${NEXT_VARS[@]}" bun run build ) > "$LOG/build.log" 2>&1 || { echo "next build failed"; tail -20 "$LOG/build.log"; exit 1; }
( cd "$ROOT" && exec env "${NEXT_VARS[@]}" node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3171 ) > "$LOG/next.log" 2>&1 & PIDS="$PIDS $!"
wait_http http://127.0.0.1:3171
export LIVE_SVC="$SVC" LIVE_DSN="$DSN" LIVE_ANON="$ANON" LIVE_MCPKEY="$MCPKEY" LIVE_PY="$PY" LIVE_ROOT="$ROOT"
"$@"
