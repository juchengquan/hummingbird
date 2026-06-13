# Semantic Caching — `project-breakdown` mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped Phase-2 in-process near-match from `file`-only to also cover `project-breakdown` (gated on empty `existingTitles`), via a pure, testable eligibility helper.

**Architecture:** Extract the "is this request eligible for similarity, and what do we embed?" decision out of the untestable route into a pure `summarize-similarity.ts` (`similarityTargetFor`), unit-test it, then generalise the route's file-only Phase-2 block to be driven by it. The cache module is reused unchanged.

**Tech Stack:** TypeScript, `bun:test`, Next.js route handler, the shipped `lib/server/cache/response-cache.ts` + `lib/server/embeddings/provider.ts`.

Design spec: `docs/superpowers/specs/2026-06-14-semantic-cache-project-breakdown-design.md`.

---

### Task 1: Pure eligibility helper `similarityTargetFor`

**Files:**
- Create: `lib/server/cache/summarize-similarity.ts`
- Create: `lib/server/cache/summarize-similarity.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/server/cache/summarize-similarity.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { similarityTargetFor } from "./summarize-similarity"

describe("similarityTargetFor", () => {
  test("file mode → scope + the file text", () => {
    expect(
      similarityTargetFor({ mode: "file", text: "hello world" }, "m"),
    ).toEqual({ scope: "summarize|file|m", text: "hello world" })
  })

  test("project-breakdown with no existingTitles → scope + the goal", () => {
    expect(
      similarityTargetFor({ mode: "project-breakdown", goal: "ship v1" }, "m"),
    ).toEqual({ scope: "summarize|project-breakdown|m", text: "ship v1" })
  })

  test("project-breakdown with an empty existingTitles array → target", () => {
    expect(
      similarityTargetFor(
        { mode: "project-breakdown", goal: "ship v1", existingTitles: [] },
        "m",
      ),
    ).toEqual({ scope: "summarize|project-breakdown|m", text: "ship v1" })
  })

  test("project-breakdown WITH existingTitles → null (no similarity)", () => {
    expect(
      similarityTargetFor(
        { mode: "project-breakdown", goal: "ship v1", existingTitles: ["Set up CI"] },
        "m",
      ),
    ).toBeNull()
  })

  test("conversation mode → null", () => {
    expect(similarityTargetFor({ mode: "conversation" }, "m")).toBeNull()
  })

  test("compress mode → null", () => {
    expect(similarityTargetFor({ mode: "compress" }, "m")).toBeNull()
  })

  test("scope interpolates the model id", () => {
    expect(
      similarityTargetFor({ mode: "file", text: "x" }, "google/gemini-2.5-flash")
        ?.scope,
    ).toBe("summarize|file|google/gemini-2.5-flash")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test lib/server/cache/summarize-similarity.test.ts`
