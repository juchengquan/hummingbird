#!/usr/bin/env bash
# agent-py's Postgres tests against a throwaway database (Q54 of
# docs/PLAN-frontend-backend-split.md; CI job `agent-py-db`).
#
#   bun run test:db                                  # the whole agent-py suite
#   bun run test:db tests/test_runs_pg.py -k cancel  # pytest args
#   bun run test:db -- --exec <cmd> [args…]          # any command, with
#                                                    # AGENT_PY_TEST_DB_URL set
#
# Starts its own container on a random loopback port (safe to run several
# at once), applies every migration, failing on the first that doesn't,
# and removes the container on exit. Never reads or touches SUPABASE_DB_URL.
#
# The bare Postgres image lacks what the Storage and Auth services create
# at their first boot; the shims below are only what the migrations and
# tests use. Storage behaviour itself is not tested here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# supabase/config.toml major_version = 17. Pinned by digest (amd64 + arm64).
IMAGE="public.ecr.aws/supabase/postgres:17.12.0.000@sha256:8630950b489ecc70563300180287a98c192a4a48f5ae00b4febdaeea1abe85de"

command -v docker >/dev/null || { echo "test-db: Docker is required" >&2; exit 1; }

PASSWORD="$(openssl rand -hex 16)"
CID="$(docker run -d --rm -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$PASSWORD" "$IMAGE")"
trap 'docker rm -f -v "$CID" >/dev/null 2>&1 || true' EXIT

sql() {
  local user="$1"; shift
  docker exec -i -e PGPASSWORD="$PASSWORD" "$CID" \
    psql -h 127.0.0.1 -U "$user" -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

# The image restarts once while initialising: wait for three answers in a row.
ready=0
for _ in $(seq 1 120); do
  if sql postgres -c 'select 1' >/dev/null 2>&1; then
    ready=$((ready + 1))
    [ "$ready" -ge 3 ] && break
  else
    ready=0
  fi
  sleep 1
done
[ "$ready" -ge 3 ] || { echo "test-db: Postgres never became ready" >&2; exit 1; }

sql supabase_admin <<'SQL'
-- Storage service (0003_storage.sql needs these).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$ select (string_to_array(name, '/'))[1:cardinality(string_to_array(name, '/')) - 1] $$;
alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
grant usage on schema storage to postgres, anon, authenticated, service_role;

-- Auth service: its migrations make these read both claim GUC forms.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text
$$;
SQL

for file in "$ROOT"/supabase/migrations/[0-9]*.sql; do
  if ! output="$(sql postgres < "$file" 2>&1)"; then
    echo "test-db: migration failed: $(basename "$file")" >&2
    echo "$output" >&2
    exit 1
  fi
done

PORT="$(docker port "$CID" 5432/tcp | head -1 | sed 's/.*://')"
export AGENT_PY_TEST_DB_URL="postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres"
export SUPABASE_DB_URL=

[ "${1:-}" = "--" ] && shift
if [ "${1:-}" = "--exec" ]; then
  shift
  "$@"
else
  (cd "$ROOT/services/agent-py" && uv run pytest "$@")
fi
