#!/usr/bin/env bash
# Root unit-test runner: the web app's tests (apps/web/scripts/run-tests.sh),
# then the root's own (scripts/, packages/). On purpose it leaves out:
#  1. services/** — separate sub-projects with their own deps + CI jobs;
#  2. packages/contract/conformance/** — those cases need a live backend
#     (CONTRACT_BASE_URL) and report as skipped here. Run them with
#     `bun run contract:conformance` — see packages/contract/README.md.
# A coverage guard fails if a *.test.ts outside apps/web and services/ sits
# outside ROOT_ROOTS, so nothing is silently skipped (bun has no exclude flag).
# Paths are ./-anchored because bun's positional filters are substring matches.
set -euo pipefail

cd "$(dirname "$0")/.."

ROOT_ROOTS=(./packages ./scripts)

uncovered=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  covered=0
  for root in "${ROOT_ROOTS[@]}"; do
    case "$f" in "${root#./}"/*) covered=1; break;; esac
  done
  [ "$covered" = 1 ] || uncovered="${uncovered}${f}"$'\n'
done <<EOF2
$(find . -name '*.test.ts' -not -path '*/node_modules/*' -not -path './apps/*' -not -path './services/*' -not -path './.claude/*' | sed 's|^\./||' | sort)
EOF2

if [ -n "$uncovered" ]; then
  echo "ERROR: these *.test.ts files are outside the roots in scripts/run-tests.sh:" >&2
  printf '%s' "$uncovered" | sed 's/^/  /' >&2
  echo "Add their directory to ROOT_ROOTS so they are not skipped." >&2
  exit 1
fi

bash apps/web/scripts/run-tests.sh
bun test "${ROOT_ROOTS[@]}"
