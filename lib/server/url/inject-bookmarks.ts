import "server-only"

/**
 * Chat-route helpers for injecting URL bookmark content into the
 * system prompt. Bookmarks already carry their cached text in the
 * request body (extracted server-side at save time via
 * `/api/url/fetch`), so this is a pure render — no I/O.
 *
 * The render shares `TOTAL_ATTACHMENT_BUDGET` with files and MCP
 * resources: caller passes whatever characters remain.
 */

export interface BookmarkPayload {
  id: string
  url: string
  title: string
  content: string
  contentTruncated?: boolean
  /** ISO 8601 — surfaced inline so the model knows how fresh the cache is. */
  fetchedAt?: string
}

/**
 * Render attached bookmarks into a system-prompt fragment, budgeted
 * by `remainingBudget` characters. Returns the fragment (null when
 * nothing to render) and the character count consumed.
 *
 * Truncation policy matches the files / MCP-resource paths: per-
 * bookmark cut at the remaining budget, with an inline marker;
 * overflow bookmarks render as an omitted-list footer.
 */
export function renderBookmarksPrompt(
  bookmarks: BookmarkPayload[],
  remainingBudget: number
): { fragment: string | null; used: number } {
  if (bookmarks.length === 0) return { fragment: null, used: 0 }

  const intro =
    "The user has saved these web pages as bookmarks. Their cached text " +
    "follows; if a fact appears outdated, the user may need to refresh the " +
    "bookmark."
  const parts: string[] = [intro]
  let used = intro.length

  const omitted: string[] = []
  for (const b of bookmarks) {
    const header = `\n\n--- ${b.title} (${b.url})${
      b.fetchedAt ? ` · fetched ${b.fetchedAt}` : ""
    } ---\n`
    const remaining = remainingBudget - used - header.length
    if (remaining <= 0) {
      omitted.push(b.title)
      continue
    }
    const body = b.content.slice(0, remaining)
    const overflow = b.content.length > body.length || b.contentTruncated
    parts.push(
      header +
        body +
        (overflow ? "\n\n[truncated to fit overall budget]" : "")
    )
    used += header.length + body.length
  }

  if (omitted.length > 0) {
    parts.push(
      `\n\n[Additional bookmarks omitted to fit budget: ${omitted.join(", ")}]`
    )
  }

  return { fragment: parts.join(""), used }
}
