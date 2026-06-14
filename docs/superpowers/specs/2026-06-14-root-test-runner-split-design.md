# Fix the root `bun test` failures — runner split — Design

Status: **approved design — ready for implementation plan.**

## Problem

`bun run test` (and therefore `bun run check` / `check:ci`, which chain it) fails locally with ~9 failures, even though every individual test file passes in isolation. Two independent root causes, both in **how the root `bun test` discovers/runs files** — no product code is at fault.

### Root cause 1 — `services/` swept into the root run

The repo has **no workspaces** (`package.json` `workspaces: null`), so `services/agent-ts`'s dependencies (notably `postgres`) are never installed at the root. But the root `bun test` recursively discovers `services/agent-ts/tests/*`, whose `import 'postgres'` throws `Cannot find package 'postgres'` — an **unhandled error between tests** that also destabilises the run. `services/agent-ts` is a separate sub-project tested by its **own CI job** (`.github/workflows/ci.yml` → `agent-ts:` → `cd services/agent-ts && bun run test`, which adds `--conditions=react-server` and installs agent-ts's deps). `services/agent-py` is Python (its own `uv`/`pytest` job). Neither belongs in the root run.

(The root `ci` CI job runs typecheck/lint/build/audit and **no `bun test`**, which is why CI is green while local `bun run check` is not.)

### Root cause 2 — process-global `mock.module` leak

`app/api/tasks/_test/mock-agent-store.ts` (shared by the **4** task-route tests under `app/api/tasks/`) registers **process-global** `mock.module` mocks for `@/server/supabase/server`, `@/server/model-provider`, `@/server/agent/store`, and `@/server/agent/jobs`. bun's `mock.module` is process-global and **cannot be restored** (verified: `mock.restore()` does not undo a module mock). So once a task-route test file loads, those mocks persist for the rest of the process and leak into any later test that imports the same modules:

- `lib/server/image-storage.test.ts` imports `@/server/supabase/server` (transitively, via `image-storage.ts`). The leaked mock returns a fake client, flipping `persistGeneratedImages` into the cloud-upload path → its data-URL-path assertions fail.
- `lib/server/model-provider.test.ts` imports the **real** `@/server/model-provider`. The leaked mock replaces the module, so a named import (`buildFallbackTable`) is missing → `SyntaxError` at module load.

