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

# Strings that must never appear in a client chunk. Add to this list when
# new server-only secrets or files are introduced.
NEEDLES=(
  "SUPABASE_SERVICE_ROLE_KEY"
  "AI_GATEWAY_API_KEY"
  "TAVILY_API_KEY"
  "UPLOADTHING_TOKEN"
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
