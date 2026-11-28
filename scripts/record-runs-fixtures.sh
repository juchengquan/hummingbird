#!/usr/bin/env bash
# Re-record the agent-py run streams the frontend runs client is tested on
# (apps/web/lib/client/runs/fixtures/agent-py/, read by apps/web/lib/client/runs/*.test.ts).
#
#   bun run fixtures:runs                 # the interactive / stream sets
#   bun run fixtures:runs --background    # the background set (needs Docker)
#
# Interactive / stream sets — agent-py's own tests with RUNS_E2E_FIXTURES_DIR:
#  - tests/test_runs_e2e.py           → memory-<name>.sse: the real app over
#    HTTP with a scripted model (interactive, rejoin, interrupts + resumes,
#    cancel, anonymous, a model failure);
#  - tests/test_runs_client_fixtures.py → stream-<name>.sse: the real encoder +
#    stream over crafted logs (reasoning, every part kind, gap + snapshot,
#    purge, rewind, step errors, a failed run).
# Only the in-memory backend is recorded (AGENT_PY_TEST_DB_URL is unset for
# the run), so the set is the same on every machine.
#
# Background set (--background) — tests/test_runs_background_fixtures_pg.py
# on a throwaway Postgres (scripts/test-db.sh): real background tasks run by
# the poller and executor over a scripted model, recorded per scenario as
# background/<scenario>/<role>.sse + manifest.json (wave 6).
#
# Ids are fresh UUIDs on each recording; the tests never pin them. Each mode
# replaces only its own files.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="$PWD/apps/web/lib/client/runs/fixtures/agent-py"

if [ "${1:-}" = "--background" ]; then
  rm -rf "$OUT/background"
  mkdir -p "$OUT/background"
  RUNS_BG_FIXTURES_DIR="$OUT/background" \
    bash scripts/test-db.sh -q tests/test_runs_background_fixtures_pg.py
  echo "recorded $(find "$OUT/background" -name '*.sse' | wc -l | tr -d ' ') streams into ${OUT#"$PWD"/}/background"
  exit 0
fi

mkdir -p "$OUT"
find "$OUT" -maxdepth 1 -name '*.sse' -delete
(
  cd services/agent-py
  env -u AGENT_PY_TEST_DB_URL RUNS_E2E_FIXTURES_DIR="$OUT" \
    uv run pytest -q tests/test_runs_e2e.py tests/test_runs_client_fixtures.py
)
echo "recorded $(find "$OUT" -maxdepth 1 -name '*.sse' | wc -l | tr -d ' ') streams into ${OUT#"$PWD"/}"
