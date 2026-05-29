# Plan: Code cleanup

Status: **🪜 Phase 1 shipped** (PR #96: 6 baseline lint warnings
cleared, 4 truly-dead exports removed, `useMemo` wrapping on
`use-attached-context.ts` defaults). Phases 2–6 planned.

A focused housecleaning pass across the codebase after a long stretch
of feature work. Goal: improve maintainability without changing user-
visible behavior. Each phase is its own PR.

## Why

The repo has grown to ~74k LOC across 433 source files. Most of the
growth is concentrated in a handful of files that the past year of
features kept piling into:

| File | LOC | Concern |
|---|---|---|
| `lib/client/hooks/use-store.ts` | 3445 | 184 mutators + 28 selector hooks in one file. Hard to navigate, hard to test in isolation, every PR touches it. |
| `components/panels/chat.tsx` | 1870 | The send pipeline, drag-and-drop, smart paste, slash commands, prompt mentions, attachment plumbing — all in one panel. 37 handlers, 26 hook calls. |
| `lib/client/sync/handlers.ts` | 1118 | Diff logic for ~12 entities, hand-rolled, mostly **untested** (only `prompts` has a 108-line test file). The sync layer is the durability story; silent diff bugs are easy to introduce when a new entity field lands. |
| `lib/client/sync/reconcile.ts` | 1048 | Same pattern repeated per-entity (fetch → check error → map → return → bulk-upload → applyCloudSnapshot). Begging to be factored. |
| `app/api/chat/route.ts` | 904 | Model dispatch, skills, file content prep, retries — all inline. |
| `components/panels/skills-tab.tsx` | 1243 | Per-skill config UI for four skills in one file. |
| `components/panels/chat-message.tsx` | 703 | Hover actions, edit-in-place, regenerate, copy, send-to-editor, bookmark — fine for now but watch for further growth. |

Architecture fences (`@/client` / `@/server` / `@/shared`) are clean —
no leakage of server-only modules into the browser bundle today.
That's the foundation; the work below is everything inside the fences.

Other signals worth naming:

- **Six baseline lint warnings** (3 unused identifiers + 3
  `react-hooks/exhaustive-deps`) we've been carrying for weeks.
- **~20 `: any` / `as any` usages** — some legitimate (Plate.js types
  the editor leaks), others avoidable (e.g. `sync-queue.ts`'s
  `row as any`).
- **4 TODO markers** (clean overall — one real TODO in
  `components/ui/block-discussion.tsx`).
- **Sync layer testing is the biggest coverage gap** —
  `diffWorkspaces`/`diffConversations`/`diffMessages`/etc. are pure
  functions with no tests beyond `prompts`. Easy to harden.

## Goal & scope cuts

**This cleanup ships:**

- A clean lint baseline (0 warnings).
- Test coverage for every sync diff helper.
- `use-store.ts` split into per-entity slice files (composed into one
  store; persisted-state and migration story unchanged).
- `chat.tsx` send pipeline extracted into a hook; the panel becomes a
  thinner render layer.
- A small refactor of `reconcile.ts` to deduplicate the per-entity
  fetch/map/upload pattern.
- A dead-code sweep — verified-unused exports, files, and migration
  references removed.

**Out of scope (deliberately):**

- New features.
- Visual / UX changes.
- Behavior changes (each phase must be verifiable via the existing
  test suite + dev-server smoke).
- A test-coverage push beyond the sync layer (high-leverage; the
  other surfaces can come later).
- Bundle-size optimizations (separate concern; `bun run audit:bundle`
  already exists).
- Touching the Plate.js editor's `as any` usage — those leak from
  Plate's own typings.

## Phases

Each phase is a separate PR off `dev`. Constraint: **no functional
changes**. Verification across all phases: `bun run check` clean,
`bun test` green, dev server compiles, the app's golden paths still
work in the browser.

### Phase 1 — Quick wins ✅ shipped (#96)

Shipped:

- Cleared all 6 baseline lint warnings:
  - `components/csv-viewer/csv-viewer.tsx:15` — dropped unused
    `useMemo` import.
  - `components/panels/chat.tsx:1065` — added the missing
    `appendMessageGeneratedImages` + `createArtifact` to the
    `useCallback` deps array.
  - `components/panels/skills-tab.tsx:1142` — deleted the unused
    `Segment` component.
  - `lib/client/hooks/use-attached-context.ts:100,101` — wrapped the
    `selectedUrlBookmarkIds` / `selectedMcpResourceIds` defaults in
    their own `useMemo` so the empty-array fallback doesn't bust the
    outer memo on every render.
  - `lib/server/skills/image-gen.ts:29` — dropped the unused
    `DEFAULT_IMAGE_GEN_ASPECT_RATIO` import.
- Removed 4 truly-dead exports verified by repo-wide reference scan:
  - `lib/shared/canvas/types.ts` — `PROJECTED_NODE_KINDS` (no
    consumers since the projection refactor).
  - `lib/shared/skills/types.ts` — `SkillIntent` type +
    `getConversationIntent` function (the tri-state intent surface
    was simplified away earlier).
  - `lib/shared/skills/registry.ts` — `getSkill` (every caller uses
    the registry array directly).

Not done in Phase 1 (deferred):

- `lib/client/sync/sync-queue.ts:189` `row as any` — already gated by
  an explicit `eslint-disable`; removing cleanly needs per-`SyncTarget`
  typed branches around Supabase's generic `from()`. Folded into the
  Phase 3 reconcile factor-out scope.
