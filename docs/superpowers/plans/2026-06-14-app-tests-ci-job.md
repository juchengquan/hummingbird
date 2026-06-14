# App-Tests CI Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel `app-tests` job to `.github/workflows/ci.yml` that runs `bun run test` (the split root suite from #218), so the app's unit tests gate every PR.

**Architecture:** One new top-level job in the `jobs:` map, mirroring the existing `agent-py`/`agent-ts` jobs (checkout + setup-bun + shared bun cache + `bun install --frozen-lockfile` + `bun run test`). Runs in parallel with `ci` (no `needs:`). No product code, no script changes.

**Tech Stack:** GitHub Actions · bun.

---

## Background the implementer needs

- The root `ci` job runs typecheck/lint/build/audit/supabase-check but **no `bun test`** — so app unit tests never gate PRs. This job closes that gap.
- `bun run test` runs `scripts/run-tests.sh` (the two-process split + coverage guard from PR #218): `bun test ./app/api/tasks` (isolated — its process-global `mock.module` mocks would otherwise leak) then `bun test ./app/api/ai ./components ./lib ./scripts ./tests` (everything else, `services/` excluded).
- **Verified non-issues:** the suite needs **no env/secrets** (tests mock via the `tests/setup.ts` preload) and **no `--conditions=react-server`** flag (`bun run test` is green as-is: 52 + 1240 pass / 0 fail).
- The existing jobs each do their own `actions/checkout@v4` + `oven-sh/setup-bun@v2` + (for the bun ones) `bun install --frozen-lockfile`. The `ci` job's cache step uses `key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}` with `restore-keys: bun-${{ runner.os }}-` over paths `~/.bun/install/cache` and `node_modules`.
- The file currently ends at line 182 (the last step of the `agent-py-types-drift` job). The new job is appended after it, at the top level of the `jobs:` map (job key indented 2 spaces).

## File Structure

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | append the `app-tests` job to the `jobs:` map |

---

## Task 1: Add the `app-tests` job

**Files:**
- Modify: `.github/workflows/ci.yml` (append after line 182)

- [ ] **Step 1: Append the job**

At the END of `.github/workflows/ci.yml` (after the final line of the `agent-py-types-drift` job — currently line 182, `        run: bun run codegen:agent-types:check`), add a blank line and then this job (job key `app-tests` indented 2 spaces, identical structure to the sibling jobs):

```yaml

  # Root web-app unit tests. Runs the split root suite via
  # `bun run test` → scripts/run-tests.sh (two bun processes: isolates
  # app/api/tasks/'s process-global mock.module mocks, excludes services/;
  # a coverage guard fails if a *.test.ts sits outside the configured
  # roots — see scripts/run-tests.sh / PR #218). Separate parallel job,
  # mirroring agent-py/agent-ts, so the `ci` build job's time is unchanged
  # and a test failure gets its own check name.
  app-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Cache bun install
        uses: actions/cache@v4
        with:
          path: |
            ~/.bun/install/cache
            node_modules
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Test
        run: bun run test
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `bunx actionlint .github/workflows/ci.yml`
Expected: no output / exit 0 (no errors). `actionlint` isn't installed locally; `bunx` fetches it. If `bunx actionlint` cannot run offline, instead verify the YAML parses and the job is well-formed:

Run: `bun -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); const m=y.match(/^  [a-z0-9-]+:/gm); console.log(m)"`
Expected: the printed job-key list includes `  app-tests:` alongside `  ci:`, `  agent-py:`, `  agent-ts:`, `  agent-py-types-drift:` — confirming the new job sits at the same `jobs:` indentation level (2 spaces) as its siblings.

- [ ] **Step 3: Confirm the command the job runs is green locally**

Run: `bun run test`
Expected: the split runner → `52 pass / 0 fail` (isolated `app/api/tasks`) + `1240 pass / 0 fail` (the rest), exit 0. This proves the exact command the CI job invokes works. (An `error: postgres unreachable` trace from `route.handler.test.ts:240` is an expected intentional throw inside a passing test — the counts stay `0 fail`.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add app-tests job running the split root suite"
```

---

## Task 2: Verify the live CI run (post-PR)

**Files:** none (verification only — happens after the PR is opened).

- [ ] **Step 1: After the PR is opened, watch the new job**

The PR's CI run executes the `app-tests` job for real (GitHub Actions can't be fully run locally). Confirm `app-tests` appears as its own check and goes **green** alongside `ci`, `agent-py`, `agent-py-types-drift`, and `agent-ts`. (This step is performed during the finishing/PR phase, not in the implementation session — it's listed here so the PR's Test Plan tracks it.)

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- New parallel `app-tests` job mirroring agent-py/agent-ts, running `bun run test` → Task 1 Step 1.
- Shared bun cache (same key as `ci`) → in the job YAML.
- No `needs:` (parallel) → the job has no `needs:` key.
- No secrets / no `--conditions=react-server` → covered by running plain `bun run test` (verified, Task 1 Step 3).
- YAML validity → Task 1 Step 2 (`actionlint` / structural fallback).
- Live CI verification → Task 2.

**2. Placeholder scan:** No TBD/TODO; the full job YAML, exact commands, and expected output are shown.

**3. Type consistency:** The job runs `bun run test` (the `package.json` script wired in #218 to `bash scripts/run-tests.sh`). The cache `key`/`restore-keys`/`path` match the `ci` job's cache step exactly. The job key `app-tests` is referenced consistently in the YAML and the verification step.
