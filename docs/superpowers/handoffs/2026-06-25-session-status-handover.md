# Session handover — 2026-06-25

**Status:** Clean stopping point. Five features shipped and merged to
`dev` this session: generated files → file-URL refresh (chips) →
artifact-tab URL refresh → non-destructive edit/regenerate → artifact
version history + diffs. The generated-asset URL-expiry story is closed
(chips + artifacts, files + images). No branches in flight, no work
mid-stream.

## What shipped this session

**1. Generated files from the code interpreter.** The `runCode`
sandbox now captures arbitrary files the model writes to `/tmp/outputs/`,
surfaces them as download chips in the assistant message, and persists
them as workspace-scoped `file` artifacts (Artifacts tab). Design mirrors
the existing generated-**images** pipeline end to end.

- **PR:** https://github.com/juchengquan/hummingbird/pull/265 — **merged**
  to `dev` (merge commit `96621dd`). All 5 CI checks were green.
- **Spec:** `docs/superpowers/specs/2026-06-25-generated-files-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-25-generated-files-capture.md`
  (15 tasks across 3 slices; full code + tests per task).

**2. File-URL refresh on click.** Generated-file download chips now
transparently re-sign an expired Supabase signed URL when clicked
(anchors have no `onError`, so it re-signs on click instead). Mirrors the
image refresh path. This closes follow-up #2 from the earlier version of
this handoff.

- **PR:** https://github.com/juchengquan/hummingbird/pull/267 — **merged**
  to `dev` (merge commit `ff45d3d`). All 5 CI checks were green.
