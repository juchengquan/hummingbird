import "server-only"

import { NextResponse } from "next/server"

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

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too_large" | "invalid_json"; maxBytes: number }

/**
 * `req.json()` with a byte cap. App Router route handlers have no default
 * body limit (and `proxy.ts` doesn't cover `/api`), so a bare `req.json()`
 * buffers whatever the client sends. Same two-step guard as
 * `readBodyCapped` (Content-Length first, then the streamed count), then
 * a UTF-8 decode + `JSON.parse`. Never throws: callers map `too_large` to
 * a 413 and `invalid_json` to their usual 400, in their own envelope.
 */
export async function readJsonCapped(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  let bytes: Uint8Array
  try {
    bytes = await readBodyCapped(req, maxBytes)
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { ok: false, reason: "too_large", maxBytes }
    return { ok: false, reason: "invalid_json", maxBytes }
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { ok: false, reason: "invalid_json", maxBytes }
  }
}

/** Human-readable size for 413 messages (`"256 KB"`, `"4 MB"`). */
export function formatBodyLimit(maxBytes: number): string {
  return maxBytes >= 1024 * 1024
    ? `${Math.round(maxBytes / (1024 * 1024))} MB`
    : `${Math.round(maxBytes / 1024)} KB`
}

export const PAYLOAD_TOO_LARGE_CODE = "payload_too_large"

/** Failure → response in the standard `{ code, message }` envelope:
 *  `413 payload_too_large` or `400 invalid_request`. Routes with an
 *  older `{ error }` envelope build their own from the same result. */
export function jsonBodyError(
  failure: Extract<JsonBodyResult, { ok: false }>
): NextResponse {
  return failure.reason === "too_large"
    ? NextResponse.json(
        {
          code: PAYLOAD_TOO_LARGE_CODE,
          message: `Request body exceeds ${formatBodyLimit(failure.maxBytes)}.`,
        },
        { status: 413 }
      )
    : NextResponse.json(
        { code: "invalid_request", message: "Body must be JSON." },
        { status: 400 }
      )
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
