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

set -uo pipefail

CHUNKS_DIR=".next/static/chunks"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "no $CHUNKS_DIR — run \`bun run build\` first" >&2
  exit 1
fi

# Strings that must never appear in a client chunk. We check for env-var
# *names* (not values — values are runtime-only and never in source) and
# for server-only import paths.
#
# Note: `AI_GATEWAY_API_KEY` is intentionally *not* in this list. It surfaces
# legitimately in two places: (1) user-facing mock-mode error messages
# telling the user which env var to set, and (2) the `@ai-sdk/gateway`
# library bundles its own env-var name as an error-message string and is
# transitively pulled into the client via `@ai-sdk/react` / Plate.js. The
# *value* of the key is never in source — only the name is — so name hits
# are harmless. The real protection is the `lib/server/` / `@/server/`
# path check below combined with the `server-only` fence.
NEEDLES=(
  "SUPABASE_SERVICE_ROLE_KEY"
  "TAVILY_API_KEY"
  "UPLOADTHING_TOKEN"
  "MCP_ENCRYPTION_KEY"
  "lib/server/"
  "@/server/"
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
