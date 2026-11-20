import "server-only"

/**
 * Read a request body into memory with a hard byte cap.
 *
 * `req.formData()` / `req.arrayBuffer()` buffer the WHOLE body before a
 * route can look at sizes, so a multi-GB upload is fully read before
 * it's rejected. This:
 *   1. rejects up front when `Content-Length` already exceeds the cap;
 *   2. streams the body and aborts as soon as the running total passes
 *      the cap (covers chunked uploads and lying `Content-Length`s).
 */

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`)
    this.name = "BodyTooLargeError"
  }
}

export async function readBodyCapped(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length")
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new BodyTooLargeError(maxBytes)
  }
  if (!req.body) return new Uint8Array(0)

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}
