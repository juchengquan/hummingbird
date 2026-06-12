import "server-only"

/**
 * Text chunking for the embedding pipeline (`docs/PLAN-local-rag.md`).
 * Splits a document's full text into overlapping, paragraph-aware
 * windows small enough to embed. Pure — no I/O, no model calls — so it's
 * unit-tested in isolation; the embedding + storage layers consume it.
 *
 * Strategy: pack whole paragraphs (split on blank lines) into windows up
 * to `maxChars`; carry an `overlapChars` tail from the previous window so
 * a match that straddles a boundary still surfaces. A single paragraph
 * longer than `maxChars` is hard-split into overlapping character
 * windows. Char-based (not token-based) on purpose: zero deps, and the
 * window size is a soft target, not a hard model limit.
 */

export interface ChunkOptions {
  /** Soft cap on characters per chunk. */
  maxChars?: number
  /** Characters of overlap carried between consecutive chunks. */
  overlapChars?: number
}

const DEFAULT_MAX_CHARS = 1500
const DEFAULT_OVERLAP = 200

/** Hard-split one oversized paragraph into overlapping windows. */
function splitLong(text: string, maxChars: number, overlap: number): string[] {
  const out: string[] = []
  const step = Math.max(1, maxChars - overlap)
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + maxChars))
    if (i + maxChars >= text.length) break
  }
  return out
}

/**
 * Chunk `text` into overlapping windows. Returns `[]` for empty input and
 * a single chunk when the text already fits.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const overlap = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, maxChars - 1)
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]

  // Paragraph units (collapse runs of blank lines).
  const paras = clean
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let buf = ""
  // True when `buf` holds only an overlap tail carried from the last
  // flush, with no new paragraph appended yet. Such a buffer must NOT be
  // emitted on its own (it would just repeat the previous chunk's tail).
  let seededOnly = false

  const flush = () => {
    if (buf) chunks.push(buf)
    // Seed the next buffer with an overlap tail of the one just flushed.
    buf = overlap > 0 && buf.length > overlap ? buf.slice(-overlap) : ""
    seededOnly = buf.length > 0
  }

  for (const para of paras) {
    if (para.length > maxChars) {
      // Oversized paragraph: emit any real accumulated buffer, then
      // hard-split the paragraph.
      if (buf && !seededOnly) chunks.push(buf)
      buf = ""
      seededOnly = false
      for (const piece of splitLong(para, maxChars, overlap)) chunks.push(piece)
      continue
    }
    const candidate = buf ? `${buf}\n\n${para}` : para
    if (candidate.length > maxChars) {
      flush()
      buf = buf ? `${buf}\n\n${para}` : para
      // If the overlap tail + para already overflow, drop the tail.
      if (buf.length > maxChars) buf = para
      seededOnly = false
    } else {
      buf = candidate
      seededOnly = false
    }
  }
  if (buf && !seededOnly && buf.trim()) chunks.push(buf)
  return chunks
}
