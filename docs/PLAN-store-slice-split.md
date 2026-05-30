# Plan: Store slice split

Status: **📐 Planned.** No code yet. Spun out of
[`PLAN-code-cleanup.md`](PLAN-code-cleanup.md) Phase 4, which shipped
the low-risk pure-helper extraction (`store-helpers.ts`) and
explicitly deferred the full split to its own focused PR.

A purely organisational refactor of `lib/client/hooks/use-store.ts` —
split the one 3,274-line Zustand store into per-entity slice modules
composed into the same single `useStore`. **No behaviour change, no
persisted-shape change, no API change for any consumer.**

## Why

`lib/client/hooks/use-store.ts` is the single source of in-memory
truth for the whole app: ~180 mutators + 28 selector hooks across one
file. It's grown with every feature.

| Pain | Detail |
|---|---|
| Navigation | Finding "the workspace rename mutator" means scrolling past ~180 unrelated ones. |
| Testability | A slice can't be unit-tested without instantiating the whole store (every entity shares one closure). |
| Merge pressure | Almost every feature PR edits this file → recurring conflicts. |
| Hidden coupling | Because all mutators share one closure, one entity's mutator can reach into another's state with no visible dependency. The cross-entity cascades (e.g. `deleteWorkspace`) are real and need to *stay* explicit. |

The architecture fences (`@/client` / `@/server` / `@/shared`) and the
persistence contract are healthy — this work is entirely *inside*
`use-store.ts`.

## Goal & scope cuts

**This ships:**

- `use-store.ts` broken into per-entity slice factory modules under
  `lib/client/hooks/store/`, composed into one persisted store.
- The persisted localStorage shape, `version` (currently **19**), and
  the `migrate` function stay **byte-for-byte identical**.
- Every existing import keeps working unchanged:
  `useStore`, the 28 `use*` selector hooks, the re-exported types.
- Selector hooks move next to their slice but keep their current
  export path (re-exported from `use-store.ts` so no consumer import
  changes).

**Out of scope (deliberately):**

- Any change to mutator behaviour or signatures.
- Any change to what persists or the migration chain.
- Renaming mutators / selectors.
- Splitting the *sync* layer (already has its own structure +
  per-entity tests from cleanup Phase 2).
- Converting the store to a different state library.

## The hard constraints (why this is risk-rated higher)

1. **Persisted shape is frozen.** Users have months of data in
   `localStorage` under key `hummingbird-storage`, schema `version: 19`.
   `partialize` selects exactly which keys persist; `migrate` walks
   v1→v19. The split must not change a single persisted key name,
   nesting, or the migration output. **Verification: hydrate from a
   captured pre-split snapshot and assert `useStore.getState()` is
   deep-equal to the pre-split baseline.**

2. **Cross-slice cascades must stay correct and explicit.** Several
   mutators touch multiple entities:
   - `deleteWorkspace` → cascades conversations, documents, resources,
     conversationFiles, projectTasks, artifacts, notes, mcp* , url
     bookmarks for that workspace.
   - `deleteConversation` → its messages, conversationFiles,
     conversation-private mcp/bookmark joins, artifacts/notes nulling.
   - `createConversation` / `forkConversation` touch active-id state.
   In a slice world these become a slice calling into sibling slices'
   logic via the shared `get()`. The cascade list has to be enumerated
   up front and each one verified.

3. **TypeScript inference across slice boundaries.** Each slice factory
   is `(set, get) => ({...})` typed against the *full* composed
   `StoreState`, not just its own slice — otherwise a cascade can't see
   sibling state. Standard Zustand "slices pattern", but the generics
   are fiddly; getting them wrong produces a wall of inference errors.

4. **It touches everything.** Every in-flight feature branch will
   conflict. Land it when `dev` is quiet, in one shot, not stacked
   under other work.

## Architecture

Zustand's documented "slices pattern": each slice is a factory typed
against the whole store; one `create()` call spreads them together.

```
lib/client/hooks/
  use-store.ts                 // thin: create() + persist config +
                               //   partialize + migrate; re-exports
                               //   useStore, all selectors, types
  store-helpers.ts             // (already shipped — pure helpers)
  store/
    types.ts                   // StoreState (union of all slice states)
                               //   + shared SliceCreator<T> helper type
    slices/
      ui.ts                    // theme, colorScheme, view, sidebar
                               //   widths, panels, modals, pins
      workspaces.ts            // workspaces[] + mutators + selectors
      conversations.ts         // conversations[] (headers) + active id
      messages.ts              // message mutators (operate on the
                               //   conversation's messages[])
      documents.ts
      files.ts                 // files[] + extraction/storage patches
      resources.ts             // workspace file-library join
      conversation-files.ts    // conversation-private file join
      mcp.ts                   // servers + resources + bindings + joins
      url-bookmarks.ts         // bookmarks + conversation join
      notes.ts
      artifacts.ts
      project-tasks.ts
      prompts.ts
      chat.ts                  // chatModel, typing/streaming id sets,
                               //   pending reference image, etc.
```

