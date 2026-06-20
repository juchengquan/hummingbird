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
 * windows — except a markdown table, which is split at row boundaries
 * with its header repeated on each piece so every fragment stays a
 * valid, self-describing table. Char-based (not token-based) on purpose:
 * zero deps, and the window size is a soft target, not a hard model limit.
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

/** True when `block` is a GFM pipe table: ≥2 lines, line 1 has a pipe,
 *  line 2 is a separator (only `|`, `-`, `:`, spaces; ≥1 `-` and a `|`),
 *  and at least half the lines contain a pipe. Strict enough that prose
 *  containing pipes is not misdetected. */
function isMarkdownTable(block: string): boolean {
  const lines = block.split("\n")
  if (lines.length < 2) return false
  const header = lines[0]
  const separator = lines[1].trim()
  if (!header.includes("|")) return false
  if (!separator.includes("|") || !separator.includes("-")) return false
  if (!/^[|\s:-]+$/.test(separator)) return false
  const rowish = lines.filter((l) => l.includes("|")).length
  return rowish >= Math.ceil(lines.length / 2)
}

/** Split an oversized markdown table into pieces that each fit `maxChars`,
 *  every piece = header + separator + as many body rows as fit. If even
 *  header+separator+the first row won't fit, fall back to `splitLong` on
 *  the whole block. Always keeps ≥1 row per piece (so a single huge row
 *  still makes progress — `maxChars` is a soft target, per this module). */
function splitTableByRows(table: string, maxChars: number, overlap: number): string[] {
  const lines = table.split("\n")
  const prefix = `${lines[0]}\n${lines[1]}`
  const body = lines.slice(2)
  if (body.length === 0 || prefix.length + 1 + body[0].length > maxChars) {
    return splitLong(table, maxChars, overlap)
  }
  const pieces: string[] = []
  let rows: string[] = []
  const pieceLength = () =>
    prefix.length + rows.reduce((n, r) => n + 1 + r.length, 0)
  for (const row of body) {
    if (rows.length > 0 && pieceLength() + 1 + row.length > maxChars) {
      pieces.push(`${prefix}\n${rows.join("\n")}`)
      rows = []
    }
    rows.push(row)
  }
  if (rows.length > 0) pieces.push(`${prefix}\n${rows.join("\n")}`)
  return pieces
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
      // Oversized paragraph: emit any real accumulated buffer, then split.
      if (buf && !seededOnly) chunks.push(buf)
      buf = ""
      seededOnly = false
      const pieces = isMarkdownTable(para)
        ? splitTableByRows(para, maxChars, overlap)
        : splitLong(para, maxChars, overlap)
      for (const piece of pieces) chunks.push(piece)
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
