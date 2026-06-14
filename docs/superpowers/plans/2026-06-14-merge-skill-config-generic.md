# `mergeSkillConfig<T>` Generic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `mergeWebFetchConfig`, `mergeImageGenConfig`, and `mergeFileSearchConfig` in `lib/client/hooks/store-helpers.ts` with one generic `mergeSkillConfig<T>(base, patch)`. `mergeWebSearchConfig` stays. No behaviour change.

**Architecture:** One new generic function in the existing `store-helpers.ts`. Three old functions are removed. Six call sites in `slices/conversations.ts` and `slices/workspaces.ts` get renamed at the call site (3 in each, since `mergeWebSearchConfig` call sites stay). The test file replaces three describes with one generic describe + three typed-call tests.

**Tech Stack:** TypeScript 5.x, bun:test. No new deps.

---

## File Structure

| File | Change |
|---|---|
| `lib/client/hooks/store-helpers.ts` | MOD — add `mergeSkillConfig<T>`; remove 3 of 4 helpers |
| `lib/client/hooks/store-helpers.test.ts` | MOD — remove 3 describes; add 1 generic describe |
| `lib/client/hooks/store/slices/conversations.ts` | MOD — 3 call sites rename |
| `lib/client/hooks/store/slices/workspaces.ts` | MOD — 3 call sites rename |

No state-shape change. No persistence change. No type-import additions (the slice files already import the per-type config types).

---

## Task 1: Add `mergeSkillConfig<T>` + tests

**Files:**
- Modify: `lib/client/hooks/store-helpers.ts` (append at end of file)
- Modify: `lib/client/hooks/store-helpers.test.ts` (append describe)

- [ ] **Step 1: Add `mergeSkillConfig<T>` to `store-helpers.ts`**

Append at the end of `lib/client/hooks/store-helpers.ts`:

```ts
// --- generic skill config merge -------------------------------------------

/**
 * Apply `patch` to `base`, returning the merged skill config or
 * `undefined` if the result is empty.
 *
 * Semantics (matching the three pre-existing per-type helpers):
 *  - Keys whose patch value is `undefined` are **removed** from the
 *    result. This makes "reset" flows work: setting a key to
 *    `undefined` removes the override, and an empty result returns
 *    `undefined` so the next cascade level takes over cleanly.
 *  - Keys whose patch value is anything else overwrite the base.
 *  - An empty patch on an empty base returns `undefined`.
 *
 * `mergeWebSearchConfig` is **not** subsumed — its provider-sub-key
 * deep-merge on `tavily` / `brave` / `exa` is asymmetric and kept in
 * a separate function.
 */
export function mergeSkillConfig<T>(
  base: T | undefined,
  patch: Partial<T>,
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

- [ ] **Step 2: Add the test describe**

Append to `lib/client/hooks/store-helpers.test.ts`:

```ts
import { mergeSkillConfig } from "./store-helpers"
import type { WebFetchConfig } from "@/shared/skills/web-fetch-config"
import type { ImageGenConfig } from "@/shared/skills/image-gen-config"
import type { FileSearchConfig } from "@/shared/skills/file-search-config"

describe("mergeSkillConfig<T>", () => {
  test("adds keys when base is undefined", () => {
    expect(mergeSkillConfig(undefined, { maxCalls: 4 })).toEqual({
      maxCalls: 4,
    })
  })

  test("overrides existing keys", () => {
    expect(mergeSkillConfig({ maxCalls: 4 }, { maxCalls: 2 })).toEqual({
      maxCalls: 2,
    })
  })

  test("undefined patch key removes from base", () => {
    expect(
      mergeSkillConfig({ maxCalls: 4, maxChars: 100 }, { maxCalls: undefined }),
    ).toEqual({ maxChars: 100 })
  })

  test("empty result on empty base + empty patch → undefined", () => {
    expect(mergeSkillConfig({}, {})).toBeUndefined()
  })

  test("all-undefined patch on non-empty base → undefined", () => {
    expect(
      mergeSkillConfig({ maxCalls: 4 }, { maxCalls: undefined }),
    ).toBeUndefined()
  })

  test("typed call: WebFetchConfig", () => {
    const base: WebFetchConfig | undefined = { maxCalls: 3 }
    const out = mergeSkillConfig<WebFetchConfig>(base, {
      maxChars: 50_000,
    })
    expect(out).toEqual({ maxCalls: 3, maxChars: 50_000 })
  })

  test("typed call: ImageGenConfig", () => {
    const out = mergeSkillConfig<ImageGenConfig>(undefined, {
      maxCalls: 3,
      aspectRatio: "16:9",
    })
    expect(out).toEqual({ maxCalls: 3, aspectRatio: "16:9" })
  })

  test("typed call: FileSearchConfig", () => {
    const out = mergeSkillConfig<FileSearchConfig>(undefined, { maxCalls: 2 })
    expect(out).toEqual({ maxCalls: 2 })
  })
})
```

- [ ] **Step 3: Run the new tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/hooks/store-helpers.test.ts`
Expected: PASS — but note: the OLD helpers' tests still pass too, so the file's total test count is +8 from this addition.

