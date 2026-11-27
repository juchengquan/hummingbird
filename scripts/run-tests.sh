#!/usr/bin/env bash
# Root unit-test runner. It runs only the configured roots, on purpose:
#  1. services/** are separate sub-projects with their own deps + CI jobs;
#     the root run must not sweep them in.
#  2. packages/contract/conformance/** cases need a live backend
#     (CONTRACT_BASE_URL); without it they report as skipped here. Run them
#     with `bun run contract:conformance` — see packages/contract/README.md.
# Paths are ./-anchored because bun's positional filters are substring matches:
# a bare `tests` would also match services/*/tests/.
set -euo pipefail

cd "$(dirname "$0")/.."

MAIN_ROOTS=(./components ./lib ./packages ./scripts ./tests)

# Coverage guard: every *.test.ts (outside node_modules/ and services/) must
# live under a configured root, so nothing is silently skipped when bun has no
# exclude flag. services/ is intentionally excluded (its own CI jobs run it).
uncovered=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  covered=0
  for root in "${MAIN_ROOTS[@]}"; do
    case "$f" in "${root#./}"/*) covered=1; break;; esac
  done
  [ "$covered" = 1 ] || uncovered="${uncovered}${f}"$'\n'
done <<EOF
$(find . -name '*.test.ts' -not -path '*/node_modules/*' -not -path './services/*' -not -path './.claude/*' | sed 's|^\./||' | sort)
EOF

if [ -n "$uncovered" ]; then
  echo "ERROR: these *.test.ts files are outside the roots in scripts/run-tests.sh:" >&2
  printf '%s' "$uncovered" | sed 's/^/  /' >&2
  echo "Add their directory to MAIN_ROOTS so they are not skipped." >&2
  exit 1
fi

bun test "${MAIN_ROOTS[@]}"