- **Spec:** `docs/superpowers/specs/2026-06-25-file-url-refresh-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-25-file-url-refresh.md`
  (5 tasks). Re-added `signGeneratedFileUrl`; added `POST /api/files/refresh-url`
  (with a 403 owner-check), `RefreshFileUrl*` schemas,
  `apiClient.files.refreshUrl`, `updateMessageGeneratedFileUrl`, and the
  chip click-intercept. Scope was chips-only at the time — the artifact
  surface was closed next (#3).

**3. Artifacts-tab URL refresh (file + image).** The Artifacts-tab
download (`file`) and preview (`image`) now self-heal an expired signed
URL too. Approach: **derive** the durable object path from the stored
signed URL (a pure `parseStorageObjectPath` in `lib/shared/storage-url.ts`)
and re-sign via the existing refresh endpoints — so **no new
route/schema/migration**, and it repairs *already-existing* artifacts, not
just new ones. Also extracted `triggerDownload` to `lib/client/download.ts`
(shared by chip + artifact) and added `updateArtifactStoragePath`.

- **PR:** https://github.com/juchengquan/hummingbird/pull/272 — **merged**
  to `dev` (merge commit `fd05de5`). All 5 CI checks were green.
- **Spec:** `docs/superpowers/specs/2026-06-25-artifact-url-refresh-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-25-artifact-url-refresh.md` (6 tasks).

**4. Non-destructive edit/regenerate (conversation branching).** Editing a
user message / regenerating an assistant reply used to truncate the thread
in place (destructive). Now both **fork** the conversation (original
preserved) and continue on the fork, reusing the existing `forkConversation`.
Discovery: branching was *mostly already built* — the fork action, lineage
fields (`parentId`/`forkedFromMessageId`), sync, AND the viewer dialog
(`components/branches-dialog.tsx` + `lib/shared/branches/tree.ts`) all
pre-existed; the real gap was the destructive edit/regenerate. Added a
`forkConversation` `titleSuffix` (`(edit)`/`(retry)`), pure
`forkTargetFor{Edit,Regenerate}` helpers, and an opt-in
`SendOptions.targetConversationId` (see lesson below). No data-model change.

- **PR:** https://github.com/juchengquan/hummingbird/pull/276 — **merged**
  to `dev` (merge commit `51bbfc6`). All 5 CI checks were green.
- **Spec:** `docs/superpowers/specs/2026-06-25-conversation-branching-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-25-conversation-branching.md` (5 tasks).

**5. Artifact version history + diffs.** Editing an artifact's content was
destructive (`updateArtifactContent` replaced in place). Now each edit
snapshots the prior content into a capped `Artifact.versions` array
(`MAX_ARTIFACT_VERSIONS = 10`); the artifact dialog has a History panel
(version list → line diff → non-destructive Restore via
`restoreArtifactVersion`). Pure LCS diff (`lib/shared/artifacts/diff.ts`,
no new dep — `diff-match-patch-ts` is transitive-only). Migration `0029`
+ sync; **no `STORE_VERSION` bump** (the field rides inside the persisted
`artifacts` key). The live editable artifact today is the citation table.

- **PR:** https://github.com/juchengquan/hummingbird/pull/280 — **merged**
  to `dev` (merge commit `ce3a716`). All 5 CI checks were green.
- **Spec:** `docs/superpowers/specs/2026-06-26-artifact-versioning-design.md`
- **Plan:** `docs/superpowers/plans/2026-06-26-artifact-versioning.md` (6 tasks).

**Docs/cleanup:** also documented the `tool_image` / `code_result` SSE
frames in `docs/API.md` (#274) and removed the now-dead
`truncateMessagesAfter` action (#278).

Don't re-derive any design or task list — they're in the specs/plans.
The git history on `dev` carries the per-task detail.

## How it was built (process notes worth knowing)

Built via **subagent-driven-development**: a fresh implementer + a
spec-and-quality review subagent per task, then a whole-branch review on
the strongest model, then a fix, then PR. Final tree: typecheck 0, lint 0
errors (9 pre-existing warnings), 1506 tests pass.

Plan deviations the controller corrected mid-flight (all sound — apply
the same vigilance if you extend this work):
- The generated `Database` type (`lib/shared/supabase/types.ts`) needed a
  hand-added `generated_files` column on `messages` (Row/Insert/Update),
  or sync wouldn't typecheck — there's no live DB regen here.
- `file-storage.test.ts` does **not** use `mock.module` (process-global
  leak in the shared `lib/` test run); it exercises the data-URL fallback
  via Supabase being unconfigured in the test env, mirroring
  `image-storage.test.ts`.
- The repo has **no `@testing-library` / `.test.tsx` infra** — components
  are not render-tested. The size formatter `humanSize` is unit-tested
  instead. If you add UI, follow this: extract pure logic and unit-test
  that; don't introduce a render harness without a decision.
- **Git topology drift bit twice — check it after every subagent.** (a)
  A fix subagent committed on the wrong base and orphaned task commits
  from HEAD; recovered via `git reset --hard <true-tip>` + cherry-pick.
  (b) During the #272 run an implementer detached HEAD mid-task, so the
  branch ref stranded at Task 1 while Tasks 2–6 piled onto a detached
  HEAD; caught because `git branch --show-current` came back empty,
  recovered via `git branch -f <branch> <tip>` (the chain was linear).
  **Lesson:** after a subagent runs — and before the final review /
  finish — confirm `git branch --show-current` is non-empty and
  `git log` topology is intact. A truncated/detached tree can still pass
  `bun run check`, so green is not enough.
- **The whole-branch review earns its keep — don't skip it.** On #276,
  every per-task review + typecheck + 1597 unit tests were green, but the
  final review (strong model) found the feature was **broken at runtime**:
  `forkConversation` flips `activeConversationId` in-store, but
  `useChatSend.send` read it from a React-subscribed closure, so the
  fork's reply was routed to the *wrong* conversation. Unit tests can't
  see this (handlers aren't render-tested). Fixed with an opt-in
  `SendOptions.targetConversationId` (resolve via `getState()` only when
  passed; default path unchanged). **Lesson:** integration seams between
  store mutations and subscribed-closure consumers are invisible to unit
  tests — the final review + the (still-unrun) manual smoke test are the
  only nets.

## Open follow-ups (not started — pick up if asked)

1. **Run the manual smoke tests (highest value — none of the five
   features has been manually verified).** Three checkbox runbooks exist:
   **`docs/SMOKE-TEST-generated-files.md`** (generated files + file-URL
   refresh + the 401/403/400 security probes + the artifact self-heal
   step), **`docs/SMOKE-TEST-conversation-branching.md`** (non-destructive
   edit/regenerate + the branches viewer; steps 1/2/5 are exactly what
   would have caught the #276 fork-reply-routing bug), and
   **`docs/SMOKE-TEST-artifact-versioning.md`** (edit a citation table →
   History → diff → restore → cap). The generated-files one needs
   `CODE_SANDBOX_ENABLED=1` + an installed
   microsandbox runtime + Supabase + a signed-in session on a
   microsandbox-capable host — none of which this dev box had, which is
   why it's still un-run.
   - Already verified at runtime (the one slice reachable without
     Supabase): `POST /api/files/refresh-url` mounts and returns `503`
     when Supabase is unconfigured (config-guard before body-parse),
     `405` on `GET`, and is byte-for-byte identical to the image route.
     The runbook covers only what that probe could **not** reach.
   - Note for Test B: refresh is **re-sign-on-click** — the chip re-signs
     on *every* click for a cloud file (one with a `storagePath`), not
     only after expiry. The runbook's expiry assertion is "break the
     stored `url` but keep `storagePath`, click, confirm it still
     downloads."
2. **Remote `services/` refresh route (deferred).** `apiClient.files.refreshUrl`
   declares the remote path `/v1/files/refresh-url`, but it's only
   implemented in the in-Next backend. Remote-backend users need it added
   to agent-ts / agent-py (mirror however `/v1/images/refresh-url` is
   handled there).
3. **JSX indentation drift (cosmetic, deferred).** The wrapped kind-ternary
   in `components/panels/artifacts-tab.tsx` has indentation drift after
   #280's history-panel wrap. Left as-is (lint-clean; a Prettier sweep
   would add noise) — re-indent only if you're already touching that file.

(Closed this session: the `docs/API.md` Frame-protocol gap — `tool_image`
/ `code_result` were undocumented — in #274; the dead
`truncateMessagesAfter` action removed in #278; and two of #280's three
review nits — the `versionsEqual` comment + the runbook icon name — in
#282.)

## Repo orientation (only what wasn't obvious)

- Three interchangeable backends; chat + 4 non-chat endpoints. See
  `services/README.md`. This feature touched only the **in-Next** backend
  (`app/api/chat/route.ts` + `lib/server/**`).
- Tests run via `bun run test` (wraps `scripts/run-tests.sh`, which
  isolates `app/api/tasks` for a `mock.module` leak and excludes
  `services/`). `bun run check` = typecheck + lint (no tests/build).
- SDD scratch (briefs, reports, review packages, progress ledger) lives
  in `.superpowers/sdd/` (git-ignored). The ledger there has the
  per-task commit map if you need to audit this session.

## Suggested skills for the next agent

- **superpowers:brainstorming** — before any new feature/behavior work
  (hard gate: design approved before code).
- **superpowers:writing-plans** → **superpowers:subagent-driven-development**
  — the loop used for both features this session; reuse it for the
  deferred follow-ups (#2 / #3 are each a small, well-scoped plan).
- **verify** / **run** — for follow-up #1, driving the real app to smoke
  test the sandbox + refresh paths.
- **superpowers:finishing-a-development-branch** — to land any branch.
