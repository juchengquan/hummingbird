import "server-only"

/**
 * Persistence layer for `generateImage` tool output.
 *
 * Minimax returns short-lived hosted URLs (typically valid for several
 * hours). To survive a page reload — or just a tab left open
 * overnight — we download each image once and persist it client-side.
 *
 * This first cut ships **data-URL persistence only**:
 *   - Server downloads each Minimax URL with a tight timeout.
 *   - Encodes the bytes as `data:image/<format>;base64,<...>`.
 *   - Returns the data URLs so the chat route can emit them on the
 *     `tool_image` SSE frame.
 *   - Client appends them to `Message.generatedImages`; they round-trip
 *     through localStorage like any other message field.
 *
 * A Supabase Storage upgrade is planned (the bucket + signed-URL
 * machinery) for a follow-up PR. The function signature is designed to
 * absorb that: when storage is configured + a user-id is available we
 * upload to a per-user bucket path and return the signed URL instead.
 * For now the implementation always returns data URLs and the rest of
 * the code is agnostic about which kind it gets.
 *
 * Size posture:
 *   - Per-image cap: 4 MB raw bytes (refuse to encode larger). Image
 *     gen at default Minimax sizes is typically 500 KB – 1.5 MB; the
 *     cap is the safety belt against an unexpectedly huge response.
 *   - Per-turn cap is already enforced upstream by the skill's
 *     `maxCalls` × `MAX_IMAGES_PER_CALL` (= 5 × 4 = 20 images max).
 *     Worst-case data-URL footprint per turn ≈ 80 MB raw, ~107 MB
 *     base64-encoded. That's a lot for localStorage — the practical
 *     bound from the per-IP rate limit is far tighter.
 */

const DOWNLOAD_TIMEOUT_MS = 10_000
const MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024

export interface ImageToPersist {
  url: string
  width: number
  height: number
  format: string
}

export interface PersistedImage {
  /** Either a Supabase Storage signed URL (future) or a `data:` URL
   *  (today). Caller doesn't need to know which — both load directly
   *  in an `<img>`. */
  url: string
  width: number
  height: number
  format: string
}

export interface PersistImagesOpts {
  /** Conversation + message context. Reserved for the Supabase
   *  Storage upgrade path (bucket key includes them); ignored by the
   *  data-URL implementation. */
  conversationId?: string
  messageId?: string
  /** Upstream signal — when the chat tab closes we abort the
   *  downloads instead of letting them run to completion as zombie
   *  outbound work. */
  signal?: AbortSignal
}

export type PersistImagesResult =
  | { ok: true; images: PersistedImage[] }
  | { ok: false; error: string }

/**
 * Download every Minimax-hosted URL in parallel and return persisted
 * versions. On a per-image failure we drop that image rather than
 * fail the whole batch — the model already saw the tool succeed, so
 * the user-facing message just shows fewer images than expected.
 *
 * Returns `{ ok: false }` only when ALL images fail (so the chat
 * route can fall back to surfacing the failure).
 */
export async function persistGeneratedImages(
  inputs: ImageToPersist[],
  opts: PersistImagesOpts = {}
): Promise<PersistImagesResult> {
  if (inputs.length === 0) return { ok: true, images: [] }

  const results = await Promise.all(
    inputs.map((img) => downloadAsDataUrl(img, opts.signal))
  )
  const ok = results.filter(
    (r): r is { ok: true; image: PersistedImage } => r.ok
  )
  if (ok.length === 0) {
    const firstErr = results.find((r) => !r.ok) as
      | { ok: false; error: string }
      | undefined
    return {
      ok: false,
      error: firstErr?.error ?? "All image downloads failed",
    }
  }
  return { ok: true, images: ok.map((r) => r.image) }
}

async function downloadAsDataUrl(
  input: ImageToPersist,
  upstream?: AbortSignal
): Promise<
  | { ok: true; image: PersistedImage }
  | { ok: false; error: string }
> {
  const timer = new AbortController()
  const t = setTimeout(() => timer.abort(), DOWNLOAD_TIMEOUT_MS)
  const signal = upstream
    ? AbortSignal.any([timer.signal, upstream])
    : timer.signal
  try {
    const res = await fetch(input.url, { signal })
    if (!res.ok) {
      return {
        ok: false,
        error: `image download failed: HTTP ${res.status}`,
      }
    }
    const contentLength = Number(res.headers.get("content-length"))
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BYTES_PER_IMAGE
    ) {
      return {
        ok: false,
        error: `image too large (${contentLength} bytes > ${MAX_BYTES_PER_IMAGE})`,
      }
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BYTES_PER_IMAGE) {
      return {
        ok: false,
        error: `image too large (${buf.byteLength} bytes > ${MAX_BYTES_PER_IMAGE})`,
      }
    }
    // Trust the response's Content-Type over the model-supplied
    // format hint — Minimax says "png" everywhere but if they ever
    // return JPEG we don't want a corrupt data URL.
    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() ??
      `image/${input.format || "png"}`
    const base64 = Buffer.from(buf).toString("base64")
    return {
      ok: true,
      image: {
        url: `data:${mime};base64,${base64}`,
        width: input.width,
        height: input.height,
        format: mimeToFormat(mime, input.format),
      },
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "image download timed out or was aborted" }
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(t)
  }
}

function mimeToFormat(mime: string, fallback: string): string {
  // "image/png" → "png", "image/jpeg" → "jpg" (canonical short form
  // matches the GeneratedImage.format type's expectations).
  const sub = mime.split("/")[1]?.toLowerCase()
  if (!sub) return fallback || "png"
  if (sub === "jpeg") return "jpg"
  return sub
}
