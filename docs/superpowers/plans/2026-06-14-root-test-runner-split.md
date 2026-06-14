# Root Test-Runner Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun run test` / `bun run check` pass green and deterministically by splitting the root test run into two `bun test` processes — isolating the `app/api/tasks/` tests (whose process-global `mock.module` mocks leak) and excluding `services/` (separate sub-projects with their own CI jobs) — guarded so no test file is silently skipped.

**Architecture:** A new `scripts/run-tests.sh` runs a coverage guard, then `bun test ./app/api/tasks`, then `bun test` over the remaining roots. The `package.json` `test` script calls it. No product code or CI changes.

**Tech Stack:** bash (3.2-compatible — macOS default) · bun test.

---

## Background the implementer needs

- **Why two processes:** the 4 task-route tests under `app/api/tasks/` use `app/api/tasks/_test/mock-agent-store.ts`, which registers process-global `mock.module` mocks for `@/server/supabase/server`, `@/server/model-provider`, `@/server/agent/store`, `@/server/agent/jobs`. bun's `mock.module` **cannot be restored**, so in a single process those mocks leak into `lib/server/image-storage.test.ts` (fake supabase client → wrong path) and `lib/server/model-provider.test.ts` (`SyntaxError`: real export missing). Running `app/api/tasks/` in its own process contains the leak.
- **Why `./`-anchored paths:** bun positional filters are **substring** matches, so a bare `tests` also matches `services/agent-ts/tests/` (re-introducing the `postgres` error). `./tests` matches only the repo-root `tests/`. Always anchor with `./`.
- **Why exclude `services/`:** no workspaces → `services/agent-ts` deps (`postgres`) aren't installed at root; agent-ts/agent-py have their own CI jobs (`.github/workflows/ci.yml`). They must not be swept into the root run.
- **Verified during design:** `bun test ./app/api/tasks` → 52 pass / 0 fail; `bun test ./app/api/ai ./components ./lib ./scripts ./tests` → 1240 pass / 0 fail.
- **Current `package.json` scripts** (`package.json:11-13`): `"test": "bun test"`, `"check": "... && bun run test"`, `"check:ci": "... && bun run test && ..."`. Only `test` changes; `check`/`check:ci` keep chaining `bun run test`.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/run-tests.sh` | **new** — coverage guard + two-process split run |
| `package.json` | `"test": "bash scripts/run-tests.sh"` |
| `CLAUDE.md` | one-line note explaining the split |

---

## Task 1: Create the split test runner

**Files:**
- Create: `scripts/run-tests.sh`

- [ ] **Step 1: Write the script**

Create `scripts/run-tests.sh` with EXACTLY this content:

```bash
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
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/run-tests.sh`
(Not strictly required since `package.json` calls it via `bash`, but conventional.)

- [ ] **Step 3: Run it — expect both runs green**

Run: `bash scripts/run-tests.sh`
Expected: the guard prints nothing, then two `bun test` summaries, both `0 fail` (≈ 52 pass for the isolated run, ≈ 1240 pass for the rest). Exit code 0. Confirm there is NO `Cannot find package 'postgres'` line (services excluded).

- [ ] **Step 4: Verify the coverage guard fails on a stray test**

Create a throwaway test outside the configured roots and confirm the guard catches it:

```bash
mkdir -p app/api/zzz_guardcheck
printf 'import { test, expect } from "bun:test"\ntest("x", () => expect(1).toBe(1))\n' > app/api/zzz_guardcheck/stray.test.ts
bash scripts/run-tests.sh; echo "exit=$?"
```
Expected: the script prints `ERROR: these *.test.ts files are outside the roots ...` listing `app/api/zzz_guardcheck/stray.test.ts`, and `exit=1` (it must NOT run bun test).

Then remove the throwaway and confirm green again:
```bash
rm -rf app/api/zzz_guardcheck
bash scripts/run-tests.sh; echo "exit=$?"
```
Expected: both runs green, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-tests.sh
git commit -m "test: split root bun test into two processes + coverage guard"
```

---

## Task 2: Wire the `test` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Point `test` at the script**

In `package.json`, change line 11 from:
```json
    "test": "bun test",
```
to:
```json
    "test": "bash scripts/run-tests.sh",
```
Leave `check` (`package.json:12`) and `check:ci` (`package.json:13`) unchanged — they chain `bun run test`, so they now run the split automatically.

- [ ] **Step 2: Verify `bun run test`**

Run: `bun run test`
Expected: runs `scripts/run-tests.sh` → both runs green, exit 0.

- [ ] **Step 3: Verify `bun run check` end-to-end**

Run: `bun run check`
Expected: typecheck PASS, lint PASS (0 errors; pre-existing warnings OK), then the split test run green. Exit 0 overall — this is the first time `bun run check` passes end-to-end.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "test: run the split test runner from the test script"
```

---

## Task 3: Document the split in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a note under the Linting block**

In `CLAUDE.md`, the Commands block has (lines 22-23):
```
bun run check        # typecheck + lint (fast — mirrors CI without build/audit)
bun run check:ci     # typecheck + lint + build + audit:bundle (full CI gate locally)
```
Immediately AFTER line 23 (the `check:ci` line), add:
```
bun run test         # split runner (scripts/run-tests.sh): isolates app/api/tasks/ (process-global mock.module mocks) + excludes services/ (own CI jobs); a coverage guard fails if a *.test.ts sits outside the configured roots
```

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `git diff CLAUDE.md`
Expected: exactly the one added line after the `check:ci` line, inside the same code fence.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note the split test runner in CLAUDE.md commands"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- `scripts/run-tests.sh` with two-process split + `./`-anchored roots + coverage guard → Task 1.
- `package.json` `test` → `bash scripts/run-tests.sh` → Task 2.
- CLAUDE.md note → Task 3.
- Verification (both runs green; guard fails on stray) → Task 1 Steps 3-4, Task 2 Steps 2-3.
- Out-of-scope items (DI refactor, CI job) correctly omitted.

**2. Placeholder scan:** No TBD/TODO; the full script + exact edits + exact commands are shown.

**3. Type consistency:** Root names are identical across the script and the guard (`ISOLATED="./app/api/tasks"`, `MAIN_ROOTS=(./app/api/ai ./components ./lib ./scripts ./tests)`); the guard's `case` pattern strips the leading `./` (`"${root#./}"/*`) to match the `sed`-stripped `find` output. The `package.json` path `scripts/run-tests.sh` matches the file created in Task 1.
