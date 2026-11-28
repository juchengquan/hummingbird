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

import { makeBoundedIntField } from "./bounded-int"

const WEB_FETCH_MAX = makeBoundedIntField({ default: 5, min: 1, max: 20 })
/** Built-in default when neither workspace nor conversation specifies. */
export const DEFAULT_MAX_WEB_FETCHES = WEB_FETCH_MAX.DEFAULT
/** Inclusive bounds the UI enforces on the stepper. */
export const MIN_MAX_WEB_FETCHES = WEB_FETCH_MAX.MIN
export const MAX_MAX_WEB_FETCHES = WEB_FETCH_MAX.MAX
export const clampMaxWebFetches = WEB_FETCH_MAX.clamp

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
