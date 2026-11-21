#!/usr/bin/env bash
# Contract codegen: packages/contract/openapi.yaml → generated code.
#
#   TypeScript  lib/shared/contract/openapi.generated.ts      (openapi-typescript)
#   Python      services/agent-py/src/agent_py/contract/models.py
#                                                             (datamodel-code-generator)
#
# Each consumer holds its own generated code; packages/contract holds
# only the spec, the vendored AG-UI schema and the tooling. See
# packages/contract/README.md.
#
# Usage (from anywhere in the repo):
#   bash packages/contract/scripts/gen.sh           # regenerate
#   bash packages/contract/scripts/gen.sh --check   # fail if outputs drifted
#
# Both generators are pinned by the lockfiles (bun.lock, services/agent-py/
# uv.lock) and the Python output is normalised with ruff, so the output is
# byte-identical across machines.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "${ROOT}"

SPEC="packages/contract/openapi.yaml"
TS_OUT="lib/shared/contract/openapi.generated.ts"
PY_OUT="services/agent-py/src/agent_py/contract/models.py"
OUTPUTS=("${TS_OUT}" "${PY_OUT}")

MODE="${1:-write}"

# Writes both outputs under $1 (a directory that mirrors the repo root).
generate_into() {
  local dest="$1"
  mkdir -p "${dest}/$(dirname "${TS_OUT}")" "${dest}/$(dirname "${PY_OUT}")"

  # --- TypeScript ----------------------------------------------------------
  {
    printf '%s\n' \
      "// DO NOT EDIT — generated from packages/contract/openapi.yaml." \
      "// Regenerate with: bun run contract:gen (packages/contract/scripts/gen.sh)." \
      ""
    bunx --bun openapi-typescript "${SPEC}" \
      --root-types --root-types-no-schema-prefix --alphabetize
  } >"${dest}/${TS_OUT}"

  # --- Python --------------------------------------------------------------
  local header
  header="# DO NOT EDIT — generated from packages/contract/openapi.yaml.
# Regenerate with: bun run contract:gen (packages/contract/scripts/gen.sh)."
  (
    cd services/agent-py
    uv run --frozen datamodel-codegen \
      --input "${ROOT}/${SPEC}" \
      --input-file-type openapi \
      --output "${dest}/${PY_OUT}" \
      --output-model-type pydantic_v2.BaseModel \
      --target-python-version 3.12 \
      --use-annotated \
      --use-type-alias \
      --field-constraints \
      --use-standard-collections \
      --use-union-operator \
      --use-double-quotes \
      --use-schema-description \
      --use-field-description \
      --enum-field-as-literal all \
      --keep-model-order \
      --disable-timestamp \
      --custom-file-header "${header}" \
      --formatters ruff-format ruff-check
    # Normalise with the service's own ruff config so `bun run check:agent-py`
    # stays clean regardless of the generator's formatting choices.
    uv run --frozen ruff check --config pyproject.toml --fix --quiet "${dest}/${PY_OUT}"
    uv run --frozen ruff format --config pyproject.toml --quiet "${dest}/${PY_OUT}"
  )
}

case "${MODE}" in
  --check)
    tmp="$(mktemp -d)"
    trap 'rm -rf "${tmp}"' EXIT
    generate_into "${tmp}"
    drift=0
    for f in "${OUTPUTS[@]}"; do
      if ! diff -u "${f}" "${tmp}/${f}" >/dev/null 2>&1; then
        echo "ERROR: ${f} is out of date with ${SPEC}." >&2
        diff -u "${f}" "${tmp}/${f}" >&2 || true
        drift=1
      fi
    done
    if [[ "${drift}" != 0 ]]; then
      echo "" >&2
      echo "Regenerate with:  bun run contract:gen   (then commit the result)" >&2
      exit 1
    fi
    echo "→ contract outputs are up to date with ${SPEC}." >&2
    ;;
  write | "")
    generate_into "${ROOT}"
    for f in "${OUTPUTS[@]}"; do echo "→ Wrote ${f}" >&2; done
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac
