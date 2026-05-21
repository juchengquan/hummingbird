/**
 * Per-skill config for `webFetch`.
 *
 * Shape:
 *   { maxCalls?: number }
 *
 * Smaller than `webSearch`'s config — no providers, no sub-knobs — but
 * it follows the same cascade so the same UI patterns work: a
 * workspace-level default that conversations inherit and can override.
 *
 * Resolution order: conversation override → workspace default →
 * built-in default. `resolveWebFetchConfig` returns the fully-resolved
 * shape used at request time.
 */

/** Built-in default when neither workspace nor conversation specifies. */
export const DEFAULT_MAX_WEB_FETCHES = 5
/** Inclusive bounds the UI enforces on the stepper. */
export const MIN_MAX_WEB_FETCHES = 1
export const MAX_MAX_WEB_FETCHES = 20

export function clampMaxWebFetches(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_WEB_FETCHES
  const rounded = Math.round(n)
  if (rounded < MIN_MAX_WEB_FETCHES) return MIN_MAX_WEB_FETCHES
  if (rounded > MAX_MAX_WEB_FETCHES) return MAX_MAX_WEB_FETCHES
  return rounded
}

export interface WebFetchConfig {
  maxCalls?: number
}

/** Fully-resolved shape — every field non-optional. */
export interface ResolvedWebFetchConfig {
  maxCalls: number
}

export function resolveWebFetchConfig(
  workspace: WebFetchConfig | undefined,
  conversation: WebFetchConfig | undefined
): ResolvedWebFetchConfig {
  const raw =
    conversation?.maxCalls ?? workspace?.maxCalls ?? DEFAULT_MAX_WEB_FETCHES
  return { maxCalls: clampMaxWebFetches(raw) }
}