`model-provider.test.ts` **cannot** self-pin a fix (it tests the real module, so it can't mock the module with itself), and bun cannot un-mock. The only correct fix is to run the leaky `app/api/tasks/` tests in a **separate process** so their global mocks never reach other files. bun has **no exclude/ignore flag** (verified — only `-t/--test-name-pattern`), so this requires splitting the root `bun test` into separate invocations.

All affected files pass in isolation; the split makes them pass together.

## Decision

A documented **`scripts/run-tests.sh`** that the `test` script calls, running **two** `bun test` invocations in separate processes, plus a **coverage guard** so no test file is ever silently skipped. No product code changes; no CI changes. Consistent with how `services/` is already isolated (its own CI job).

This is the user-selected scope ("Split the runner"). Out of scope (explicitly deferred): refactoring the task route handlers to dependency injection to remove the `mock.module` need; adding a CI job that runs the root app tests.

## Design

### `scripts/run-tests.sh` (new)

A bash script (must be **bash 3.2-compatible** — macOS default; the root tests run locally, not in CI). It:

1. Defines the run roots:
   - `ISOLATED="./app/api/tasks"` — the leak-causing group, run in its own process.
   - `MAIN_ROOTS=(./app/api/ai ./components ./lib ./scripts ./tests)` — everything else with a `*.test.ts` today.
   - Paths are **`./`-anchored** because bun's positional filters are substring matches: a bare `tests` would also match `services/agent-ts/tests/` and re-introduce root cause 1. `./tests` matches only the repo-root `tests/` dir. (Verified.)
2. **Coverage guard (runs first):** finds every `*.test.ts` under the repo excluding `node_modules/` and `services/`, and asserts each is under `ISOLATED` or one of `MAIN_ROOTS`. If any file is outside all configured roots, print the offending paths and `exit 1` with a message to add the root. This kills the fragility of hand-enumerated roots: a new test added outside them fails loudly instead of being silently skipped. (`services/` is intentionally excluded — those are run by their own CI jobs.)
3. **Run 1:** `bun test "$ISOLATED"` — the 4 task-route tests in their own process (their global mocks die with the process).
4. **Run 2:** `bun test "${MAIN_ROOTS[@]}"` — everything else, with no leaker and no `services/`.
5. `set -euo pipefail` so any failing run (or the guard) fails the script; the two `bun test` invocations are separate processes so the leak cannot cross between them.

Sketch (bash 3.2-safe — no `mapfile`):

```bash
#!/usr/bin/env bash
# Root unit-test runner — split into two bun processes on purpose:
#  1. app/api/tasks/** tests register process-global mock.module() mocks
#     (supabase/server, model-provider, agent/store, agent/jobs). bun cannot
#     restore module mocks, so they leak into later tests (image-storage,
#     model-provider) in the same process. Isolating them contains the leak.
#  2. services/** are separate sub-projects (agent-ts/agent-py) with their own
#     deps + CI jobs; the root run must not sweep them in (agent-ts's
#     `import postgres` is unresolved at the repo root).
# Paths are ./-anchored: bun's positional filters are substring matches, so a
# bare `tests` would also match services/agent-ts/tests/.
set -euo pipefail

ISOLATED="./app/api/tasks"
MAIN_ROOTS=(./app/api/ai ./components ./lib ./scripts ./tests)

# Coverage guard: every *.test.ts (outside node_modules/ and services/) must
# live under a configured root, so nothing is silently skipped.
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

bun test "$ISOLATED"
bun test "${MAIN_ROOTS[@]}"
```

### `package.json` (modify)

Change the `test` script from `"bun test"` to `"bash scripts/run-tests.sh"`. `check` (`typecheck && lint && test`) and `check:ci` keep chaining `bun run test`, so both now run the split. No other script changes.

### `CLAUDE.md` (modify)

The Commands section documents `bun run check` / `check:ci`. Add a one-line note that the root test run is split via `scripts/run-tests.sh` (isolating `app/api/tasks/` for its global `mock.module` mocks and excluding `services/`, which have their own CI jobs), so contributors understand why `bun run test` isn't a bare `bun test` and how to register a new test root.

## Verification (already confirmed during design)

- `bun test ./app/api/tasks` → **52 pass, 0 fail**.
- `bun test ./app/api/ai ./components ./lib ./scripts ./tests` → **1240 pass, 0 fail**.
- Together: all green, deterministic across repeated runs. `services/agent-ts` is not swept in (no `postgres` error); the `mock.module` leak cannot cross the process boundary.

## Testing

- **The fix is itself a test-runner change**, so verification is running it: `bun run test` (→ `scripts/run-tests.sh`) must exit 0 with both runs green; `bun run check` must pass end-to-end.
- **Coverage-guard behaviour:** verify the guard fails (non-zero, lists the file) when a `*.test.ts` exists outside the configured roots — checked by a temporary throwaway file during implementation (created, guard observed to fail, removed). Documented in the PR test plan.
- No unit test is added for the shell script itself (it's infrastructure; the guard + the two green runs are the proof).

## Touch-point summary

| File | Change |
|---|---|
| `scripts/run-tests.sh` | **new** — two-process split + coverage guard |
| `package.json` | `"test": "bash scripts/run-tests.sh"` |
| `CLAUDE.md` | one-line note explaining the split |

## Scope

**S.** One new script + a one-line `package.json` change + a doc note. No product code, no CI change, no new deps. Fixes both root causes (services sweep + `mock.module` leak) at the runner level and makes `bun run check` green and deterministic locally.
