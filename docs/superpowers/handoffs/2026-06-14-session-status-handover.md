# Session Status — Handover (2026-06-14, end of day)

**Status:** 🟢 At a clean stopping point. Three arcs landed on `dev` today (citation-table polish Slice A + B, agent-py AI-SDK → Anthropic wire translator) plus the test-infra CI fix (app-tests job). All 4 PRs merged. Local gates green. No branches in flight.

This is a broad session handover (not one feature) so a later agent can pick up. It records what shipped, the test-infra context that's easy to trip over, and the menu of next steps.

---

## Shipped today (all squash-merged to `dev`)

| PR | Arc | dev commit | Title |
|---|---|---|---|
| #218 | test infra | `d1f753c` | Split root `bun test` to fix pre-existing suite failures |
| #219 | test infra | `2718c3c` | `ci: run the app test suite on every PR (app-tests job)` |
| #221 | citation-table polish (Slice A) | `cd8ae94` | `feat(extract-table): chip-list picker for column hints` |
| #222 | citation-table polish (Slice B) | `1d1dba0` | `feat(citation-table): inline add/remove row and column affordances` |
| #223 | agent-py gap fix | `d2a707f` | `feat(agent-py): AI-SDK → Anthropic block translator` |

The earlier-PRs table (citation-table arc slices 1–4c, #212–#217) is in the archived handoffs if you need it; this doc covers **today** only.

### What each PR did

- **#218 + #219** — the root test runner is now split (`bun run test` runs `scripts/run-tests.sh`, not a bare `bun test`), and a new parallel `app-tests` CI job runs the split suite on every PR. Both stacks (Next.js app + agent-py / agent-ts) are now gated on every PR.
- **#221 (Slice A)** — optional `columnHints: string[]` on the extract request, threaded through the prompt builder. New `ExtractTablePopover` component (Radix Popover + chip-list picker pre-seeded from source titles) wraps the existing "Extract to table" button. "Let the model decide" preserves the prior "I just want to extract" path.
- **#222 (Slice B)** — 4 new pure helpers (`addRow`, `addColumn`, `removeRow`, `removeColumn`) + 3 UI affordances on `CitationTableView` (`+ Row` footer, `+ Column` header, column `×`). The embedded Plate copy mirrors the Artifacts-tab table automatically because the node already wires `onChange` to `updateArtifactContent`.
- **#223** — `executor.py` `_messages_from` now translates AI SDK v5 content blocks (`tool-call`, `tool-result`, `image`, `file`, `reasoning`) and `role: 'tool'` messages into Anthropic shape. Cross-stack resumes (TS-suspend → Python-resume) keep their tool context. Same-stack Python resumes remain byte-identical (regression-guarded by a dedicated test).

### Citation-table code map (for follow-ups)

- `lib/shared/artifacts/citation-table.ts` — data model + `parseCitationTable`, `sortRowOrder`, `setCellValue`, `sourceIndex` (pure, tested).
- `lib/shared/artifacts/extract-table.ts` — `ExtractionSchema` + `extractionToCitationTable` + prompt builder (Slice 2). Now also accepts `columnHints` (Slice A).
- `lib/shared/artifacts/citation-table-md.ts` — MDX round-trip helpers + `CITATION_TABLE_KEY` (Slice 4a). **Single source of truth** for the node type / plugin key / MDX tag.
- `lib/shared/artifacts/citation-table-slash.ts` — `buildCitationTableSlashItems` (Slice 4c).
- `components/panels/citation-table.tsx` — `CitationTableView` (read-only without `onChange`, editable with it). Slice B added `addRow` / `addColumn` / column `×` affordances.
- `components/panels/extract-table-popover.tsx` (new in Slice A) — the chip-list picker.
- `components/ui/citation-table-node.tsx` — the editable void Plate node (4a/4b).
- `components/editor/plugins/citation-table-kit.tsx` — the plugin (registered in `editor-kit.tsx`).
- `components/editor/plugins/markdown-kit.tsx` — the MDX serialize/deserialize rules (additive; no `code_block` override).
- `components/editor/transforms.ts` — `insertCitationTable` (4c).
- `app/api/extract-table/route.ts` — the extraction endpoint (Slice 2; now reads `columnHints`).

### Agent-py translator code map (for follow-ups)

- `services/agent-py/src/agent_py/executor.py` — `_messages_from` (the dispatcher), `_normalise_content_blocks` (now a 4-line wrapper), `_translate_block` + 4 sub-translators (`_translate_image_block`, `_translate_file_block`, `_translate_tool_call_block`, `_translate_tool_result_block`), `_translate_ai_sdk_message`, `_warn_unknown_block_kind`, `_REDACTED_THINKING_SENTINEL`, `_warned_unknown_block_kinds` (process-local set).
- `services/agent-py/tests/test_executor_wire_translator.py` (new) — 20 unit tests covering every spec table row + 1 warn-once test.

The translator is the canonical path for every message: same-stack Python resumes are byte-identical (Anthropic-shape blocks pass through), cross-stack resumes now keep their tool context.

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

## How work was run today (the loop)

Every feature followed the **superpowers** flow, and the user drove it:
1. `brainstorming` skill → design → write spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, commit. **HARD-GATE: design approved before any code.** Ask the user to review the spec.
2. `writing-plans` skill → plan to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, commit.
3. Execution: usually `subagent-driven-development` (the user picks "1") — fresh implementer subagent per task, then spec-compliance + code-quality review subagents; for tiny tasks a single combined review is proportionate.
4. `finishing-a-development-branch` → the user almost always picks **"2 (push + PR into `dev`)"**.
5. After PR creation, the next agent polls `gh pr checks <N>` until all are non-pending (the GitHub MCP `subscribe_pr_activity` tool is **not** connected this session).
6. User merges → cleanup: `git checkout dev && git pull --ff-only && git branch -d <branch>` (remote auto-deletes on merge; force-delete with `-D` if cherry-picked SHAs differ from the merge commits).

Branch naming: `feat/...`, `fix/...`, `ci/...`, `docs/...`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

Local gate before pushing: `bun run check` (typecheck + lint + the split test run). For agent-py changes also `bun run check:agent-py` (its CI runs `ruff format --check` as a separate step).

---

## Next steps (menu the user has been choosing from)

### Agent-py deferred gaps (from the translator spec's "Out of scope" section)

- **Reverse Anthropic → AI SDK translator** (covers "Python-suspends, TS-resumes" on the same checkpoint). The chat route's streaming translator at `chat.py:563-610` covers the streaming wire path but not the message-array path.
- **Cancellation propagation through the Anthropic SDK call** (`runner.py:30-37` — `RunStepContext.signal` is still a placeholder; the SDK now blocks long enough to need it).
- **MCP stdio transport** (`mcp_client.py:9`).
- **Real-DNS rebinding test** (`PLAN-agent-api.md:52-55`).
- **Fixture round-trip suite** (recorded TS-runner events replayed through the Python runner; would have caught the AI-SDK → Anthropic gap earlier).

### Citation-table polish follow-ups (deferred from the polish spec)

- **Row-remove UI button** (the `removeRow` helper exists, the button is a 5-line follow-up).
- **Editing citations in place** (citation chips are read-only today).
- **Persisted sort order** (currently view-state only).
- **Undo/redo**.
- **Column reordering** (drag the headers).
- **Column types** (numeric / link / date — would let `addColumn` enforce a value kind and feed the prompt).

### Other

- **Pre-existing lint warnings:** 9 `Unused eslint-disable directive` warnings in `services/agent-ts/*` (poller.ts/server.ts) — harmless, but a tidy-up if desired.
- **More cross-product features** from `docs/PLAN-cross-product-inspirations.md` (beyond §9, which is now complete).

---

## Known-good baseline at handover

- `bun run check` is **green end-to-end** on `dev` (typecheck + lint 0 errors; split test run 52 + 1304 pass / 0 fail). PR #222 was the last to push test additions; #223 was agent-py only and the agent-py gate is `bun run check:agent-py` (531 tests, 0 fail).
- `bun run check:agent-py` is **green end-to-end** (ruff check + **ruff format --check** + mypy + pytest, 531 tests, 0 fail). The 20 new translator tests live here.
- Working tree on `dev` is clean; 0 commits ahead of `origin/dev`. No branches in flight.
- All 4 CI jobs (`ci`, `agent-py`, `agent-ts`, `app-tests`) pass on the most recent merged PRs.
