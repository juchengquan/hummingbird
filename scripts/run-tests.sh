#!/usr/bin/env bash
# Root unit-test runner — split into two bun processes on purpose:
#  1. app/api/tasks/** tests register process-global mock.module() mocks
#     (supabase/server, model-provider, agent/store, agent/jobs). bun cannot
#     restore module mocks, so in one process they leak into later tests
#     (lib/server/image-storage.test.ts, lib/server/model-provider.test.ts).
#     Isolating app/api/tasks/ in its own process contains the leak.
#  2. services/** are separate sub-projects (agent-ts/agent-py) with their own
#     deps + CI jobs; the root run must not sweep them in (agent-ts's
#     `import postgres` is unresolved at the repo root).
# Paths are ./-anchored because bun's positional filters are substring matches:
# a bare `tests` would also match services/agent-ts/tests/.
set -euo pipefail

cd "$(dirname "$0")/.."

ISOLATED="./app/api/tasks"
MAIN_ROOTS=(./app/api/ai ./components ./lib ./scripts ./tests)

# Coverage guard: every *.test.ts (outside node_modules/ and services/) must
# live under a configured root, so nothing is silently skipped when bun has no
# exclude flag. services/ is intentionally excluded (its own CI jobs run it).
uncovered=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  covered=0
  for root in "$ISOLATED" "${MAIN_ROOTS[@]}"; do
    case "$f" in "${root#./}"/*) covered=1; break;; esac
  done
  [ "$covered" = 1 ] || uncovered="${uncovered}${f}"$'\n'
done <<EOF
$(find . -name '*.test.ts' -not -path '*/node_modules/*' -not -path './services/*' | sed 's|^\./||' | sort)
EOF

if [ -n "$uncovered" ]; then
  echo "ERROR: these *.test.ts files are outside the roots in scripts/run-tests.sh:" >&2
  printf '%s' "$uncovered" | sed 's/^/  /' >&2
  echo "Add their directory to MAIN_ROOTS (or ISOLATED) so they are not skipped." >&2
  exit 1
fi

# Run 1: the leaky group, isolated in its own process.
bun test "$ISOLATED"
# Run 2: everything else (no leaker, no services/).
bun test "${MAIN_ROOTS[@]}"
