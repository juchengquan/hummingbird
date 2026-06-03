/**
 * Image persistence — agent-ts port of `lib/server/image-storage.ts`.
 *
 * Follow-up #5 of PLAN-agent-ts-followups. After a `generateImage`
 * tool call returns Minimax-hosted URLs, this module downloads each
 * image and mirrors it into Supabase Storage at
 * `user-files/<user_id>/generated/<image_id>.<ext>`. On any failure
 * (download / upload / sign) we silently fall back to a data: URL or
 * the original Minimax URL — the model's view of the tool call (a
 * successful "rendered N images" summary) stays the same; the user
 * just sees the image at whatever URL we could mint.
 *
 * Why a parallel impl instead of reusing
 * `lib/server/image-storage.ts`: that module resolves the Supabase
 * client from request cookies (`getSupabaseServerClient`), which
 * agent-ts has no equivalent for — we authenticate via JWT sub
 * claim, not cookies. We do have the service-role key + the user_id
 * from the verified JWT, which is enough to upload + sign under the
 * right path.
 */

import {
  sseFrame,
  type FrameInterceptor,
  type ToolResultFrame,
} from "./chat"
import { getEnv } from "./env"

const STORAGE_BUCKET = "user-files"
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365 // 1 year — matches /v1/images/refresh-url
const DOWNLOAD_TIMEOUT_MS = 15_000
const MAX_BYTES_PER_IMAGE = 8 * 1024 * 1024 // 8 MB — same cap as Next.js

export interface BuildImageInterceptorOpts {
  /** Verified JWT subject claim (Supabase user id). Empty falls back
   *  to data-URL persistence — same path as anonymous users. */
  userId: string
  /** Upstream request abort signal — cancels in-flight downloads on
   *  client disconnect. */
  signal?: AbortSignal
  /** Mirror of the chat client's "Store files locally" preference.
   *  When true, skip Storage entirely and inline as data: URLs. */
  localFilesOnly?: boolean
}

interface PersistedImage {
  id: string
  url: string
  storagePath?: string
  width: number
  height: number
  format: string
}

interface MinimaxImageOutput {
  ok?: boolean
  mode?: "t2i" | "i2i"
  prompt?: string
  images?: Array<{
    id?: string
    url?: string
    width?: number
    height?: number
    format?: string
  }>
}

/** Build the per-request frame interceptor passed to
 *  `chatStreamAiSdk`. For `generateImage` tool results, downloads +
 *  uploads the images, then yields a `data-tool-image` AI SDK v5
 *  custom data part the consumer renders inline. `id` collates parts
 *  that share the same id into one logical block on the consumer
 *  side; we key on the tool-call id so multiple `generateImage`
 *  calls in a single turn don't blend together. Other tools pass
 *  through with no extra frames. */
export function buildToolImageInterceptor(
  opts: BuildImageInterceptorOpts,
): FrameInterceptor {
  return async function* (
    frame: ToolResultFrame,
  ): AsyncIterable<string> {
    if (frame.name !== "generateImage") return
    const output = frame.output as MinimaxImageOutput | undefined
    if (!output?.ok || !Array.isArray(output.images) || output.images.length === 0) {
      return
    }
    const persisted = await persistGeneratedImages(
      output.images,
      frame.id || "img",
      opts,
    )
    if (persisted.length === 0) return
    const mode: "t2i" | "i2i" = output.mode === "i2i" ? "i2i" : "t2i"
    const prompt = typeof output.prompt === "string" ? output.prompt : ""
    const images = persisted.map((img) => ({
      id: img.id,
      url: img.url,
      ...(img.storagePath ? { storagePath: img.storagePath } : {}),
      width: img.width,
      height: img.height,
      format: img.format,
      prompt,
      mode,
    }))
    yield sseFrame({
      type: "data-tool-image",
      id: frame.id,
      data: { id: frame.id, mode, images },
    })
  }
}

/** Download + upload each image in parallel. Returns the persisted
 *  shape — the URL is a Supabase signed URL when cloud upload
 *  worked, a data: URL when it didn't (or when `localFilesOnly` is
 *  set / no user id), and skipped entirely when download failed. */
