# Semantic caching — `project-breakdown` mode — Design

Status: **approved design — ready for implementation plan.**
Origin: the "extend to `project-breakdown`" follow-up left open by `docs/superpowers/specs/2026-06-14-semantic-cache-phase-2-design.md` (Phase 2 shipped `file`-mode near-match; PR #209).

## Why

Phase 2 added in-process embedding near-match to the `file` summarize mode only. `project-breakdown` (turn a project goal into a list of task titles) is the other mode where a paraphrased input recurs — a user re-phrasing the same goal should reuse a recent breakdown instead of paying for a fresh model call. The machinery (`findSimilarCachedResponse`, 3-arg `setCachedResponse`, the embeddings provider) already exists; this is one more mode plus a correctness gate.

## The correctness gate (decided in brainstorming)

`project-breakdown` takes `{ goal, existingTitles?, model? }`. `existingTitles` materially shapes the output — it tells the model which task titles to avoid re-proposing. A goal-only similarity match could therefore serve a breakdown computed against a *different* board, re-proposing tasks the user already has.

**Decision:** attempt similarity for `project-breakdown` **only when `existingTitles` is empty/absent** (the "fresh board from a paraphrased goal" case). When `existingTitles` is present, the request stays exact-key only. This sidesteps the duplicate-task risk entirely. `file` mode is unconditional (its only input is the text).

## Architecture — extract the eligibility decision into a pure helper

Today the Phase-2 block in `app/api/summarize/route.ts` is hard-coded to `file` mode. The route itself is not unit-testable (imports `ai`/structured-output, no DI seam), so the new per-mode eligibility logic — including the `existingTitles` gate — is extracted into a small pure module that IS testable.

```ts
// lib/server/cache/summarize-similarity.ts  (new, pure, server-only)
export type SimilarityTarget = { scope: string; text: string }

/**
 * Decide whether a summarize request is eligible for Phase-2 semantic
 * near-match, and what to embed. Returns null for modes/inputs that stay
 * exact-key only. `file` → embed the file text (unconditional).
 * `project-breakdown` → embed the goal, but ONLY when there are no
 * existingTitles (a goal-only match must not re-propose tasks already on
 * the board). conversation / compress → null.
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

The scope string keeps the `kind|mode|model` shape, so a `file` entry can never match a `project-breakdown` query (or vice-versa), and different models never cross-match.

## Route change (`app/api/summarize/route.ts`)

Replace the file-only Phase-2 block (added in Phase 2) with a generalized one driven by `similarityTargetFor`. Behaviour for `file` mode is unchanged; `project-breakdown` (no titles) is newly covered; everything else is exact-key as before.

```ts
import { similarityTargetFor } from '@/server/cache/summarize-similarity'
// ...
const similarity = similarityTargetFor(body, modelId)
let simEmbedding: number[] | undefined
if (similarity && isEmbeddingConfigured()) {
  try {
    simEmbedding = await embedText(similarity.text)
    const hit = findSimilarCachedResponse({ scope: similarity.scope, embedding: simEmbedding })
    if (hit !== undefined) return NextResponse.json(hit)
  } catch {
    simEmbedding = undefined
  }
}
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

The embedding is computed at most once and reused by `respondCached`. `embedText` errors fall through to the model call (advisory). Env-gate (`isEmbeddingConfigured()`) makes the whole path a no-op on default deploys.

## Cache module

**Unchanged.** `findSimilarCachedResponse` + 3-arg `setCachedResponse` + `cosine` already cover everything; no new exports, no schema/Entry change.

## Error handling

Same as Phase 2: env-gate skip; `embedText` throw → catch, reset `simEmbedding`, run the model; dim/empty vector → `cosine` returns `-1` (no match). No new failure modes.

## Testing

- **`lib/server/cache/summarize-similarity.test.ts`** (new, pure, `bun:test`):
  - `file` mode with `text` → `{ scope: "summarize|file|m", text }`.
  - `project-breakdown` with `goal` and no `existingTitles` → `{ scope: "summarize|project-breakdown|m", text: goal }`.
  - `project-breakdown` with `goal` **and** non-empty `existingTitles` → `null` (the correctness gate).
  - `project-breakdown` with `goal` and an empty-array `existingTitles` → target (empty array counts as "no titles").
  - `conversation` / `compress` → `null`.
  - scope strings interpolate `modelId` exactly.
- Route wiring verified by `bun run typecheck` + `bun run lint` (the eligibility logic — the only new behaviour — now lives in the tested helper; the cache lookup/store is unchanged and already covered by `response-cache.test.ts`).

## Doc

Update the Phase-2 status note in `docs/PLAN-semantic-caching.md`: `project-breakdown` (no-titles) is now covered; drop it from the "open follow-ups" list (leaving the persistent/cross-instance pgvector variant as the remaining follow-up).

## Touch-point summary

| File | Change |
|---|---|
| `lib/server/cache/summarize-similarity.ts` | **new** — pure `similarityTargetFor` + `SimilarityTarget` |
| `lib/server/cache/summarize-similarity.test.ts` | **new** — eligibility/gate/scope tests |
| `app/api/summarize/route.ts` | replace file-only Phase-2 block with the `similarityTargetFor`-driven block + import |
| `docs/PLAN-semantic-caching.md` | status note: project-breakdown covered |

## Scope

S–M. One small pure file + tests, a route refactor (net simplification — generalises the existing block rather than adding a parallel one), and a doc line. No cache-module/schema change, no new deps, no migration.
