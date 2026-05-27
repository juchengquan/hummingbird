/**
 * Per-skill config for `searchFiles`.
 *
 * Shape:
 *   { maxCalls?: number }
 *
 * Same pattern as `webFetch` — a single per-turn cap with workspace
 * default / conversation override cascade. The server already clamps
 * the value via `clampMaxSearchFiles` (see lib/server/skills/file-search.ts).
 *
 * Resolution order: conversation override → workspace default →
 * built-in default (3). `resolveFileSearchConfig` returns the
 * fully-resolved shape used at request time.
 */

import { makeBoundedIntField } from "./bounded-int"

const FILE_SEARCH_MAX = makeBoundedIntField({ default: 3, min: 1, max: 10 })
export const DEFAULT_MAX_FILE_SEARCHES = FILE_SEARCH_MAX.DEFAULT
export const MIN_MAX_FILE_SEARCHES = FILE_SEARCH_MAX.MIN
export const MAX_MAX_FILE_SEARCHES = FILE_SEARCH_MAX.MAX
export const clampMaxFileSearches = FILE_SEARCH_MAX.clamp

export interface FileSearchConfig {
  maxCalls?: number
}

export interface ResolvedFileSearchConfig {
  maxCalls: number
}

export function resolveFileSearchConfig(
  workspace: FileSearchConfig | undefined,
  conversation: FileSearchConfig | undefined
): ResolvedFileSearchConfig {
  const raw =
    conversation?.maxCalls ?? workspace?.maxCalls ?? DEFAULT_MAX_FILE_SEARCHES
  return { maxCalls: clampMaxFileSearches(raw) }
}
