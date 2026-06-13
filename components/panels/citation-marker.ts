import { cn } from "@/shared/utils"
import type { CitationMarkerMark, ClaimStatus } from "@/shared/verify"

/**
 * Inline citation-marker decoration (PLAN-citation-verifiability.md,
 * commit 6). The chat renderer (`MarkdownPreview`) already turns `[N]`
 * web-citation markers into clickable `web-citation` buttons in a single
 * pass over the rendered HTML string. This module adds the at-a-glance
 * verification hint: when the post-run citation verifier flagged the
 * claim a given `[N]` supports, the button also gets a tone class + a
 * tooltip.
 *
 * Why decorate the marker token, not the claim sentence: commit 2
 * deferred inline markers because claims straddle markdown formatting.
 * The `[N]` token survives the markdown pipeline as a plain run of text;
 * a single regex pass wraps each one, so the straddle problem stays out
 * of scope. The disclosure (`MessageVerification`) still carries the full
 * readout — the inline marker is only the glance-level cue.
 *
 * Only `unsupported` claims get a color; `partial` is left visually quiet
 * (the plan's conservative grading makes partial too weak a signal to
 * shout about), though it still carries the marker class + tooltip.
 */

// Web citations: `[N]` where N is 1-2 digits. Bounded by start-of-string
// or a non-word char to avoid matching mid-token (e.g. `arr[1]` in code).
export const WEB_CITATION_RE = /(^|[^\w])\[(\d{1,2})\]/g

export function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;")
}

const TONE: Record<ClaimStatus, string> = {
  unsupported:
    "text-red-600 dark:text-red-400 underline decoration-wavy underline-offset-2",
  // `partial` is intentionally unstyled to keep noise low; the
  // disclosure carries the partial count.
  partial: "",
  supported: "",
}

const TOOLTIP: Record<ClaimStatus, string> = {
  unsupported: "not found in cited sources",
  partial: "partially supported by cited sources",
  supported: "",
}

/** Extra class + tooltip for a flagged citation marker button. */
export function citationMarkerAttrs(mark: CitationMarkerMark): {
  className: string
  title: string
} {
  return {
    className: cn("citation-marker", TONE[mark.status]),
    title: `${mark.claimText} — ${TOOLTIP[mark.status]}`,
  }
}

/**
 * Turn `[N]` web-citation markers in rendered HTML into clickable
 * `web-citation` buttons. When `marks` carries a flagged claim for marker
 * `N`, the button also gets the citation-marker tone class + a tooltip.
 * Out-of-range markers (`N > sourceCount`) stay plain text so the user
 * sees the marker but can't click into a non-existent source.
 */
export function decorateWebCitations(
  html: string,
  sourceCount: number,
  marks?: Map<string, CitationMarkerMark>
): string {
  return html.replace(WEB_CITATION_RE, (_, lead, indexStr) => {
    const idx = Number(indexStr)
    if (!Number.isFinite(idx) || idx < 1 || idx > sourceCount) {
      return `${lead}[${indexStr}]`
    }
    const mark = marks?.get(String(idx))
    if (mark) {
      const { className, title } = citationMarkerAttrs(mark)
      return `${lead}<button type="button" class="web-citation ${className}" data-citation-index="${idx}" title="${escapeAttr(title)}">[${idx}]</button>`
    }
    return `${lead}<button type="button" class="web-citation" data-citation-index="${idx}">[${idx}]</button>`
  })
}
