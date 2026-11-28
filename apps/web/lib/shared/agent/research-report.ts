/**
 * Pure helpers for the Deep Research deliverable
 * (`PLAN-deep-research.md`). Phase 2 uses `deriveResearchReportTitle`
 * to title the auto-created workspace document; future phases (4)
 * may add structured parsing for "redo section N".
 */

const MAX_TITLE_LEN = 60
const DEFAULT_TITLE = "Research report"

/**
 * Pick a human-friendly title for the auto-handed-off Markdown report.
 *
 * Strategy:
 *  1. Walk lines top-to-bottom; first non-empty line wins.
 *  2. Strip Markdown markers (heading hashes, leading bullet/dash).
 *  3. Truncate to MAX_TITLE_LEN, trim trailing whitespace.
 *  4. If we end up empty (e.g. report opens with a code fence), fall
 *     back to the supplied default or "Research report".
 */
export function deriveResearchReportTitle(
  markdown: string,
  fallback?: string
): string {
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const stripped = line
      .replace(/^#+\s*/, "") // # ## ### …
      .replace(/^[*_-]\s+/, "") // - bullet, * bullet, _ markers
      .replace(/^>+\s*/, "") // blockquote
      .trim()
    if (!stripped) continue
    const truncated = stripped.slice(0, MAX_TITLE_LEN).trim()
    if (truncated) return truncated
  }
  const fb = fallback?.trim()
  return fb && fb.length > 0 ? fb.slice(0, MAX_TITLE_LEN) : DEFAULT_TITLE
}
