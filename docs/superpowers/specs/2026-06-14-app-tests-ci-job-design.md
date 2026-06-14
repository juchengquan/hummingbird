# Wire the app test suite into CI — `app-tests` job — Design

Status: **approved design — ready for implementation plan.**

## Why

The root `ci` job (`.github/workflows/ci.yml`) runs typecheck / lint / build / bundle-audit / supabase-types — but **no `bun test`**. So the app's ~1290 unit tests never gate PRs. That gap is exactly what let the suite rot until #218 fixed it (the `services/` sweep + the `mock.module` leak). Now that `bun run test` (→ `scripts/run-tests.sh`) is green and deterministic, CI should run it so the suite stays green.

## Decision

Add **one new top-level job, `app-tests`**, to `.github/workflows/ci.yml`, running in **parallel** with the existing `ci` / `agent-py` / `agent-ts` jobs (no `needs:`). It mirrors the existing job shape and runs `bun run test`, which invokes the split runner from #218. This is the user-selected shape (separate parallel job, not a step inside `ci`) — it matches the repo's one-job-per-test-surface convention, keeps the `ci` build job's time unchanged, and gives an isolated, named `app-tests` check.

Out of scope: changing what `bun run test` runs (it already runs `scripts/run-tests.sh`); touching the `ci` job; any product/script change.

## Architecture

A single job added to the `jobs:` map in `.github/workflows/ci.yml`:

```yaml
  # Root web-app unit tests. Runs the split root suite via
  # `bun run test` → scripts/run-tests.sh (two bun processes: isolates
  # app/api/tasks/'s process-global mock.module mocks, excludes services/;
  # a coverage guard fails if a *.test.ts sits outside the configured
  # roots — see scripts/run-tests.sh / PR #218). Separate parallel job,
  # mirroring agent-py/agent-ts, so the build job's time is unchanged and
  # a test failure gets its own check name.
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

### Why each piece

- **Parallel, no `needs:`** — the suite shares no inputs with the other jobs; running it concurrently keeps it off the critical path (the `ci` job's `build` is the long pole).
- **Same bun cache** as the `ci` job (`key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}`, `restore-keys: bun-${{ runner.os }}-`, paths `~/.bun/install/cache` + `node_modules`) — so the duplicate `bun install` is mostly a cache restore. Two jobs reading/writing the same key is the standard GitHub Actions pattern (concurrent saves no-op gracefully).
- **`bun install --frozen-lockfile`** — same install step every other job uses; fails on lockfile drift.
- **`bun run test`** (not bare `bun test`) — so the `package.json` script runs `scripts/run-tests.sh` (the two-process split + coverage guard). A failing test **or** the guard tripping fails the job.
- **`timeout-minutes: 10`** — generous; the suite runs in ~1s locally, so install dominates. Matches the agent-py timeout.

### Non-issues (verified)

- **No secrets/env needed.** `bun run test` is green locally with no env vars — the app tests mock their dependencies via the `tests/setup.ts` preload (bunfig `[test] preload`). So the job needs no Supabase / AI-gateway / MCP secrets.
- **No `--conditions=react-server`.** The `agent-ts` job needs that flag because it reuses `lib/server/*` modules whose `import "server-only"` must resolve under that condition. The **root** app tests pass under plain `bun run test` (the `tests/setup.ts` preload mocks the `server-only`/`client-only` fence). Confirmed: `bun run test` → 52 + 1240 pass / 0 fail with no extra flags.
- **bash availability.** `scripts/run-tests.sh` runs under bash; `ubuntu-latest` ships bash 4+, and the script is written 3.2-compatible, so it runs in CI unchanged.

## Error handling

- A genuinely failing app test → the `Test` step exits non-zero → `app-tests` check fails the PR. Intended.
- The coverage guard tripping (a `*.test.ts` added outside the configured roots) → non-zero exit → job fails with the guard's actionable message. Intended — this is the guard doing its job in CI.
- Lockfile drift → `bun install --frozen-lockfile` fails (same as every other job).

## Testing / verification

GitHub Actions can't be fully executed locally, so verification is:

1. **YAML validity / lint:** run `bunx actionlint .github/workflows/ci.yml` (actionlint isn't installed locally; `bunx` fetches it) — expect no errors. If `bunx actionlint` is unavailable offline, fall back to a careful structural review that the new job sits correctly under `jobs:` with consistent indentation and mirrors the sibling jobs.
2. **Local equivalence:** confirm `bun run test` (the exact command the job runs) is green on the branch (52 + 1240 pass / 0 fail) — proving the command the job invokes works.
3. **Live CI run:** the PR's own CI exercises the new `app-tests` job end-to-end; watch it go green alongside `ci` / `agent-py` / `agent-ts`. This is the real integration test.

## Touch-point summary

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | add the `app-tests` job to the `jobs:` map |

## Scope

**XS.** One new job in one workflow file. No product code, no script change (reuses `scripts/run-tests.sh` from #218), no new deps, no secrets. Closes the coverage gap that let the suite rot: the app tests now gate every PR.
