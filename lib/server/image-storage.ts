import "server-only"

/**
 * Persistence layer for `generateImage` tool output.
 *
 * Minimax returns short-lived hosted URLs (typically valid for several
 * hours). To survive a page reload — or just a tab left open
 * overnight — we download each image once and persist it.
 *
 * Persistence mode is chosen per-request:
 *
 *   1. **Supabase Storage** (preferred) — when a Supabase session
 *      is present, upload the bytes to `user-files/{user_id}/generated/
 *      {image_id}.{format}` and mint a long-lived signed URL. The
 *      `storagePath` is also returned so the client can re-sign later
 *      if the URL ever expires (1-year TTL today, same as file uploads).
 *   2. **Data URL fallback** — anonymous / unconfigured Supabase, or
 *      any cloud upload failure. Returns `data:image/<format>;base64,
 *      <...>` so the image still renders. Heavier on localStorage but
 *      keeps anonymous-mode parity with PR B.
 *
 * Either way the caller treats the returned URL identically: it loads
 * directly in an `<img>` and round-trips through `Message.generatedImages`.
 *
 * Size posture:
 *   - Per-image cap: 4 MB raw bytes (refuse to persist larger).
 *   - Per-turn cap is upstream — `maxCalls` × `MAX_IMAGES_PER_CALL`.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseServerClient } from "@/server/supabase/server"
import type { Database } from "@/shared/supabase/types"

const DOWNLOAD_TIMEOUT_MS = 10_000
const MAX_BYTES_PER_IMAGE = 4 * 1024 * 1024
/** 1-year signed URLs — matches the file-upload flow in
 *  `hooks/use-upload-file.ts`. Client re-signs from `storagePath` when
 *  the URL ever expires. */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365

export interface ImageToPersist {
  /** Stable id used as the storage object name + the React key. The
   *  chat route derives it from the tool-call id + index so it survives
   *  retries deterministically. */
  id: string
  url: string
  width: number
  height: number
  format: string
}

export interface PersistedImage {
  id: string
  /** Either a Supabase Storage signed URL or a `data:` URL — the UI
   *  doesn't need to know which (both load in `<img>`). */
  url: string
  /** Set only when persistence went to Supabase Storage. Used by the
   *  client to re-sign a fresh URL if the original ever expires. */
  storagePath?: string
  width: number
  height: number
  format: string
}

export interface PersistImagesOpts {
  /** Conversation + message context. Reserved for callers that want to
   *  scope storage paths; the current implementation uses `image.id`
   *  directly, so these are accepted but unused. */
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

  // Resolve Supabase context once for the whole batch. Sharing the
  // client across uploads avoids one cookie-bound `getUser()` per
  // image. Either piece missing → data-URL path for the whole batch.
  const cloud = await resolveCloudContext()

  const results = await Promise.all(
    inputs.map((img) => persistOne(img, cloud, opts.signal))
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

interface CloudContext {
  client: SupabaseClient<Database>
  userId: string
}

async function resolveCloudContext(): Promise<CloudContext | null> {
  const client = await getSupabaseServerClient()
  if (!client) return null
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return { client, userId: data.user.id }
}

async function persistOne(
  input: ImageToPersist,
  cloud: CloudContext | null,
  upstream?: AbortSignal
): Promise<
  | { ok: true; image: PersistedImage }
  | { ok: false; error: string }
> {
  const downloaded = await downloadBytes(input, upstream)
  if (!downloaded.ok) return downloaded

  if (cloud) {
    // Try Supabase Storage first. Any failure falls through to data URL —
    // a slow / misbehaving bucket shouldn't break image generation for the
    // user. The signed URL has a 1-year TTL; storagePath travels with the
    // image so a future expiry can be repaired client-side.
    const uploaded = await uploadToBucket(input, downloaded.buf, downloaded.mime, cloud)
    if (uploaded) {
      return {
        ok: true,
        image: {
          id: input.id,
          url: uploaded.signedUrl,
          storagePath: uploaded.path,
          width: input.width,
          height: input.height,
          format: mimeToFormat(downloaded.mime, input.format),
        },
      }
    }
  }

  // Data URL fallback.
  const base64 = Buffer.from(downloaded.buf).toString("base64")
  return {
    ok: true,
    image: {
      id: input.id,
      url: `data:${downloaded.mime};base64,${base64}`,
      width: input.width,
      height: input.height,
      format: mimeToFormat(downloaded.mime, input.format),
    },
  }
}

interface DownloadedBytes {
  ok: true
  buf: ArrayBuffer
  mime: string
}

async function downloadBytes(
  input: ImageToPersist,
  upstream?: AbortSignal
): Promise<DownloadedBytes | { ok: false; error: string }> {
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
    // return JPEG we don't want a corrupt persistence.
    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() ??
      `image/${input.format || "png"}`
    return { ok: true, buf, mime }
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

async function uploadToBucket(
  input: ImageToPersist,
  buf: ArrayBuffer,
  mime: string,
  cloud: CloudContext
): Promise<{ path: string; signedUrl: string } | null> {
  // Path includes a `generated/` segment to keep generated images
  // visually separate from user uploads when browsing the bucket.
  // The RLS policies (migration 0003) gate by first folder segment
  // = userId, so any nested subfolder is fine.
  const ext = mimeToFormat(mime, input.format)
  const path = `${cloud.userId}/generated/${input.id}.${ext}`
  const { error: uploadError } = await cloud.client.storage
    .from("user-files")
    .upload(path, buf, {
      contentType: mime,
      upsert: true, // retries with the same image id should overwrite, not fail.
    })
  if (uploadError) return null
  const { data, error: signError } = await cloud.client.storage
    .from("user-files")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (signError || !data?.signedUrl) return null
  return { path, signedUrl: data.signedUrl }
}

function mimeToFormat(mime: string, fallback: string): string {
  const sub = mime.split("/")[1]?.toLowerCase()
  if (!sub) return fallback || "png"
  if (sub === "jpeg") return "jpg"
  return sub
}