`SliceCreator<T>` is the standard typed factory:

```ts
import type { StateCreator } from "zustand"
export type SliceCreator<T> = StateCreator<
  StoreState,            // full store — slices can read siblings via get()
  [["zustand/persist", unknown]],
  [],
  T                      // this slice's own state + actions
>
```

`use-store.ts` becomes roughly:

```ts
export const useStore = create<StoreState>()(
  persist(
    (set, get, api) => ({
      ...createUiSlice(set, get, api),
      ...createWorkspacesSlice(set, get, api),
      ...createConversationsSlice(set, get, api),
      // … one spread per slice …
    }),
    {
      name: "hummingbird-storage",
      version: 19,                       // unchanged
      migrate,                           // unchanged, moved to store/migrate.ts
      partialize,                        // unchanged, moved to store/persist.ts
      onRehydrateStorage: …,             // unchanged
    }
  )
)
```

Cascades stay in the "owning" slice and reach siblings through `get()`:

```ts
// store/slices/workspaces.ts
deleteWorkspace: (id) => {
  // remove the workspace …
  set((s) => ({ workspaces: s.workspaces.filter(w => w.id !== id) }))
  // … then cascade through siblings (explicit, visible dependency):
  get()._cascadeWorkspaceDelete(id)   // implemented in each affected slice
}
```

(Exact cascade wiring decided during implementation — either a small
set of internal `_cascade*` helpers per slice, or the owning slice
does the filtering inline against `get()`. Whichever keeps the
dependency visible and the persisted result identical.)

## Phases

This is small enough to be **one PR**, but staged internally so each
step compiles + tests green before the next:

### Step 1 — Scaffolding (no behaviour change)
- Add `store/types.ts` with `StoreState` (initially `= the existing
  interface`, re-exported) and `SliceCreator<T>`.
- Add `store/persist.ts` (move `partialize`, `onRehydrateStorage`) and
  `store/migrate.ts` (move the `migrate` fn + `version`). Import back
  into `use-store.ts`. Verify hydrate-equality before touching slices.

### Step 2 — Extract leaf slices first (no cascades)
Slices with **no cross-entity cascade** move first — lowest risk:
`ui`, `chat`, `prompts`, `notes`, `artifacts`, `project-tasks`,
`documents`, `url-bookmarks`. Each: move state + mutators + its
selector hooks into the slice file, spread into `create()`, re-export
selectors from `use-store.ts`. Run typecheck + tests after each.

### Step 3 — Extract the join + cascade slices
`files`, `resources`, `conversation-files`, `mcp`, then the big two:
`conversations` + `messages` + `workspaces` (these own the cascades).
Wire each cascade through `get()` and verify the persisted result
matches the baseline snapshot after each delete path.

### Step 4 — Tests
- Per-slice unit tests now that each is independently constructable
  (mirrors the sync-layer test pass from cleanup Phase 2): create /
  update / delete / the cascade behaviours.
- A hydration-equality test: load a captured v19 snapshot, assert
  state deep-equals the pre-split baseline.

### Step 5 — Tidy
- `use-store.ts` ends as a thin composition + re-export file (target:
  under ~400 lines).
- Update `CLAUDE.md`'s "State Management" section to describe the slice
  layout.

## Verification

1. `bun run check` clean (typecheck + lint, 0 warnings).
2. `bun test` green; new per-slice tests added.
3. **Hydration equality:** capture `localStorage['hummingbird-storage']`
   from `dev` before the split; after the split, load it and assert
   `useStore.getState()` deep-equals the baseline (no lost/renamed
   keys, migration output identical).
4. Dev-server smoke: app boots from an existing localStorage with no
   data loss; create/rename/delete a workspace (cascade), send a
   message, pin a chat, add a project card, toggle theme — all persist
   across reload.
5. `bun run audit:bundle` — no server-only leakage; bundle size stable.
6. Sync still works: the sync layer reads the same store shape, so its
   existing tests + a signed-in reconcile smoke must still pass.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Persisted shape drifts → user data "vanishes" | Hydration-equality test against a captured snapshot; no `version` bump. |
| A cascade is missed in the split | Enumerate every multi-entity mutator up front; per-cascade test. |
| TS inference wall | Use the standard `SliceCreator<T>` typed against `StoreState`; extract one slice end-to-end first to prove the pattern. |
| Merge conflicts with feature work | Land in one focused PR when `dev` is quiet; don't stack other work under it. |

## Out of scope

- Behaviour / signature changes.
- Persisted-shape or migration changes.
- Sync-layer restructuring.
- Moving off Zustand.
