# Session Status — Handover (2026-06-14, post-#227)

**Status:** 🟢 At a clean stopping point. Three citation-table **polish**
slices landed on `dev` today (row-remove, in-place citation editing,
column reordering), all PRs merged, all CI green. `dev` is clean and in
sync with `origin/dev`; no branches in flight.

This refreshes the earlier same-day handover (which covered through
#223 + the #224 doc refresh). The full pre-#225 history — the
citation-table arc slices 1–4c (#212–#217), the test-infra split
(#218/#219), the polish Slices A/B (#221/#222), and the agent-py AI-SDK
translator (#223) — is in the git log and the earlier handoffs; this doc
focuses on **what shipped after #224** and the live menu.

---

## Shipped this session (all squash-merged to `dev`)

| PR | Slice | dev commit | Title |
|---|---|---|---|
| #225 | citation-table polish C | `c6d8408` | row-remove affordance (×Row) |
| #226 | citation-table polish D | `743cdb8` | in-place citation editing |
| #227 | citation-table polish E | `e066862` | drag-to-reorder columns |

Each slice ran the full **superpowers** loop (brainstorm → spec → plan →
subagent implement → review → PR). Specs in
`docs/superpowers/specs/2026-06-14-citation-{row-remove,cell-editing,column-reorder}-design.md`;
plans alongside in `docs/superpowers/plans/`.

### What each slice did (detail is in the specs — summary only)

- **#225 (C, ×Row):** trailing per-row `×` actions cell in editable
  mode, wiring the already-tested `removeRow` helper. Sort-safe (uses
  the original row index); clears any in-progress edit before removal.
  One-file UI change.
- **#226 (D, citation editing):** citation chips are now editable.
  Added `Citation` type + pure `addCitation`/`updateCitation`/
  `removeCitation` helpers; new `components/panels/citation-cell-editor.tsx`
  turns each `[n]` chip into an edit-popover (native source `<select>` +
  quote `<textarea>` + Remove) with a `+ cite` add affordance.
  Existing-sources-only; commit-on-change/blur (no Save button);
  index-based chip keys keep the popover open across a source change.
- **#227 (E, column reorder):** pure `moveColumn(data, from, to)` helper
  (permutes the `columns` array; cells follow via columnId keys; sort
  state survives) + a per-header `⠿` drag grip (the sole draggable
  element, a sibling of the sort button) with HTML5 drop on the `<th>`
  and a drop-target highlight. Native DnD ⇒ **not keyboard-accessible**
  (explicitly deferred).

### Citation-table code map (updated; for follow-ups)

- `lib/shared/artifacts/citation-table.ts` — data model + **all pure
  helpers** (now: `parseCitationTable`, `sortRowOrder`, `sourceIndex`,
  `setCellValue`, `addRow`/`removeRow`, `addColumn`/`removeColumn`/
  `moveColumn`, `addCitation`/`updateCitation`/`removeCitation`) and the
  exported `Citation` type. All pure, never-mutate, return `data` by
  reference on no-op — fully unit-tested in `citation-table.test.ts`.
- `lib/shared/artifacts/extract-table.ts` — extraction schema + prompt
  builder (accepts `columnHints`).
- `lib/shared/artifacts/citation-table-md.ts` — MDX round-trip +
  `CITATION_TABLE_KEY` (single source of truth for the node/plugin/MDX
  tag).
- `lib/shared/artifacts/citation-table-slash.ts` — slash-insert items.
- `components/panels/citation-table.tsx` — `CitationTableView`
  (read-only without `onChange`, editable with it). Owns the table
  render, sort, value-editing, add/remove row+column, `×Row`/`×Column`,
  and the **column drag-reorder** (header grip + `dragFrom`/`dragOver`
  state).
- `components/panels/citation-cell-editor.tsx` — editable-citation UI
  (edit-popover per chip + `+ cite` add-popover). **New in #226.**
- `components/panels/extract-table-popover.tsx` — column-hint chip
  picker.
- `components/ui/citation-table-node.tsx` — the editable void Plate node
  (the embedded editor-doc copy; mirrors the Artifacts-tab table via
  `onChange → updateArtifactContent`, so every polish slice appears in
  both places for free).
- `components/editor/plugins/citation-table-kit.tsx` /
  `markdown-kit.tsx` — plugin registration + MDX serialize rules.
- `components/editor/transforms.ts` — `insertCitationTable`.
- `app/api/extract-table/route.ts` — the extraction endpoint.

---

## Test infrastructure — READ THIS before touching tests or CI

**The root test run is split.** `bun run test` runs
`scripts/run-tests.sh` (added in #218), **not** a bare `bun test`. Two
reasons, both unavoidable:

1. **Process-global `mock.module` leak.** The task-route tests under
   `app/api/tasks/` register process-global mocks for several
   `@/server/*` modules; bun **cannot restore module mocks**
   (`mock.restore()` does not undo `mock.module` — verified), so in a
   single process they leak into and break
   `lib/server/image-storage.test.ts` and
   `lib/server/model-provider.test.ts`. The runner isolates
   `app/api/tasks/` in its own `bun test` process.
2. **`services/` must not be swept in** (no workspaces → agent-ts deps
   aren't installed at root; agent-ts/agent-py have their own CI jobs).

**Gotchas:**
- bun positional filters are **substring** matches → paths must be
  `./`-anchored.
- bun has **no exclude flag** → the runner hand-enumerates roots
  (`ISOLATED="./app/api/tasks"`,
  `MAIN_ROOTS=(./app/api/ai ./components ./lib ./scripts ./tests)`) and a
  **coverage guard** fails if any `*.test.ts` outside
  `node_modules/`/`services/` sits outside those roots. **Add a new
  top-level test dir to `MAIN_ROOTS`** or the guard fails by design.
- An `error: postgres unreachable` trace from `route.handler.test.ts:240`
  during `bun run test` is an **intentional throw inside a passing
  test** — not a failure. Counts stay `0 fail`.
- A new test that global-`mock.module`s a shared `@/server/*` module
  risks the same leak — isolate it.

Design/plan: `docs/superpowers/specs/2026-06-14-root-test-runner-split-design.md`,
`docs/superpowers/plans/2026-06-14-root-test-runner-split.md`.

---

## How work is run this session (the loop)

The user drives a strict **superpowers** flow per feature:
1. `brainstorming` → spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, commit. **HARD-GATE: design approved before any code.**
2. `writing-plans` → plan to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, commit.
3. `subagent-driven-development` (user picks "1"): fresh implementer
   subagent per task → review. For **trivial pure-helper tasks** the
   controller verifies inline and reserves a full **combined
   spec+quality review subagent** for the substantive UI task — this is
   the proportionate pattern used for C/D/E.
4. `finishing-a-development-branch` → user picks **"2" (push + PR into
   `dev`)**.
5. After PR creation, a `Monitor` polls `gh pr checks <N>` until all
   five jobs (`ci`, `agent-py`, `agent-ts`, `app-tests`,
   `agent-py-types-drift`) are non-pending. (`ci` is the slow one —
   build + bundle audit.) The GitHub MCP `subscribe_pr_activity` tool is
   **not** connected this session.
6. User merges → cleanup: `git checkout dev && git pull --ff-only &&
   git branch -d <branch>` (remote auto-deletes; `-d` warns "not merged
   to HEAD" because of the squash — expected, the branch IS merged via
   the squash commit).

Branch naming: `feat/...`, `fix/...`, `ci/...`, `docs/...`. Commit
trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
Local gate before pushing: `bun run check`. For agent-py changes also
`bun run check:agent-py` (its CI runs `ruff format --check` separately).

> **Manual browser verification** of the citation-table UI was NOT run
> by the agent for C/D/E (it needs a generated citation-table artifact
> via the AI gateway). Each PR's Test Plan lists the manual pass as an
> unchecked reviewer/user step; the logic is TDD-covered and the UI is
> review- + gate-verified. If picking up more citation-table UI work,
> a real browser pass over the accumulated affordances is worth doing.

---

## Next steps (menu the user has been choosing from)

### Remaining citation-table polish (the same arc)
- **Persisted sort order** — sort is view-state only; persist into the
  artifact content so it survives reload (touches the persisted-shape
  contract — be careful).
- **Undo/redo** — cross-cutting over the now-rich edit surface
  (value/citations/rows/columns/order).
- **Column types** — typed columns (text/numeric/link/date) so
  `addColumn` enforces a value kind, sort respects type, and the extract
  prompt can be steered. Largest remaining item (schema + prompt + sort
  + UI).
- **Row drag-reorder** — the row analogue of #227 (would need a
  `moveRow` helper; rows are positional, so cells move with the row).
- **Keyboard-accessible column reorder** — close the native-DnD a11y gap
  left by #227 (arrow-key or move-left/right buttons reusing
  `moveColumn`).

### Other arcs
- **agent-py deferred gaps** (from the translator spec's out-of-scope):
  reverse Anthropic→AI-SDK translator, cancellation propagation through
  the SDK call (`runner.py` `RunStepContext.signal` placeholder), MCP
  stdio transport, real-DNS rebinding test, fixture round-trip suite.
  See `docs/PLAN-agent-api.md`.
- **More cross-product features** from
  `docs/PLAN-cross-product-inspirations.md` (§9 citation-tables is
  feature-complete; other sections remain).
- **Pre-existing lint warnings:** 9 warnings — 8 `Unused eslint-disable
  directive` in `services/agent-ts/*` (poller.ts/server.ts) + 1
  `_omitModel` in `app/api/summarize/route.ts`. Harmless; a tidy-up if
  desired.

---

## Known-good baseline at handover

- `bun run check` is **green end-to-end** on `dev` — typecheck 0 errors;
  lint 0 errors (the 9 pre-existing warnings above are unrelated to the
  changed files); split test run **52 + 1269 = 1321 pass / 0 fail**
  (count grew with the new helper tests across C/D/E).
- `bun run check:agent-py` was untouched this session (no agent-py
  changes); last green at 531 tests / 0 fail (per the prior handover).
- Working tree on `dev` is clean; 0 commits ahead of `origin/dev`; no
  feature branches in flight.
- All five CI jobs pass on the latest merged PR (#227).

---

## Suggested skills for the next agent

- **`superpowers:using-superpowers`** first (it self-loads at session
  start) — then for any new feature: **`superpowers:brainstorming`** →
  **`superpowers:writing-plans`** → **`superpowers:subagent-driven-development`**
  → **`superpowers:finishing-a-development-branch`**, mirroring the loop
  above. The user reliably picks subagent-driven execution and
  "push + PR into `dev`".
- **`superpowers:test-driven-development`** for any new pure helper
  (the citation-table helpers are the template: pure, never-mutate,
  return `data` by reference on no-op, one `describe` per helper).
- **`handoff`** at the next clean stopping point to refresh this doc.