- `components/ui/block-discussion.tsx:341` TODO — Plate.js editor
  internals, out of scope.

Verification: `bun run typecheck` 0 errors; `bun run lint` 0
warnings (down from 6); `bun test` 559 pass; dev server compiles
`/dashboard` → 200.

### Phase 2 — Sync layer test coverage (≈ 1 day)

Pure-function tests for every `diff*` helper in
`lib/client/sync/handlers.ts`. The sync layer is the durability story
and currently the most under-tested critical code path.

- One test file per entity (`handlers.workspaces.test.ts`,
  `handlers.conversations.test.ts`, etc.) — table-driven, covering:
  add / update / delete / no-op / move-with-position-renumber where
  applicable.
- Coverage matrix in the PR description so it's easy to audit what
  was added.
- No behavior changes — these are characterization tests that lock
  in current diff behavior. If a test reveals a bug, file it as a
  follow-up (don't fix in this PR; functionality goal stands).

Verification: `bun test` green; test count visibly grows by a few
dozen.

### Phase 3 — Reconcile factor-out (≈ half day)

The per-entity reconcile flow in `reconcile.ts` repeats ~12 times:

```ts
const xRes = await db.from("x").select("*").eq("user_id", uid)
if (xRes.error) return { ok: false, error: ... }
const x: X[] = (xRes.data ?? []).map(rowToX)
// ... bulk upload similarly repeats
```

Extract a generic `fetchEntity(query, mapRow)` and
`bulkUpload(table, rows)` helper. The reduction in surface area
should make adding a new entity smaller and harder to get wrong.

Verification: tests green; reconcile snapshot before/after is
byte-equivalent on a seeded fixture.

### Phase 4 — Store slice split (≈ 2 days, higher risk)

Break `use-store.ts` into per-entity slice files, composed in one
top-level store. Persisted state, `partialize`, and the localStorage
migration story stay intact — the goal is purely organisational.

Proposed structure:

```
lib/client/hooks/store/
  index.ts                 // composes slices into the persisted store
  types.ts                 // shared store types
  slices/
    workspaces.ts          // mutators + selectors for workspaces
    conversations.ts       // ...
    messages.ts
    files.ts
    resources.ts
    artifacts.ts
    notes.ts
    project-tasks.ts
    prompts.ts
    mcp.ts
    canvas.ts
    ui.ts                  // panel visibility, theme, modals
    misc.ts                // anything that doesn't fit cleanly
```

Each slice exports a factory `(set, get) => ({ ... })`. The top-level
`useStore` composes them. Selector hooks (`useActiveWorkspace`, etc.)
live next to their slice.

Risks:

- Subtle TypeScript inference issues across slice boundaries — keep
  cross-slice mutator calls (e.g. `deleteWorkspace` cascading into
  `projectTasks`) explicit by passing `get()` to the affected slices'
  helpers.
- localStorage shape stays identical (no version bump). Test by
  hydrating from a captured pre-split snapshot.

Verification: tests green; dev-server smoke against a hydrated
existing localStorage; import-from-disk smoke (compare `useStore.getState()` 
before and after on a fixture).

### Phase 5 — Chat panel extraction (≈ 1 day)

Pull the send-pipeline out of `chat.tsx` into a hook
(`lib/client/hooks/use-chat-send.ts`):

- Effective skills resolution (already partly done — uses the shared
  `resolveEnabledSkills` helper from project-mode Phase 4).
- Attachments collection (workspace + conversation files, images).
- The `transmittedHistory` build + `buildMessages` closure.
- The task vs inline-stream branch and the controller / abort
  bookkeeping.

Also extract:

- Smart-paste detection + chip into a dedicated hook
  (`use-smart-paste`) — already half-isolated.
- Drag-and-drop file ingestion into `use-chat-dropzone` if it cleans
  up nicely.

The panel becomes a render layer over these hooks. Target: drop
`chat.tsx` under 1000 LOC.

Verification: tests green; manual interactive checklist (the existing
send-with-attachments, regenerate, retry, edit-and-resend, task mode).

### Phase 6 — Dead code sweep (≈ half day)

After the structural phases, do a verified pass for:

- Unused exports — manual or via `knip` / `ts-prune`. Confirmed-dead
  ones get deleted.
- Migration files referenced nowhere — none today, but verify after
  the slice split moves imports around.
- `// removed`-style placeholder comments and any stub files left
  from earlier refactors.

Verification: `bun run check` clean; `bun run audit:bundle` size
stable or smaller.

## Verification

Per-phase verification is in each phase above. The cumulative bar:

1. `bun run check` clean (typecheck + lint, 0 warnings).
2. `bun test` green at every phase.
3. Dev-server compile-smoke passes on each PR.
4. localStorage migrates from a pre-cleanup snapshot without data
   loss.
5. The four feature groups that exercise the most code — chat send
   (incl. attachments + skills), long-running tasks (run +
   resume-on-reload), project mode (Kanban + Run-as-task), canvas —
   all still pass their existing manual checklists.

## Out of scope

- New features.
- Behavior changes.
- Test coverage push beyond the sync layer (separate plan if we want
  it).
- Bundle-size or perf work (separate plan).
- Editor (`components/editor/**`) refactoring — Plate.js leaks
  loosely-typed APIs that aren't worth wrapping yet.
- API route refactoring — `chat/route.ts` is the obvious next
  candidate but it's its own focused effort (similar shape to
  Phase 5: extract the prep / dispatch / response-build steps).
