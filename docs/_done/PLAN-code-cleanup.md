# Plan: Code cleanup

Status: **✅ All six phases shipped** (#96 Phase 1; #102 for Phases
2–6). Sync layer is now tested per-entity, reconcile's per-entity
upsert pattern is factored, pure helpers came out of `use-store.ts`,
the auto-archive heuristic came out of `chat.tsx`, and the lint
baseline + dead-export sweep are complete. The heaviest structural
splits — the full `use-store.ts` slice split and the full `chat.tsx`
send-pipeline extraction — were deliberately scoped down here and
each shipped as its own focused follow-up plan:
[`_done/PLAN-store-slice-split.md`](PLAN-store-slice-split.md) (#115)
and [`_done/PLAN-chat-send-extraction.md`](PLAN-chat-send-extraction.md)
(#112 / #113). Originally lived at `docs/PLAN-code-cleanup.md`; moved
here on completion per the archive convention in
[`MASTER_PLAN.md`](../MASTER_PLAN.md).

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

### Phase 2 — Sync layer test coverage ✅ shipped (#102)

Added per-entity test files covering every `diff*` helper in
`handlers.ts`: workspaces, documents, conversations (+ messages),
files, resources, conversation_files, mcp_servers, mcp_resources,
mcp_resource_bindings, conversation_mcp_resources, url_bookmarks,
conversation_url_bookmarks, notes, artifacts, project_tasks
(prompts already had a file). Test count went from 559 → 633
(+74 sync diff tests across 15 new files). Characterisation only —
no behaviour change.

Original plan text follows for archival.



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

### Phase 3 — Reconcile factor-out ✅ shipped (#102)

Extracted two helpers into `reconcile.ts`:
- `uploadRows(client, table, rows)` — wraps the per-entity
  `if length > 0; await upsert; if error return labelled error`
  pattern used 13 times in `bulkUploadLocalState`. Adding a new
  entity is now a one-call addition rather than copying four
  lines. Contains the `as never` Supabase-generic escape hatch
  (mirrors `sync-queue.ts:189`).
- `anyError(results)` — replaces a 17-line `xRes.error || …` chain.

LOC bumped 1048 → 1113 (the wrapper braces cost a small amount)
but the upsert + error pattern lives in one place now.

Original plan text follows for archival.



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

### Phase 4 — Store helper extraction ✅ shipped (#102) · slice split still pending

Scoped down from the full per-entity slice split — combining a
≈2-day high-risk refactor with the rest of this PR was too much
through one review. Instead this commit extracts the pure helpers
into `lib/client/hooks/store-helpers.ts`:

- `clampSidebarWidth` / `clampResourcesSidebarWidth` + constants
- `defaultSlug` + `ensureUniquePromptSlug` (prompt slug machinery)
- `tombstoneMcpServer`
- the four `merge*Config` deep-merge helpers

Plus a 20-test characterisation file. `use-store.ts` shrank
3445 → 3274 (−171 LOC).

**Follow-up — now has its own plan:** the full per-entity slice split
(workspaces, conversations, messages, files, …) is specced in
[`PLAN-store-slice-split.md`](PLAN-store-slice-split.md). The
persistence model + the cross-slice cascade contract (which make the
bulk split tricky) are unchanged.

Original plan text (target end-state) follows for archival.



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

### Phase 5 — Chat panel extraction ✅ shipped (#102) · send-pipeline extraction still pending

Scoped down for the same reason as Phase 4 — the full send-pipeline
extraction is ~600 LOC with ~40 closure dependencies and benefits
from its own focused review. This commit extracts the
auto-archive heuristic — a cleanly-bounded subsystem with no live
store reads — into `lib/client/chat/auto-archive-code-blocks.ts`
plus a 7-test characterisation file. `chat.tsx`: 1872 → 1846
(−26 LOC).

**Follow-up — shipped (its own plan):** pulling `callChatAPI` into a
`useChatSend` hook, plus the attachment build, smart-paste, and the
drag-and-drop file ingestion, was specced and completed in
[`PLAN-chat-send-extraction.md`](_done/PLAN-chat-send-extraction.md).

Original plan text follows for archival.



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

### Phase 6 — Dead code sweep ✅ shipped (#102)

Removed `export type ApiClient = typeof apiClient` from
`lib/client/api-client.ts` — verified orphan. Phase 1's earlier
sweep had already caught the bigger dead-export wins, so this
residual pass was modest. Patterns reviewed but not removed
(reasons captured in the commit): public API contract types
inferred from Zod schemas (kept as documentation surface),
internal types used only within their own declaration file (export
is harmless), and the two earlier-deferred Phase 1 items
(`sync-queue.ts:189` `as any` is intentionally gated; the
Plate.js TODO is upstream).

Original plan text follows for archival.



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
