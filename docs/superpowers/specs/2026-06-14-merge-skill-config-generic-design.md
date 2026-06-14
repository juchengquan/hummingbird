# Generic `mergeSkillConfig<T>` helper — subsumes three of four `merge*Config` functions

**Status:** Draft — refactor only, no behaviour change. Identified during the 2026-06-14 architecture review as a "Worth exploring" candidate. `mergeWebSearchConfig` keeps its sub-key logic (the asymmetry is real, not accidental).

**Goal:** Replace `mergeWebFetchConfig`, `mergeImageGenConfig`, and `mergeFileSearchConfig` in `lib/client/hooks/store-helpers.ts` with a single generic `mergeSkillConfig<T>(base, patch)`. `mergeWebSearchConfig` stays because its provider-sub-key deep-merge is asymmetric. Tests pin the identical-behaviour invariant.

---

## Decisions locked during brainstorming

| # | Decision | Choice |
|---|---|---|
| Q1 | Generic helper name | **`mergeSkillConfig<T>`** — describes the unit (a skill config), reads well at call sites. |
| Q2 | Signature | **`mergeSkillConfig<T>(base: T \| undefined, patch: Partial<T>): T \| undefined`** — matches the existing per-type signature exactly. |
| Q3 | `mergeWebSearchConfig` | **Stays.** Its sub-key deep-merge on `tavily` / `brave` / `exa` is asymmetric and intentional. A separate `mergeSkillConfigWithSubKeys` helper could subsume it later, but that's a separate spec — `mergeWebSearchConfig`'s sub-key logic deserves its own test surface today. |
| Q4 | Call-site migration | **Three call sites in `lib/client/hooks/store/slices/conversations.ts` and `lib/client/hooks/store/slices/workspaces.ts`.** The 4+4 `patchWorkspace*Config` / `patchConversation*Config` mutators are mostly untouched (see Q5). |
| Q5 | `patch*Config` mutators | **NOT touched in this spec.** They wrap `merge*Config` in `set(...)` calls. Generifying them would require fighting Zustand's slice typing more than the data-helper version does; per the architecture review, this is "a smaller win". Left for a future spec if desired. |
| Q6 | Helper location | **`lib/client/hooks/store-helpers.ts`** (existing home for the three helpers). |
| Q7 | Test strategy | **Replace the three existing describes in `store-helpers.test.ts` with one describe for `mergeSkillConfig`.** Add a test that calls `mergeSkillConfig<WebFetchConfig>(...)`, `mergeSkillConfig<ImageGenConfig>(...)`, `mergeSkillConfig<FileSearchConfig>(...)` to prove type-correctness across all three config types. The existing `mergeWebSearchConfig` describes stay. |

---

## Architecture

```
lib/client/hooks/store-helpers.ts        (MOD — replace 3 functions with 1 generic.
                                                mergeWebSearchConfig stays.)
lib/client/hooks/store-helpers.test.ts   (MOD — replace 3 describes with 1 generic
                                                describe. Add 3 typed-call tests for
                                                compile-time coverage.)
```

No state-shape change. No persistence change. No call-site change outside the helper.

---

## Section 1 — The helper

```ts
// store-helpers.ts

/**
 * Apply `patch` to `base`, returning the merged skill config or
 * `undefined` if the result is empty.
 *
 * Semantics (matching the three pre-existing per-type helpers):
 * - Keys whose patch value is `undefined` are **removed** from the
 *   result. This makes "reset" flows work: setting a key to
 *   `undefined` removes the override, and an empty result returns
 *   `undefined` so the next cascade level takes over cleanly.
 * - Keys whose patch value is anything else overwrite the base.
 * - An empty patch on an empty base returns `undefined`.
 *
 * `mergeWebSearchConfig` is **not** subsumed — its provider-sub-key
 * deep-merge on `tavily` / `brave` / `exa` is asymmetric and kept in
 * a separate function.
 */
export function mergeSkillConfig<T>(
  base: T | undefined,
  patch: Partial<T>
): T | undefined {
  const next: Record<string, unknown> = { ...(base ?? {}) }
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key]
    if (value === undefined) delete next[key as string]
    else next[key as string] = value
  }
  if (Object.keys(next).length === 0) return undefined
  return next as T
}
```

Identical body to `mergeWebFetchConfig` / `mergeImageGenConfig` / `mergeFileSearchConfig`, parameterised by `T`. The `T extends ?` bound is not needed — `T` is free-form because `Partial<T>` already constrains the patch shape.

### What this is NOT

- **Not a deep-merge.** It does a shallow `{...base, ...patch}` style. The three subsumed helpers are all shallow too. `mergeWebSearchConfig` is the only deep-merge; it stays separate.
- **Not a configuration cascade.** It doesn't read skill defaults from elsewhere; it just merges `base + patch`. The cascade logic lives in the slice mutators that wrap it.
- **Not for arrays.** Arrays in `patch` overwrite arrays in `base` (shallow). None of the three config types use arrays in their patches today; if a future config type does, this helper gets a sibling or extends.

---

## Section 2 — Call sites

The three functions are called from:

```
lib/client/hooks/store/slices/conversations.ts:
  patchConversationWebFetch, patchConversationImageGen,
  patchConversationFileSearch, patchConversationWebSearch

lib/client/hooks/store/slices/workspaces.ts:
  patchWorkspaceWebFetch, patchWorkspaceImageGen,
  patchWorkspaceFileSearch, patchWorkspaceWebSearch
```

