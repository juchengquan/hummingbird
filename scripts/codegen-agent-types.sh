#!/bin/bash
# Agent service OpenAPI → TS codegen.
#
# The Python agent service emits an OpenAPI doc at /openapi.json (FastAPI
# does this by default). The Next.js side consumes generated TS types
# from that doc so the contract is single-source-of-truth on the Python
# side — drift between the two implementations fails CI.
#
# Phase 0 ship: just the smoke surface (/healthz, /readyz, /v1/whoami).
# As phases land, the generated types grow without any script change.
#
# Usage:
#   scripts/codegen-agent-types.sh          # regenerate
#   scripts/codegen-agent-types.sh --check  # CI mode: fail if drifted
#
# The generated file (`lib/shared/agent-py-types.generated.ts`) is checked
# into git so neither CI nor a fresh checkout needs to run the Python
# service to typecheck. The check mode below ensures it's actually
# current.

set -euo pipefail

GENERATED="lib/shared/agent-py-types.generated.ts"
OPENAPI_URL="${AGENT_PY_OPENAPI_URL:-http://localhost:8000/openapi.json}"

MODE="${1:-write}"

# Prefer a live service if one's running on localhost; otherwise extract the
# OpenAPI directly from the FastAPI app via Python. The Python path makes
# this script work in CI without booting the container.
fetch_openapi() {
  if curl --silent --fail --max-time 2 "${OPENAPI_URL}" >/dev/null 2>&1; then
    echo "→ Using live service at ${OPENAPI_URL}" >&2
    curl --silent --fail "${OPENAPI_URL}"
  elif command -v uv >/dev/null 2>&1; then
    echo "→ Extracting OpenAPI from agent_py.main:app via uv" >&2
    (
      cd services/agent-py
      uv run --frozen python -c "import json,sys; from agent_py.main import app; json.dump(app.openapi(), sys.stdout)"
    )
  else
    echo "ERROR: neither a live service nor uv is available; cannot regenerate." >&2
    echo "Install uv (https://github.com/astral-sh/uv) or start the service first." >&2
    exit 1
  fi
}

regenerate() {
  local tmp
  tmp="$(mktemp)"
  fetch_openapi >"${tmp}"

  # `openapi-typescript` is in devDependencies; bunx runs it without a
  # separate install step.
  local header
  header="// Auto-generated from services/agent-py/openapi.json. Do not edit by hand.
// Regenerate with: bun run codegen:agent-types
// See scripts/codegen-agent-types.sh for the rationale.
"

  {
    printf '%s' "${header}"
    bunx --bun openapi-typescript "${tmp}"
  } >"${GENERATED}.tmp"

  mv "${GENERATED}.tmp" "${GENERATED}"
  rm -f "${tmp}"
  echo "→ Wrote ${GENERATED}" >&2
}

check_in_sync() {
  local before after
  before="$(cat "${GENERATED}" 2>/dev/null || echo "")"
  regenerate
  after="$(cat "${GENERATED}")"
  if [[ "${before}" != "${after}" ]]; then
    echo "" >&2
    echo "ERROR: ${GENERATED} is out of date." >&2
    echo "Regenerate with:  bun run codegen:agent-types" >&2
    echo "(then commit the result)" >&2
    # Restore the file to its pre-script state so the rest of CI runs
    # against what was actually committed.
    printf '%s' "${before}" >"${GENERATED}"
    exit 1
  fi
  echo "→ ${GENERATED} is up to date." >&2
}

case "${MODE}" in
  --check)
    check_in_sync
    ;;
  *)
    regenerate
    ;;
esac
