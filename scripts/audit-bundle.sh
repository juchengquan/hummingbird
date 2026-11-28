#!/bin/bash
# Bundle audit — scan the production client chunks for any string that
# would indicate server-only code or secrets leaked into a browser bundle.
#
# Runs after `bun run build`. Failing this means a `server-only` fence was
# bypassed or a module was mis-categorised. Treat any hit as a release
# blocker.
#
# Usage:
#   bun run build && bash scripts/audit-bundle.sh
#
# `bun run audit:bundle` first runs `scripts/check-next-env.ts` (Next's
# code reads no server variable), the other half of the secrets check.
#
# AUDIT_CHUNKS_DIR overrides the directory scanned (the mutation check
# points it at a copy).

set -uo pipefail

CHUNKS_DIR="${AUDIT_CHUNKS_DIR:-.next/static/chunks}"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "no $CHUNKS_DIR — run \`bun run build\` first" >&2
  exit 1
fi

# Strings that must never appear in a client chunk. We check for env-var
# *names* (not values — values are runtime-only and never in source) and
# for server-only import paths.
#
# Every server secret's name is here, `AI_GATEWAY_API_KEY` included, with
# no exemptions (PLAN-frontend-backend-split Q133 / Q143): Next holds no
# secret, so a name in the bundle means client code (or a package it
# imports) talks about a key the browser can never have. A package that
# bundles one loses its client import. `CODE_SANDBOX_` is a prefix:
# none of the sandbox's variables belong in the browser.
NEEDLES=(
  "AI_GATEWAY_API_KEY"
  "ANTHROPIC_API_KEY"
  "OPENROUTER_API_KEY"
  "MINIMAX_CN_API_KEY"
  "OLLAMA_API_KEY"
  "EMBEDDINGS_API_KEY"
  "GOOGLE_API_KEY"
  "SUPABASE_SERVICE_ROLE_KEY"
  "SUPABASE_JWT_SECRET"
  "SUPABASE_DB_URL"
  "MCP_ENCRYPTION_KEY"
  "CODE_SANDBOX_"
  "CRON_SECRET"
  "TAVILY_API_KEY"
  "BRAVE_SEARCH_API_KEY"
  "EXA_API_KEY"
  "UPLOADTHING_TOKEN"
  "lib/server/"
  "@/server/"
  # The e2e-only fake tasks interface (components/agent/tasks/e2e-fake.ts):
  # only a build with NEXT_PUBLIC_E2E_TASKS_FAKE=1 may carry it.
  "__humm_e2e_tasks_fake__"
  "__HUMM_E2E_TASKS__"
)

EXIT=0
for needle in "${NEEDLES[@]}"; do
  matches=$(grep -lF "$needle" "$CHUNKS_DIR"/*.js 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "❌ FAIL: \"$needle\" leaked into client chunk(s):"
    echo "$matches" | sed 's/^/    /'
    EXIT=1
  else
    echo "✅ ok: \"$needle\" not in client chunks"
  fi
done

if [ "$EXIT" -eq 0 ]; then
  echo ""
  echo "Bundle audit passed."
else
  echo ""
  echo "Bundle audit FAILED — see hits above."
fi

exit "$EXIT"
