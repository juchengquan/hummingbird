#!/usr/bin/env bash
# Re-record the agent-py run streams the frontend runs client is tested on
# (lib/client/runs/fixtures/agent-py/, read by lib/client/runs/*.test.ts).
#
# Two sources, both agent-py's own tests with RUNS_E2E_FIXTURES_DIR set:
#  - tests/test_runs_e2e.py           → memory-<name>.sse: the real app over
#    HTTP with a scripted model (interactive, rejoin, interrupts + resumes,
#    cancel, anonymous, a model failure);
#  - tests/test_runs_client_fixtures.py → stream-<name>.sse: the real encoder +
#    stream over crafted logs (reasoning, every part kind, gap + snapshot,
#    purge, rewind, step errors, a failed run).
# Only the in-memory backend is recorded (AGENT_PY_TEST_DB_URL is unset for
# the run), so the set is the same on every machine. Ids are fresh UUIDs on
# each recording; the tests never pin them.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="$PWD/lib/client/runs/fixtures/agent-py"
rm -rf "$OUT"
mkdir -p "$OUT"
(
  cd services/agent-py
  env -u AGENT_PY_TEST_DB_URL RUNS_E2E_FIXTURES_DIR="$OUT" \
    uv run pytest -q tests/test_runs_e2e.py tests/test_runs_client_fixtures.py
)
echo "recorded $(ls "$OUT" | wc -l | tr -d ' ') streams into ${OUT#"$PWD"/}"
