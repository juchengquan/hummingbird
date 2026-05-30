/**
 * Post-processing for the Markdown report produced by Deep Research
 * mode (`PLAN-deep-research.md` §Phase 4 — polish).
 *
 * The model writes `[N]` inline markers + a `## Sources` block at the
 * end. Left unaltered the numbering is unreliable: the model may reuse
 * `[1]` across sections for different sources, skip numbers, leave
 * duplicates in the Sources block, or cite an N not listed there. This
 * module normalises that:
 *
 *  - Inline `[N]` markers are remapped to a canonical sequence in
 *    first-appearance order through the body.
 *  - The Sources block is deduplicated by URL (or by file name for
 *    `[N] file: <name>` entries) and rebuilt in canonical order.
 *  - Markers that reference a number not in the Sources block are
 *    left as-is (the model is signalling something we shouldn't
 *    rewrite away).
 *  - When the report has no Sources block, or the Sources block is
 *    empty, the input is returned verbatim — there's nothing to
 *    canonicalise.
 *
 * Pure, no I/O. The chat / artifact / editor surface decides when to
 * apply it (Phase 2's auto-handoff is the obvious call site; the
 * existing manual "Open report in editor" button can also pre-format).
 */

const SOURCES_HEADING_RE = /^##+\s*sources\s*$/im

interface ParsedSource {
  /** Original marker number as written by the model, e.g. `3` from `[3]`. */
  originalIndex: number
  /** The free-text part — typically the title or "file: <name>". */
  label: string
  /** Stable identity for dedup: the URL if one was found in the line,
   *  otherwise the lowercased normalised label. Two sources with the
   *  same key collapse onto one canonical number. */
  key: string
  /** True when the source was a `file: <name>` entry (no URL). */
  isFile: boolean
}

const SOURCE_LINE_RE = /^\s*\[(\d+)\]\s*(.+?)\s*$/

function extractUrl(text: string): string | undefined {
  // Greedy URL match — `[N] Title — https://example.com` style.
  const m = text.match(/https?:\/\/\S+/i)
  if (!m) return undefined
  // Strip a trailing closing paren / punctuation that's commonly
  // mistaken as part of the URL.
  return m[0].replace(/[).,;:'"`]+$/, "")
}

function parseSourcesBlock(block: string): ParsedSource[] {
  const out: ParsedSource[] = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const m = line.match(SOURCE_LINE_RE)
    if (!m) continue
    const originalIndex = Number(m[1])
    if (!Number.isFinite(originalIndex) || originalIndex < 1) continue
    const label = m[2].trim()
    const url = extractUrl(label)
    const isFile = /^file:\s*/i.test(label) && !url
    const key = url
      ? url.toLowerCase()
      : isFile
        ? `file:${label.replace(/^file:\s*/i, "").toLowerCase().trim()}`
        : label.toLowerCase().trim()
    out.push({ originalIndex, label, key, isFile })
  }
  return out
}

interface NumberingPlan {
  /** Maps each input source's `originalIndex` to its canonical 1-based
   *  number after dedup. Duplicates point at the canonical entry's
   *  number, so two `[3]`-style inputs collapse onto one canonical
   *  entry. */
  originalToCanonical: Map<number, number>
  /** Sources in canonical order (after dedup), each with the canonical
   *  number for re-emission in the `## Sources` block. */
  canonical: { num: number; label: string }[]
}

/**
 * Walk the body looking for `[N]` markers in document order. For each
 * marker that resolves to a known source, assign that source its
 * canonical number on first sight. Duplicates of the same source key
 * reuse the canonical number. Markers that reference an unknown N are
 * left alone (the body keeps them).
 */
function planFromBody(
  body: string,
  parsed: ParsedSource[]
): NumberingPlan {
  const bySource = new Map<number, ParsedSource>()
  for (const s of parsed) bySource.set(s.originalIndex, s)
  // First-appearance map by source KEY (not original index) so two
  // "[1]" and "[3]" pointing at the same URL collapse.
  const keyToCanonical = new Map<string, number>()
  const originalToCanonical = new Map<number, number>()
  const canonical: { num: number; label: string }[] = []

  const markerRe = /\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = markerRe.exec(body)) !== null) {
    const original = Number(match[1])
    const src = bySource.get(original)
    if (!src) continue
    let canonicalNum = keyToCanonical.get(src.key)
    if (canonicalNum === undefined) {
      canonicalNum = canonical.length + 1
      keyToCanonical.set(src.key, canonicalNum)
      canonical.push({ num: canonicalNum, label: src.label })
    }
    if (!originalToCanonical.has(original)) {
      originalToCanonical.set(original, canonicalNum)
    }
  }

  // Sources cited only via the trailing block (never inline) still
  // deserve a slot. Append them after the body-derived ones in their
  // original-index order so a "for completeness" reference list survives.
  for (const s of parsed) {
    if (keyToCanonical.has(s.key)) continue
    const canonicalNum = canonical.length + 1
    keyToCanonical.set(s.key, canonicalNum)
    canonical.push({ num: canonicalNum, label: s.label })
    originalToCanonical.set(s.originalIndex, canonicalNum)
  }
  return { originalToCanonical, canonical }
}

function renumberBody(
  body: string,
  plan: NumberingPlan
): string {
  return body.replace(/\[(\d+)\]/g, (full, raw: string) => {
    const original = Number(raw)
    const canonical = plan.originalToCanonical.get(original)
    return canonical === undefined ? full : `[${canonical}]`
  })
}

function renderSourcesBlock(
  plan: NumberingPlan,
  sourcesHeading: string
): string {
  if (plan.canonical.length === 0) return ""
  const lines = plan.canonical.map(({ num, label }) => `[${num}] ${label}`)
  return `${sourcesHeading}\n${lines.join("\n")}\n`
}

/**
 * Normalize citations in a Deep Research report.
 *
 * Idempotent — running it twice produces the same result as running it
 * once. Safe to apply to non-research markdown (returns the input
 * unchanged when no `## Sources` block is found).
 */
export function formatResearchCitations(markdown: string): string {
  const trimmed = markdown
  const lines = trimmed.split("\n")
  const headingIdx = lines.findIndex((l) => SOURCES_HEADING_RE.test(l))
  if (headingIdx === -1) return trimmed

  const bodyLines = lines.slice(0, headingIdx)
  const sourcesLines = lines.slice(headingIdx + 1)
  const body = bodyLines.join("\n").replace(/\s+$/, "")
  const sourcesBlock = sourcesLines.join("\n")
  const parsed = parseSourcesBlock(sourcesBlock)
  if (parsed.length === 0) return trimmed

  const plan = planFromBody(body, parsed)
  const renumberedBody = renumberBody(body, plan)
  const rebuiltSources = renderSourcesBlock(
    plan,
    lines[headingIdx] // preserve the model's `##` heading level
  )
  // Trailing-newline handling — keep the original's terminator.
  const trailingNewline = /\n$/.test(trimmed) ? "" : ""
  return `${renumberedBody}\n\n${rebuiltSources}${trailingNewline}`
}