Each mutator currently calls the per-type helper:
```ts
onChange: (patch) => mergeWebFetchConfig(state.webFetchConfig, patch)
```

After the refactor (only the three WebFetch / ImageGen / FileSearch paths):
```ts
onChange: (patch) => mergeSkillConfig<WebFetchConfig>(state.webFetchConfig, patch)
```

The `mergeWebSearchConfig` call sites stay unchanged.

### Slice-typing friction

The slice mutators' parameter types are `Partial<WebFetchConfig>` etc. — keeping those types intact means the `mergeSkillConfig<T>` type argument can be inferred from `Partial<T>` if `base` is `T | undefined`. **Decision:** keep the explicit `<T>` at every call site for now (matches the existing per-type precedent). Inference can be tightened later if the call-site count grows.

### Estimated diff

- `store-helpers.ts`: −27 lines (3 × 13-line functions removed), +12 lines (one generic function added). Net −15.
- `store-helpers.test.ts`: −30 lines (3 describes removed), +20 lines (one generic describe + 3 typed-call tests). Net −10.
- 6 call sites in conversations.ts + workspaces.ts: each gets `mergeXxxConfig(` → `mergeSkillConfig<XxxConfig>(` — purely a rename + one type arg. Zero logic change.

---

## Section 3 — `mergeWebSearchConfig` stays

The function lives in the same file (still in `store-helpers.ts`) but is not touched. Its doc-comment gains a single sentence: "Stays asymmetric on purpose — see `mergeSkillConfig` for the generic shallow-merge helper."

The two existing tests for `mergeWebSearchConfig` (sub-object deep merge + sub-object pruning) stay unchanged.

---

## Section 4 — Tests

### `store-helpers.test.ts`

Remove three describes:
- `describe("mergeWebFetchConfig")`
- `describe("mergeImageGenConfig")`
- `describe("mergeFileSearchConfig + mergeFileSearchConfig follow the same pattern")` (the joint one — split)

Add one describe:
- `describe("mergeSkillConfig<T>")` containing:
  - **Adds, overrides, and prunes leaves** (the same scenario that the old `mergeWebFetchConfig` test covered; now generic).
  - **Typed call: WebFetchConfig** — proves `mergeSkillConfig<WebFetchConfig>(...)` typechecks and returns the right shape.
  - **Typed call: ImageGenConfig** — same, different type.
  - **Typed call: FileSearchConfig** — same, different type.
  - **Empty result on empty base + empty patch** → `undefined`.
  - **`undefined` patch key removes from base** (the reset case).

Plus the two unchanged `mergeWebSearchConfig` describes.

---

## Section 5 — Out of scope (explicit)

- **`patch*Config` mutator generics** (the 8 `patchWorkspace*Config` + `patchConversation*Config` mutators) — left for a future spec per the architecture review's "smaller win" verdict.
- **A `mergeSkillConfigWithSubKeys` generic** — would subsume `mergeWebSearchConfig`, but the sub-key list (`tavily` / `brave` / `exa`) is config-specific. Not worth a generic unless a second config type gains sub-keys.
- **Renaming `mergeWebSearchConfig` to something more symmetric** (e.g. `mergeWebSearchConfigWithProviders`) — YAGNI; the doc comment is enough.
- **A type-safe `SkillConfig` union** — out of scope; each skill has its own type.

---

## Section 6 — Risks + mitigations

| Risk | Mitigation |
|---|---|
| Type-inference failure at a call site (TS narrows `Partial<T>` weirdly) | Explicit `<T>` type argument at every call site (matches today's explicit type-parameter style). |
| Behaviour drift between the three old helpers and the new generic | The 6-test describe pins the exact behaviour (add, override, prune, empty). The three typed-call tests prove the generic works for each type. |
| Someone in the future changes `mergeWebSearchConfig` to use the generic and loses the sub-key logic | Doc comment on `mergeWebSearchConfig` + the two unchanged tests make the asymmetry explicit. |
| Generic signature too permissive (`T = any`) | No constraint. The three concrete call sites provide all the compile-time coverage we need; if a fourth config type appears, it gets its own typed-call test. |

---

## Section 7 — Rollout

Single PR. Three file changes land together.

1. Add `mergeSkillConfig<T>` to `lib/client/hooks/store-helpers.ts` (next to `mergeWebSearchConfig`). Run `bun run check`.
2. Remove the three old helpers. Run `bun run check` (compile errors at the 6 call sites tell us where to fix).
3. Rename at the 6 call sites (conversations.ts × 3 + workspaces.ts × 3). Run `bun run check`.
4. Update `store-helpers.test.ts`: remove 3 describes, add 1. Run `bun run test`.
5. Final `bun run check` + `bun run test`.

Branch: `refactor/merge-skill-config-generic`. Target: `dev`.

---

## Section 8 — Wins

- **Locality**: the shallow-merge contract for skill configs lives in one 12-line function. Today it's three near-identical 13-line functions.
- **Leverage**: adding a fourth skill config type is "use `mergeSkillConfig<NewConfig>(...)`". Today it's "copy `mergeWebFetchConfig`, rename the type parameter, add a test".
- **Readability**: 6 call sites read identically (modulo the type argument) instead of 6 site-specific helper names.
- **The asymmetry is preserved**: `mergeWebSearchConfig` keeps its sub-key deep-merge. The helper isn't asked to do something it isn't designed for.
- **No behaviour change**: the existing tests pin the behaviour; the rewrite keeps them passing.