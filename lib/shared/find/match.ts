/** Pure text-matching helpers for in-conversation find (⌘F). No DOM here:
 *  the client walker (`lib/client/find/highlight.ts`) turns text nodes into
 *  `FindSegment`s and the results back into DOM Ranges. */

/** Lower-case `s` without changing its length. A few characters lower-case
 *  to a different number of UTF-16 units ("İ" becomes "i̇"); those are kept as
 *  they are so every offset into the folded string is an offset into `s`. */
export function foldCase(s: string): string {
  let out = ""
  for (const ch of s) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

/** Case-insensitive, non-overlapping start offsets of `needle` within
 *  `haystack`, left to right. A needle that is empty or only whitespace
 *  yields no matches (so an all-spaces query doesn't "match everything"). */
export function findMatchOffsets(haystack: string, needle: string): number[] {
  if (needle.trim() === "") return []
  const hay = foldCase(haystack)
  const nee = foldCase(needle)
  const out: number[] = []
  let i = hay.indexOf(nee)
  while (i !== -1) {
    out.push(i)
    i = hay.indexOf(nee, i + nee.length)
  }
  return out
}

/** One run of text in document order (a DOM text node, in practice).
 *  `breakBefore` marks a block boundary (new paragraph, list item, message)
 *  between it and the previous segment; no match may span one. */
export interface FindSegment {
  text: string
  breakBefore: boolean
}

export interface SegmentPoint {
  segment: number
  offset: number
}

export interface SegmentMatch {
  start: SegmentPoint
  /** Exclusive end. A match that ends exactly where a segment ends is
   *  reported in that segment (offset === its length), not at offset 0 of
   *  the next one. */
  end: SegmentPoint
}

// Joins segments across a block break. A query is typed into a single-line
// input, so it can never contain this character and never match across it.
const BLOCK_BREAK = "\u0000"

/** Every case-insensitive occurrence of `query` across `segments`, as
 *  (segment, offset) start/end points in document order. Matches may run
 *  across adjacent inline segments ("foo **bar**") but never across a block
 *  break. */
export function findSegmentMatches(segments: FindSegment[], query: string): SegmentMatch[] {
  if (segments.length === 0 || query.trim() === "") return []

  let flat = ""
  const starts: number[] = []
  segments.forEach((seg, i) => {
    if (seg.breakBefore && i > 0) flat += BLOCK_BREAK
    starts.push(flat.length)
    flat += seg.text
  })

  const offsets = findMatchOffsets(flat, query)
  const out: SegmentMatch[] = []
  // Offsets ascend, so one forward pointer per edge finds each segment.
  let s = 0
  let e = 0
  for (const off of offsets) {
    const endOff = off + query.length
    // Start: the segment containing `off` (off < segment end).
    while (s < segments.length && off >= starts[s] + segments[s].text.length) s++
    // End: the first segment whose end reaches `endOff` (endOff <= segment end).
    if (e < s) e = s
    while (e < segments.length && endOff > starts[e] + segments[e].text.length) e++
    if (s >= segments.length || e >= segments.length) break
    out.push({
      start: { segment: s, offset: off - starts[s] },
      end: { segment: e, offset: endOff - starts[e] },
    })
  }
  return out
}

/** Next/prev index with wrap-around. `dir` is 1 (next) or -1 (prev).
 *  Returns 0 when there are no items. */
export function wrapIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0
  return (current + dir + total) % total
}