Expected: FAIL — `similarityTargetFor` not exported (module doesn't exist).

- [ ] **Step 3: Implement the helper**

Create `lib/server/cache/summarize-similarity.ts`:

```ts
import "server-only"

/**
 * Which summarize requests are eligible for Phase-2 semantic near-match,
 * and what text to embed. Pure so the eligibility rules — including the
 * project-breakdown `existingTitles` gate — are unit-testable without the
 * route (which imports `ai`/structured-output and isn't unit-testable).
 *
 * See docs/superpowers/specs/2026-06-14-semantic-cache-project-breakdown-design.md.
 */

/** A similarity target: the scope to match within and the text to embed. */
export type SimilarityTarget = { scope: string; text: string }

/**
 * Returns the similarity target for a summarize request, or null when the
 * request stays exact-key only.
 *
 * - `file` → embed the file `text` (unconditional; its only input is the text).
 * - `project-breakdown` → embed the `goal`, but ONLY when there are no
 *   `existingTitles`. A goal-only match against a different board would
 *   re-propose tasks the user already has, which is exactly what
 *   `existingTitles` exists to prevent — so a request carrying titles stays
 *   exact-key only.
 * - everything else (`conversation`, `compress`) → null.
 *
 * Scope is `summarize|<mode>|<model>` so a match never crosses mode or model.
 */
export function similarityTargetFor(
  body: { mode: string; text?: string; goal?: string; existingTitles?: string[] },
  modelId: string,
): SimilarityTarget | null {
  if (body.mode === "file" && typeof body.text === "string") {
    return { scope: `summarize|file|${modelId}`, text: body.text }
  }
  if (
    body.mode === "project-breakdown" &&
    typeof body.goal === "string" &&
    !body.existingTitles?.length
  ) {
    return { scope: `summarize|project-breakdown|${modelId}`, text: body.goal }
  }
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test lib/server/cache/summarize-similarity.test.ts`
Expected: PASS (7 tests). Then `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/server/cache/summarize-similarity.ts lib/server/cache/summarize-similarity.test.ts
git commit -m "feat(cache): similarityTargetFor — per-mode Phase-2 eligibility helper"
```

---

### Task 2: Generalise the route's Phase-2 block

**Files:**
- Modify: `app/api/summarize/route.ts`

No new test: the route isn't unit-testable (no DI seam) and the new behaviour now lives entirely in the Task-1 helper (tested) + the unchanged cache module (already tested). Verified by `bun run typecheck` + `bun run lint` + a manual trace.

- [ ] **Step 1: Add the import**

In `app/api/summarize/route.ts`, add (next to the other `@/server/cache/...` / `@/server/embeddings/...` imports):

```ts
import { similarityTargetFor } from '@/server/cache/summarize-similarity'
```

`findSimilarCachedResponse`, `getCachedResponse`, `responseCacheKey`, `setCachedResponse` (from `@/server/cache/response-cache`) and `embedText`, `isEmbeddingConfigured` (from `@/server/embeddings/provider`) are already imported from Phase 2 and stay.

- [ ] **Step 2: Replace the file-only Phase-2 block**

Find this exact block (added in Phase 2):

```ts
  const cached = getCachedResponse(cacheKey)
  if (cached !== undefined) return NextResponse.json(cached)

  // Semantic near-match (PLAN-semantic-caching Phase 2) — file mode only.
  // On an exact-key miss, embed the file text once and look for a recent
  // summary of a near-identical document (same model). Advisory: any
  // embedding failure just falls through to the model call. Inert unless
  // an embeddings provider is configured.
  const similarityScope = `summarize|file|${modelId}`
  let fileEmbedding: number[] | undefined
  if (body.mode === 'file' && isEmbeddingConfigured()) {
    try {
      fileEmbedding = await embedText(body.text)
      const similar = findSimilarCachedResponse({
        scope: similarityScope,
        embedding: fileEmbedding,
      })
      if (similar !== undefined) return NextResponse.json(similar)
    } catch {
      // Embedding provider unavailable/errored — skip similarity, run the model.
      fileEmbedding = undefined
    }
  }

  // Cache + respond on the success paths only (never error responses).
  const respondCached = (payload: unknown) => {
    setCachedResponse(
      cacheKey,
      payload,
      body.mode === 'file' && fileEmbedding
        ? { embedding: fileEmbedding, scope: similarityScope }
        : undefined,
    )
    return NextResponse.json(payload)
  }
```

Replace it with (generalised over modes via `similarityTargetFor`):

```ts
  const cached = getCachedResponse(cacheKey)
  if (cached !== undefined) return NextResponse.json(cached)

  // Semantic near-match (PLAN-semantic-caching Phase 2). On an exact-key
  // miss, for eligible modes (file; project-breakdown without existingTitles
  // — see similarityTargetFor), embed the input once and look for a recent
  // result for a near-identical input (same mode + model). Advisory: any
  // embedding failure falls through to the model call. Inert unless an
  // embeddings provider is configured.
  const similarity = similarityTargetFor(body, modelId)
  let simEmbedding: number[] | undefined
  if (similarity && isEmbeddingConfigured()) {
    try {
      simEmbedding = await embedText(similarity.text)
      const hit = findSimilarCachedResponse({
        scope: similarity.scope,
        embedding: simEmbedding,
      })
      if (hit !== undefined) return NextResponse.json(hit)
    } catch {
      // Embedding provider unavailable/errored — skip similarity, run the model.
      simEmbedding = undefined
    }
  }

  // Cache + respond on the success paths only (never error responses).
  const respondCached = (payload: unknown) => {
    setCachedResponse(
      cacheKey,
      payload,
      similarity && simEmbedding
        ? { embedding: simEmbedding, scope: similarity.scope }
        : undefined,
    )
    return NextResponse.json(payload)
  }
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors; pre-existing warnings — the `_omitModel` unused-var in this file and the `services/agent-ts` ones — are unrelated). `body` (the discriminated union) is structurally assignable to `similarityTargetFor`'s `{ mode; text?; goal?; existingTitles? }` param, so no cast is needed.

- [ ] **Step 4: Manual trace (read, no command)**

Confirm: exact-key hit still returns first; `file` behaviour is unchanged (same scope, embed once); `project-breakdown` with no titles now gets similarity, with titles stays exact-key (`similarityTargetFor` → null → `simEmbedding` undefined → 2-arg store); `conversation`/`compress` unchanged; the embedding is computed at most once and reused by `respondCached`; an `embedText` throw falls through to the model.

- [ ] **Step 5: Commit**

```bash
git add app/api/summarize/route.ts
git commit -m "feat(summarize): semantic near-match also covers project-breakdown (no titles)"
```

---

### Task 3: Doc update + full gate + PR

**Files:**
- Modify: `docs/PLAN-semantic-caching.md`

- [ ] **Step 1: Update the plan-doc status note**

In `docs/PLAN-semantic-caching.md`, find the Phase-2 status note (the `**Phase 2 (2026-06-14): …**` block near the top, and its "Open follow-ups:" sentence which currently lists `project-breakdown` mode). Edit so it reflects that `project-breakdown` (no-titles) is now covered:
- In the Phase-2 description, change "on `file` summarize mode only" to note both `file` and `project-breakdown` (no `existingTitles`) are covered.
- Remove `extend to project-breakdown mode` from the "Open follow-ups" list, leaving the persistent/cross-instance pgvector variant as the remaining follow-up.

Keep the edit tight — adjust those sentences only.

- [ ] **Step 2: Commit the doc**

```bash
git add docs/PLAN-semantic-caching.md
git commit -m "docs: project-breakdown now covered by semantic near-match"
```

- [ ] **Step 3: Full gate**

Run: `bun run typecheck && bun run lint`
Expected: clean (0 errors).
Run: `bun test lib/server/cache`
Expected: all pass (`response-cache.test.ts` 18 + `summarize-similarity.test.ts` 7).
Run: `bun run docs:user-manual:check`
Expected: up to date (no env vars / panels added).

- [ ] **Step 4: Push + open the PR**

```bash
git push -u origin feat/semantic-cache-project-breakdown
gh pr create --base dev --title "feat: semantic near-match for project-breakdown summaries" --body "Implements docs/superpowers/specs/2026-06-14-semantic-cache-project-breakdown-design.md."
```

(Per the repo's PR rules, auto-subscribe if the GitHub MCP tool is available; otherwise watch CI via `gh pr checks --watch`.)

---

## Notes for the implementer

- **The `existingTitles` gate is the correctness crux.** `!body.existingTitles?.length` treats `undefined` and `[]` as "no titles" (eligible) and a non-empty array as "has titles" (not eligible). Task 1's tests pin all three.
- **Why the helper is its own module:** the route can't be unit-tested (imports `ai` + structured output, no DI seam), so the only new *logic* (per-mode eligibility + the gate) is extracted to a pure module that can. The route change is then a mechanical generalisation with no new untested logic.
- **Cache module is untouched** — `findSimilarCachedResponse` / 3-arg `setCachedResponse` / `cosine` already do everything; do not modify `response-cache.ts`.
- **Env-gate:** with no embeddings provider configured, `isEmbeddingConfigured()` is false → the whole path is a no-op (every mode behaves like Phase 1 exact-key). Default CI/deploys are unaffected.