async function persistGeneratedImages(
  inputs: NonNullable<MinimaxImageOutput["images"]>,
  toolCallId: string,
  opts: BuildImageInterceptorOpts,
): Promise<PersistedImage[]> {
  const env = getEnv()
  const cloudEnabled =
    !opts.localFilesOnly &&
    !!opts.userId &&
    !!env.SUPABASE_URL &&
    !!env.SUPABASE_SERVICE_ROLE_KEY

  const results = await Promise.all(
    inputs.map((img, i) => persistOne(img, `${toolCallId}-${i}`, cloudEnabled, opts)),
  )
  return results.filter((r): r is PersistedImage => r !== null)
}

async function persistOne(
  input: NonNullable<MinimaxImageOutput["images"]>[number],
  imageId: string,
  cloudEnabled: boolean,
  opts: BuildImageInterceptorOpts,
): Promise<PersistedImage | null> {
  if (!input.url) return null
  const downloaded = await downloadBytes(input.url, opts.signal)
  if (!downloaded) return null

  const width = typeof input.width === "number" ? input.width : 0
  const height = typeof input.height === "number" ? input.height : 0
  const format = mimeToFormat(downloaded.mime, input.format ?? "png")

  if (cloudEnabled) {
    const uploaded = await uploadToBucket(
      imageId,
      format,
      downloaded.buf,
      downloaded.mime,
      opts.userId,
    )
    if (uploaded) {
      return {
        id: imageId,
        url: uploaded.signedUrl,
        storagePath: uploaded.path,
        width,
        height,
        format,
      }
    }
  }

  // Data URL fallback.
  const base64 = Buffer.from(downloaded.buf).toString("base64")
  return {
    id: imageId,
    url: `data:${downloaded.mime};base64,${base64}`,
    width,
    height,
    format,
  }
}

interface DownloadedBytes {
  buf: ArrayBuffer
  mime: string
}

async function downloadBytes(
  url: string,
  upstream?: AbortSignal,
): Promise<DownloadedBytes | null> {
  const timer = new AbortController()
  const t = setTimeout(() => timer.abort(), DOWNLOAD_TIMEOUT_MS)
  const signal = upstream
    ? AbortSignal.any([timer.signal, upstream])
    : timer.signal
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const contentLength = Number(res.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES_PER_IMAGE) {
      return null
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BYTES_PER_IMAGE) return null
    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/png"
    return { buf, mime }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function uploadToBucket(
  imageId: string,
  format: string,
  buf: ArrayBuffer,
  mime: string,
  userId: string,
): Promise<{ path: string; signedUrl: string } | null> {
  const env = getEnv()
  const base = env.SUPABASE_URL.replace(/\/+$/, "")
  const key = env.SUPABASE_SERVICE_ROLE_KEY.trim()
  const path = `${userId}/generated/${imageId}.${format}`

  try {
    const uploadRes = await fetch(
      `${base}/storage/v1/object/${STORAGE_BUCKET}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
          "Content-Type": mime,
          // `upsert: true` — same image id should overwrite rather than
          // 409 on retries. Storage REST encodes this via the
          // `x-upsert` header.
          "x-upsert": "true",
        },
        body: buf,
      },
    )
    if (!uploadRes.ok) return null

    const signRes = await fetch(
      `${base}/storage/v1/object/sign/${STORAGE_BUCKET}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
      },
    )
    if (!signRes.ok) return null
    const payload = (await signRes.json()) as { signedURL?: unknown }
    const signed = typeof payload.signedURL === "string" ? payload.signedURL : null
    if (!signed) return null
    const signedUrl = signed.startsWith("/")
      ? `${base}/storage/v1${signed}`
      : signed
    return { path, signedUrl }
  } catch {
    return null
  }
}

function mimeToFormat(mime: string, fallback: string): string {
  const sub = mime.split("/")[1]?.toLowerCase()
  if (!sub) return fallback || "png"
  if (sub === "jpeg") return "jpg"
  return sub
}
