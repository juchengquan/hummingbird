#!/bin/bash
# Apply every SQL file under supabase/migrations/ to the docker-compose
# Postgres instance, in lexical order. Idempotent insofar as the
# migrations themselves are (the schema files use `drop ... cascade` /
# `on conflict do nothing` patterns).
#
# Run this once after the first `docker compose up -d`. To re-apply
# from scratch, tear down with `-v` first to wipe the volume.
#
# Usage:
#   bash .docker/supabase/apply-migrations.sh

set -euo pipefail

CONTAINER="${SUPABASE_DB_CONTAINER:-hummingbird-supabase-db-1}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-supabase/migrations}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "❌ Postgres container '${CONTAINER}' is not running."
  echo "   Run: docker compose -f docker-compose.supabase.yml up -d"
  exit 1
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ Migrations dir not found: $MIGRATIONS_DIR"
  exit 1
fi

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "No .sql files in $MIGRATIONS_DIR — nothing to apply."
  exit 0
fi

echo "Applying ${#files[@]} migration(s) to ${CONTAINER}…"
for f in "${files[@]}"; do
  echo ""
  echo "▶ $(basename "$f")"
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f"
done

echo ""
echo "✅ Migrations applied. Open Studio: http://localhost:54323"
