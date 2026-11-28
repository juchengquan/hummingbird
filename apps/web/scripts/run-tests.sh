#!/usr/bin/env bash
# The web app's unit-test runner (apps/web). It runs only the configured
# roots, on purpose, and a coverage guard fails if a *.test.ts sits outside
# them (bun has no exclude flag). The repo root's scripts/run-tests.sh runs
# this one, then the root's own tests.
# Paths are ./-anchored because bun's positional filters are substring matches.
set -euo pipefail

cd "$(dirname "$0")/.."

MAIN_ROOTS=(./components ./lib ./scripts ./tests)

uncovered=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  covered=0
  for root in "${MAIN_ROOTS[@]}"; do
    case "$f" in "${root#./}"/*) covered=1; break;; esac
  done
  [ "$covered" = 1 ] || uncovered="${uncovered}${f}"$'\n'
done <<EOF2
$(find . -name '*.test.ts' -not -path '*/node_modules/*' | sed 's|^\./||' | sort)
EOF2

if [ -n "$uncovered" ]; then
  echo "ERROR: these *.test.ts files are outside the roots in apps/web/scripts/run-tests.sh:" >&2
  printf '%s' "$uncovered" | sed 's/^/  /' >&2
  echo "Add their directory to MAIN_ROOTS so they are not skipped." >&2
  exit 1
fi

bun test "${MAIN_ROOTS[@]}"
