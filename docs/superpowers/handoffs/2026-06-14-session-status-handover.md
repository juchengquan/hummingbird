# Session Status — Handover (2026-06-14)

**Status:** 🟢 At a clean stopping point. The citation-table editor arc + a test-infra fix are **shipped to `dev`**; one small CI PR (#219) is **open and awaiting the final `ci` check + merge**.

This is a broad session handover (not one feature) so a later agent can pick up. It records what shipped, the one thing in flight, the test-infra context that's easy to trip over, and the menu of next steps.

---

## In flight right now — PR #219 (finish this first)

**PR #219 — `ci: run the app test suite on every PR (app-tests job)`** (branch `ci/app-tests-job`, base `dev`).

- Adds a parallel `app-tests` job to `.github/workflows/ci.yml` running `bun run test` (the split runner). Closes the gap where the root `ci` job ran **no** `bun test`, so app unit tests never gated PRs.
- **CI status at handover:** `app-tests` ✅, `agent-py` ✅, `agent-ts` ✅, `agent-py-types-drift` ✅; `ci` still pending. The new `app-tests` check is self-verifying (it runs on this PR) and **already passed** — that was the live verification.
- **To finish:** once `ci` goes green and the user merges, run the standard cleanup: `git checkout dev && git pull --ff-only && git branch -D ci/app-tests-job` (the remote branch auto-deletes on merge).
- Spec: `docs/superpowers/specs/2026-06-14-app-tests-ci-job-design.md`; plan: `docs/superpowers/plans/2026-06-14-app-tests-ci-job.md`.

---

## Shipped this session (all squash-merged to `dev`)

| PR | What | dev commit |
|---|---|---|
| #208 | Generative-UI date input (date-picker kind + mini-form date field) | `7ccc6c9` |
| #209 | Semantic caching Phase 2 (in-process near-match, file mode) | `bda3a36` |
| #210 | Semantic near-match for project-breakdown summaries | `6a59dba` |
| #211 | Per-MCP-server `requires_approval` gating | `d57c203` |
| #212 | Citation-table artifact renderer (slice 1) | `d8719a2` |
| #213 | "Extract to table" action (slice 2) | `bf03bb3` |
| #214 | Sortable + editable citation tables in the Artifacts tab (slice 3) | `84ca659` |
| #215 | Embed table as a read-only Plate node (slice 4a) | `71feca9` |
| #216 | Editable embedded table in the editor doc (slice 4b) | `253caac` |
| #217 | `/` slash-command to insert an embedded table (slice 4c) | `d409488` |
| #218 | Split root `bun test` to fix pre-existing suite failures | `d1f753c` |

**The citation-table editor arc (sub-project 4 of `docs/PLAN-cross-product-inspirations.md` §9) is feature-complete:** render → generate → sort+edit → embed → edit-in-doc → slash-insert. Each slice has a spec in `docs/superpowers/specs/` and a plan in `docs/superpowers/plans/` (dated `2026-06-13`/`2026-06-14`).

### Citation-table code map (for follow-ups)
- `lib/shared/artifacts/citation-table.ts` — data model + `parseCitationTable`, `sortRowOrder`, `setCellValue`, `sourceIndex` (pure, tested).
- `lib/shared/artifacts/extract-table.ts` — `ExtractionSchema` + `extractionToCitationTable` + prompt builder (slice 2).
- `lib/shared/artifacts/citation-table-md.ts` — MDX round-trip helpers + `CITATION_TABLE_KEY` (slice 4a). **Single source of truth** for the node type / plugin key / MDX tag.
- `lib/shared/artifacts/citation-table-slash.ts` — `buildCitationTableSlashItems` (slice 4c).
- `components/panels/citation-table.tsx` — `CitationTableView` (read-only without `onChange`, editable with it).
- `components/ui/citation-table-node.tsx` — the editable void Plate node (4a/4b).
- `components/editor/plugins/citation-table-kit.tsx` — the plugin (registered in `editor-kit.tsx`).
- `components/editor/plugins/markdown-kit.tsx` — the MDX serialize/deserialize rules (additive; no `code_block` override).
- `components/editor/transforms.ts` — `insertCitationTable` (4c).
- `app/api/extract-table/route.ts` — the extraction endpoint (slice 2).

---

## Test infrastructure — READ THIS before touching tests or CI

**The root test run is split.** `bun run test` runs `scripts/run-tests.sh` (added in #218), **not** a bare `bun test`. Two reasons, both unavoidable:

1. **Process-global `mock.module` leak.** The 4 task-route tests under `app/api/tasks/` (via `app/api/tasks/_test/mock-agent-store.ts`) register process-global mocks for `@/server/supabase/server`, `@/server/model-provider`, `@/server/agent/store`, `@/server/agent/jobs`. **bun cannot restore module mocks** (`mock.restore()` does not undo `mock.module` — verified). So in a single process they leak into and break `lib/server/image-storage.test.ts` and `lib/server/model-provider.test.ts` (the latter can't self-pin — it tests the real module). The runner isolates `app/api/tasks/` in its own `bun test` process.
2. **`services/` must not be swept in.** No workspaces → `services/agent-ts` deps (`postgres`) aren't installed at root; agent-ts/agent-py have their own CI jobs. The runner excludes `services/`.

**Gotchas:**
- bun positional filters are **substring** matches, so paths must be `./`-anchored (a bare `tests` also matches `services/agent-ts/tests/`).
- bun has **no exclude flag**, so the runner hand-enumerates roots (`ISOLATED="./app/api/tasks"`, `MAIN_ROOTS=(./app/api/ai ./components ./lib ./scripts ./tests)`) and a **coverage guard** fails if any `*.test.ts` outside `node_modules/`/`services/` sits outside those roots. **If you add tests under a new top-level dir, add that dir to `MAIN_ROOTS`** or the guard fails loudly (by design).
- An `error: postgres unreachable` trace from `route.handler.test.ts:240` during `bun run test` is an **intentional throw inside a passing test** — not a failure. Counts stay `0 fail`.
- Adding a new test file that does global `mock.module` of a shared `@/server/*` module risks the same leak. Either run it under `app/api/tasks/` (isolated) or give it its own isolated root.

Design/plan for the split: `docs/superpowers/specs/2026-06-14-root-test-runner-split-design.md`, `docs/superpowers/plans/2026-06-14-root-test-runner-split.md`.

---

## How work is run this session (the loop)

Every feature follows the **superpowers** flow, and the user drives it:
1. `brainstorming` skill → design → write spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, commit. **HARD-GATE: design approved before any code.** Ask the user to review the spec.
2. `writing-plans` skill → plan to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, commit.
3. Execution: usually `subagent-driven-development` (the user picks "1") — fresh implementer subagent per task, then spec-compliance + code-quality review subagents; for tiny tasks a single combined review is proportionate.
4. `finishing-a-development-branch` → the user almost always picks **"2" (push + PR into `dev`)**.
5. After PR creation, a `Monitor` watches `gh pr checks <N>` until all are non-pending (the GitHub MCP `subscribe_pr_activity` tool is **not** connected this session).
6. User merges → cleanup: `git checkout dev && git pull --ff-only && git branch -D <branch>` (remote auto-deletes on merge).

Branch naming: `feat/...`, `fix/...`, `ci/...`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

Local gate before pushing: `bun run check` (typecheck + lint + the split test run). For agent-py changes also `bun run check:agent-py` (its CI runs `ruff format --check` as a separate step).

---

## Next steps (menu the user has been choosing from)

- **Citation-table polish** (deferred from the slices): a column hint/picker for "Extract to table" (steer which columns get extracted, vs. fully model-proposed); add/remove rows & columns in the interactive table.
- **agent-py Phase 2b** — real model + tools in the executor step fn (currently a Phase 2a stub). See `docs/PLAN-agent-api.md`.
- **More cross-product features** from `docs/PLAN-cross-product-inspirations.md` (beyond §9).
- **Pre-existing lint warnings:** 9 `Unused eslint-disable directive` warnings in `services/agent-ts/*` (poller.ts/server.ts) — harmless, but a tidy-up if desired.

---

## Known-good baseline at handover

- `bun run check` is **green end-to-end** on `dev` (typecheck + lint 0 errors; split test run 52 + 1240 pass / 0 fail). This is the first time it passes fully — courtesy of #218.
- Working tree on `dev` is clean; the only open branch is `ci/app-tests-job` (PR #219).