- [ ] **Step 4: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store-helpers.ts lib/client/hooks/store-helpers.test.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(store): add mergeSkillConfig<T> generic + tests

Subsumes mergeWebFetchConfig, mergeImageGenConfig,
mergeFileSearchConfig. mergeWebSearchConfig stays (asymmetric
sub-key deep merge). Old helpers still in place; call sites
move in Tasks 3-4.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove the three old helpers

**Files:**
- Modify: `lib/client/hooks/store-helpers.ts` (remove 3 functions)

- [ ] **Step 1: Remove `mergeWebFetchConfig`, `mergeImageGenConfig`, `mergeFileSearchConfig`**

In `lib/client/hooks/store-helpers.ts`, delete the three function definitions (lines 139-179 in the current file — `mergeWebFetchConfig`, `mergeImageGenConfig`, `mergeFileSearchConfig`).

**Keep:** `mergeWebSearchConfig` (lines 181-209 in the current file) and the type imports (`FileSearchConfig`, `ImageGenConfig`, `WebFetchConfig`, `WebSearchConfig`) — the import is still used by `mergeWebSearchConfig` indirectly? **No** — `mergeWebSearchConfig` doesn't reference the `WebSearchConfig` type explicitly. After removing the three helpers, only `WebSearchConfig` is needed for the doc-comment (none — it's not referenced). **Decision:** drop the four config-type imports from `store-helpers.ts` if they become unused. TypeScript will tell you.

Run `bun run check` after the delete — it will surface any now-unused imports.

- [ ] **Step 2: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: COMPILE FAIL — the slice files still reference the removed helpers. This is expected; Task 3-4 fix them.

- [ ] **Step 3: Commit (intermediate)**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store-helpers.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(store): remove the three per-type merge helpers

mergeWebFetchConfig, mergeImageGenConfig, mergeFileSearchConfig are
gone. Call sites (Tasks 3-4) move to mergeSkillConfig<T>. The repo
does not typecheck between this commit and Task 4 — that's expected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Migrate call sites in `conversations.ts`

**Files:**
- Modify: `lib/client/hooks/store/slices/conversations.ts`

- [ ] **Step 1: Find the three call sites**

Open `lib/client/hooks/store/slices/conversations.ts` and search for:

```
mergeWebFetchConfig
mergeImageGenConfig
mergeFileSearchConfig
```

Three call sites exist (one per `patchConversation*Config` mutator). Note their line numbers.

- [ ] **Step 2: Update the import**

The file currently imports the helpers from `../store-helpers`. Replace that import with:

```ts
import { mergeSkillConfig } from "../store-helpers"
```

