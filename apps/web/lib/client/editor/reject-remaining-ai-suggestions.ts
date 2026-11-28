"use client"
import "client-only"

/**
 * Walks the editor for nodes carrying suggestion marks and calls
 * `rejectSuggestion` on each unresolved id. Used by the diff-mode
 * "Reject remaining" affordance — distinct from Plate's existing
 * `aiChat.discard()`, which reverts the entire AI session including
 * chunks the user has already individually accepted.
 *
 * The walker is split into two pieces so the dedup / scoping logic
 * can be unit-tested without a live Plate editor:
 *
 * - `collectPendingSuggestionIds(entries)` — pure: takes the
 *   per-node ids extracted from a walk and returns unique ids in
 *   document order.
 * - `rejectRemainingAiSuggestions(editor)` — calls the suggestion
 *   plugin's API to walk the doc, hands ids to the pure function,
 *   then calls `rejectSuggestion` for each. Returns the count.
 */

import { rejectSuggestion } from "@platejs/suggestion"
import { SuggestionPlugin } from "@platejs/suggestion/react"
import {
  ElementApi,
  KEYS,
  type SlateEditor,
  type TElement,
  type TText,
  TextApi,
} from "platejs"

export interface SuggestionEntry {
  /** Block-level suggestion id from `api.suggestion.nodeId(elementNode)`. */
  nodeId: string | null
  /** Per-text-mark ids from `api.suggestion.dataList(textNode)`. A
   *  single text leaf can carry multiple overlapping suggestion
   *  ids; we flatten them here. */
  dataIds: string[]
}

/** Deduplicate suggestion ids while preserving first-seen order so
 *  keyboard navigation jumps through changes top-to-bottom. */
export function collectPendingSuggestionIds(entries: SuggestionEntry[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    if (entry.nodeId && !seen.has(entry.nodeId)) {
      seen.add(entry.nodeId)
      out.push(entry.nodeId)
    }
    for (const id of entry.dataIds) {
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
  }
  return out
}

/** Walk every node in the editor; for each text leaf carrying a
 *  suggestion mark or element node tagged as a block suggestion,
 *  build a `SuggestionEntry`. Exported separately so callers that
 *  want the count (without actually rejecting) — e.g. the
 *  "N pending" pill — can reuse the walk. */
export function findPendingAiSuggestions(editor: SlateEditor): string[] {
  // Cast to `any`: `getApi` is typed loosely on plugin lookups and
  // we only access the runtime-stable `suggestion.nodeId` /
  // `suggestion.dataList` helpers from `@platejs/suggestion`.
  const api = (editor.getApi(SuggestionPlugin) as { suggestion: SuggestionApiSurface }).suggestion
  const entries: SuggestionEntry[] = []
  for (const [node] of editor.api.nodes<TElement | TText>({ at: [], mode: "all" })) {
    if (TextApi.isText(node)) {
      const text = node as Record<string, unknown>
      if (!text[KEYS.suggestion]) continue
      const nodeId = api.nodeId(node) ?? null
      const dataIds = api
        .dataList(node)
        .map((d) => d.id)
        .filter((id): id is string => Boolean(id))
      entries.push({ nodeId, dataIds })
    } else if (ElementApi.isElement(node)) {
      const id = api.nodeId(node)
      if (id) entries.push({ nodeId: id, dataIds: [] })
    }
  }
  return collectPendingSuggestionIds(entries)
}

/** Reject every unresolved suggestion in the editor. Returns the
 *  number of distinct suggestion ids that were rejected. Idempotent
 *  — calling on an editor with no pending suggestions returns 0. */
export function rejectRemainingAiSuggestions(editor: SlateEditor): number {
  const ids = findPendingAiSuggestions(editor)
  let count = 0
  for (const id of ids) {
    try {
      // `rejectSuggestion` accepts a `TResolvedSuggestion` but in
      // practice only reads `suggestionId` to scope its walk.
      // Pass the minimal shape; cast to `never` so the call site
      // doesn't pin us to the full SDK type (which evolves).
      rejectSuggestion(editor, { suggestionId: id } as never)
      count += 1
    } catch {
      // Suggestion was already gone between enumeration and reject
      // — could happen if two paths race (rare). Skip silently.
    }
  }
  return count
}

interface SuggestionApiSurface {
  nodeId: (node: unknown) => string | undefined
  dataList: (node: unknown) => Array<{ id?: string; type?: string }>
}
