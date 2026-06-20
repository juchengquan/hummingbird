import "server-only"

import { pdf } from "pdf-to-img"

export interface RenderPdfOptions {
  /** Hard cap on pages rendered (cost bound). Default 30. */
  maxPages?: number
  /** Render scale (≈ DPI/72). Default 2.0 (~144 DPI). */
  scale?: number
}

/**
 * Render PDF pages to PNG buffers via `pdf-to-img` (pdfjs-dist +
 * @napi-rs/canvas, a known-good pairing). Caps at `maxPages` to bound
 * cost. Throws if the document can't be parsed/rendered — callers in the
 * vision path treat any throw as "fall back to text-only".
 */
export async function renderPdfPages(
  data: Uint8Array,
  opts: RenderPdfOptions = {}
): Promise<Buffer[]> {
  const { maxPages = 30, scale = 2.0 } = opts
  if (maxPages <= 0) return []
  const doc = await pdf(Buffer.from(data), { scale })
  const out: Buffer[] = []
  for await (const page of doc) {
    out.push(page)
    if (out.length >= maxPages) break
  }
  return out
}
