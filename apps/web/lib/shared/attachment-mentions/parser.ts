/**
 * Pure parser for the `#` attachment-mention surface (Open WebUI–style
 * Knowledge mentions, adapted for Hummingbird's existing attachment
 * lanes — files + URL bookmarks). Sibling of
 * `lib/shared/prompts/mention-parser.ts` (`@` for prompts) and
 * `lib/shared/skills/slash-parser.ts` (`/` for skills) — three trigger
 * chars, three physically-separate namespaces.
 *
 * Picking an `#` mention attaches the chosen file or bookmark to the
 * active conversation (via the existing toggle mutators) and strips
 * the `#token` from the input. The hook side owns the strip + toggle;
 * this file is parser-only.
 *
 * No React, no I/O — fully unit-testable.
 */

import type { UploadedFile, UrlBookmark } from "@/shared/types"

/** Max rows surfaced in the autocomplete. Workspace libraries can hold
 *  hundreds of files; cap to keep the menu shape predictable. */
export const MAX_ATTACHMENT_MENTION_MATCHES = 8

/** One row in the autocomplete. Discriminated union so the menu can
 *  render an icon and the picker can call the right toggle mutator. */
export type AttachmentMentionMatch =
  | {
      kind: "workspaceFile" | "conversationFile"
      id: string
      name: string
      /** Mime type — drives icon selection in the menu. */
      type: string
    }
  | {
      kind: "bookmark"
      id: string
      title: string
      url: string
    }

/**
 * Whether the input is in the "typing a `#` attachment-mention" state —
 * leading `#`, caret still inside the first token (no whitespace yet).
 * Drives the autocomplete's open/closed state.
 *
 * The leading-`#`-only rule means markdown-headed messages like
 * "# My heading" don't trigger the menu past the space; and inline
 * uses like "see #foo elsewhere" never trigger it.
 */
export function isTypingAttachmentMention(text: string): boolean {
  if (!text.startsWith("#")) return false
  return !/\s/.test(text)
}

/** Inputs to the matcher — passed in rather than read from a store so
 *  the function stays pure. */
export interface AttachmentMentionSources {
  /** Workspace files visible in this conversation (post-tombstone). */
  workspaceFiles: readonly UploadedFile[]
  /** Conversation-private files (post-tombstone). */
  privateFiles: readonly UploadedFile[]
  /** Workspace URL bookmarks (post-tombstone). */
  bookmarks: readonly UrlBookmark[]
}

/**
 * Autocomplete matches for the partial token after the `#`. `partial`
 * is the text between the `#` and the caret (without the `#`).
 *
 * Ranking, within each kind:
 *   1. Name-prefix matches (precise — the user is typing toward it).
 *   2. Name-substring matches (discovery — they know the name fuzzily).
 *
 * Across kinds, the same intent ordering applies: workspace files
 * first (most common), then private files (still files, narrower
 * scope), then bookmarks. The menu surfaces a `groupLabel` per kind so
 * the user sees clear sections. Empty `partial` returns every live
 * item, ordered the same way. Capped at `MAX_ATTACHMENT_MENTION_MATCHES`.
 *
 * Tombstoned items (`deletedAt` set) are excluded — handled at the
 * caller boundary too via store selectors, but we filter defensively
 * here in case a stale array is passed in.
 */
export function matchAttachmentMentions(
  partial: string,
  sources: AttachmentMentionSources,
): AttachmentMentionMatch[] {
  const needle = partial.toLowerCase()

  const matchFile = (f: UploadedFile): { rank: number } | null => {
    if (f.deletedAt) return null
    const name = f.name.toLowerCase()
    if (!needle) return { rank: 1 }
    if (name.startsWith(needle)) return { rank: 0 }
    if (name.includes(needle)) return { rank: 1 }
    return null
  }
  const matchBookmark = (b: UrlBookmark): { rank: number } | null => {
    if (b.deletedAt) return null
    const title = b.title.toLowerCase()
    const url = b.url.toLowerCase()
    if (!needle) return { rank: 1 }
    if (title.startsWith(needle)) return { rank: 0 }
    if (title.includes(needle)) return { rank: 1 }
    // URL substring is a last-resort fallback — useful when the user
    // remembers the domain but not the bookmark's display title.
    if (url.includes(needle)) return { rank: 2 }
    return null
  }

  const out: AttachmentMentionMatch[] = []
  type Ranked<T> = { rank: number; entry: T }

  const wsRanked: Ranked<UploadedFile>[] = []
  for (const f of sources.workspaceFiles) {
    const r = matchFile(f)
    if (r) wsRanked.push({ rank: r.rank, entry: f })
  }
  wsRanked.sort((a, b) => a.rank - b.rank)
  for (const r of wsRanked) {
    out.push({ kind: "workspaceFile", id: r.entry.id, name: r.entry.name, type: r.entry.type })
  }

  const privRanked: Ranked<UploadedFile>[] = []
  for (const f of sources.privateFiles) {
    const r = matchFile(f)
    if (r) privRanked.push({ rank: r.rank, entry: f })
  }
  privRanked.sort((a, b) => a.rank - b.rank)
  for (const r of privRanked) {
    out.push({
      kind: "conversationFile",
      id: r.entry.id,
      name: r.entry.name,
      type: r.entry.type,
    })
  }

  const bmRanked: Ranked<UrlBookmark>[] = []
  for (const b of sources.bookmarks) {
    const r = matchBookmark(b)
    if (r) bmRanked.push({ rank: r.rank, entry: b })
  }
  bmRanked.sort((a, b) => a.rank - b.rank)
  for (const r of bmRanked) {
    out.push({
      kind: "bookmark",
      id: r.entry.id,
      title: r.entry.title,
      url: r.entry.url,
    })
  }

  return out.slice(0, MAX_ATTACHMENT_MENTION_MATCHES)
}
