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