(`mergeWebSearchConfig` may still be needed — keep that one in the import if the file uses it. Adjust based on the file's actual imports.)

- [ ] **Step 3: Rename each call site**

For each of the three `merge*Config(...)` calls:

| Before | After |
|---|---|
| `mergeWebFetchConfig(state.webFetchConfig, patch)` | `mergeSkillConfig<WebFetchConfig>(state.webFetchConfig, patch)` |
| `mergeImageGenConfig(state.imageGenConfig, patch)` | `mergeSkillConfig<ImageGenConfig>(state.imageGenConfig, patch)` |
| `mergeFileSearchConfig(state.fileSearchConfig, patch)` | `mergeSkillConfig<FileSearchConfig>(state.fileSearchConfig, patch)` |

Add explicit `<T>` type args at every call site (matches the precedent set in the spec).

- [ ] **Step 4: Run `bun run check` on this file alone**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: still COMPILE FAIL — workspaces.ts still references the removed helpers. That's expected.

- [ ] **Step 5: Commit (intermediate)**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/conversations.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(store): migrate conversations.ts to mergeSkillConfig<T>

Three call sites renamed with explicit type arguments. mergeWebSearchConfig
call site (if any) untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Migrate call sites in `workspaces.ts`

**Files:**
- Modify: `lib/client/hooks/store/slices/workspaces.ts`

- [ ] **Step 1: Find the three call sites**

Same as Task 3 Step 1, but in `workspaces.ts`.

- [ ] **Step 2: Update the import + rename each call site**

Same as Task 3 Steps 2-3. Three call sites with the same renames.

- [ ] **Step 3: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. 0 errors.

- [ ] **Step 4: Run tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS. The generic helper + the slice-level state diffs are unchanged.

- [ ] **Step 5: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store/slices/workspaces.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "refactor(store): migrate workspaces.ts to mergeSkillConfig<T>

Three call sites renamed with explicit type arguments.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Update the test file

**Files:**
- Modify: `lib/client/hooks/store-helpers.test.ts`

- [ ] **Step 1: Remove the three old describes**

Open `lib/client/hooks/store-helpers.test.ts` and delete the three describes that test the now-removed helpers:

- `describe("mergeWebFetchConfig adds, overrides, and prunes leaves")`
- `describe("mergeImageGenConfig + mergeFileSearchConfig follow the same pattern")`
- (any other describes that reference the removed helpers — keep `describe("mergeWebSearchConfig ...")` since that helper still exists)

Look for these by name. If a describe block tests both removed + kept helpers (e.g. "mergeImageGenConfig + mergeFileSearchConfig"), split it: delete the removed parts, keep the kept parts.

- [ ] **Step 2: Run the tests**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/hooks/store-helpers.test.ts`
Expected: PASS — the 8 new `mergeSkillConfig<T>` tests pass; the 2 `mergeWebSearchConfig` describes (sub-object deep merge + sub-object pruning) still pass.

- [ ] **Step 3: Commit**

```bash
git -C /Users/blackmount8/_repository/hummingbird add lib/client/hooks/store-helpers.test.ts
git -C /Users/blackmount8/_repository/hummingbird commit -m "test(store): retire the three per-type merge describes

mergeWebFetchConfig, mergeImageGenConfig, mergeFileSearchConfig no
longer exist; their describes are gone. mergeSkillConfig<T> covers
the same surface with explicit typed-call tests for each config type.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Final verification

**Files:** none modified.

- [ ] **Step 1: Run `bun run check`**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run check`
Expected: PASS. 0 errors. Pre-existing lint warnings unchanged.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test`
Expected: PASS. Test count: +8 (new `mergeSkillConfig<T>` describes) −N (retired describes). If the retired describes had 4 tests between them, net is +4.

- [ ] **Step 3: Confirm `mergeWebSearchConfig` still works**

Run: `cd /Users/blackmount8/_repository/hummingbird && bun run test -- ./lib/client/hooks/store-helpers.test.ts -t "mergeWebSearchConfig"`
Expected: PASS — the two sub-key deep-merge tests still pass.

- [ ] **Step 4: Confirm net line count**

Run: `cd /Users/blackmount8/_repository/hummingbird && git diff main...HEAD -- lib/client/hooks/store-helpers.ts | wc -l`
Expected: small net-deletion diff (~−15 lines).

---

## Self-Review Checklist

- **Spec coverage:** All 7 sections map to tasks. Decision table → reflected in tasks. Helper + tests → Task 1. Remove old helpers → Task 2. Migrate conversations.ts → Task 3. Migrate workspaces.ts → Task 4. Update tests → Task 5. Final verification → Task 6.
- **Placeholders:** None. Every code block is complete.
- **Type consistency:** `mergeSkillConfig<T>` is the only added function. The slice files keep their existing `WebFetchConfig` / `ImageGenConfig` / `FileSearchConfig` type imports (they need them for `state.webFetchConfig` typing). The `mergeWebSearchConfig` call sites are unchanged.
- **Out-of-scope respected:** `mergeWebSearchConfig` is preserved. The 8 `patchWorkspace*Config` / `patchConversation*Config` mutator bodies are not generified (per the spec's explicit decision).