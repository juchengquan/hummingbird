import "server-only"

/**
 * Persistence layer for files the `runCode` code interpreter writes to
 * `/tmp/outputs/`. Mirrors `image-storage.ts`, but the bytes arrive in
 * hand (base64 read back from the sandbox) so there is no download step.
 *
 *   1. **Supabase Storage** — when a session is present, upload to
 *      `user-files/{user_id}/generated/{id}-{name}` and mint a 1-year
 *      signed URL; `storagePath` is returned for a future re-sign path
 *      (not yet wired for files — see the spec's deferred follow-ups);
 *      until then a cloud-mode signed URL is valid for its 1-year TTL.
 *   2. **Data URL fallback** — anonymous / unconfigured Supabase, or any
 *      upload failure. Returns `data:{mime};base64,{...}`.
 *
 * No size cap here (deliberate): the upstream sandbox read-back already
 * bounds bytes via RESULT_FILE_MAX + RESULT_CAP.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseServerClient } from "@/server/supabase/server"
import type { Database } from "@/shared/supabase/types"

/** 1-year signed URLs — matches image-storage + the file-upload flow. */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365

export interface FileToPersist {
  /** Stable id used as the storage object-name prefix + the React key. */
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  bytes: Buffer
}

export interface PersistedFile {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  /** Supabase signed URL or a `data:` URL — the UI loads either in a link. */
  url: string
  /** Set only when persistence went to Storage; used to re-sign on expiry. */
  storagePath: string | null
}

export interface PersistFilesOpts {
  /** Reserved for interface parity; not yet threaded into the Supabase calls (no long download to abort — bytes are already in hand). */
  signal?: AbortSignal
  /** Mirror of the client's "Store files locally" preference. */
  localFilesOnly?: boolean
}

export type PersistFilesResult =
  | { ok: true; files: PersistedFile[] }
  | { ok: false; error: string }

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

/** Strip path separators from a model-chosen filename so it can't escape
 *  the user's storage folder. */
function safeName(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? name
  return base.replace(/[^A-Za-z0-9._-]/g, "_") || "file"
}

async function uploadToBucket(
  input: FileToPersist,
  cloud: CloudContext,
): Promise<{ path: string; signedUrl: string } | null> {
  const path = `${cloud.userId}/generated/${input.id}-${safeName(input.name)}`
  const { error: uploadError } = await cloud.client.storage
    .from("user-files")
    .upload(path, input.bytes, {
      contentType: input.mimeType,
      upsert: true,
    })
  if (uploadError) return null
  const { data, error: signError } = await cloud.client.storage
    .from("user-files")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)
  if (signError || !data?.signedUrl) return null
  return { path, signedUrl: data.signedUrl }
}

function persistOne(
  input: FileToPersist,
  cloud: CloudContext | null,
): Promise<PersistedFile> {
  const dataUrl = (): PersistedFile => ({
    id: input.id,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    url: `data:${input.mimeType};base64,${input.bytes.toString("base64")}`,
    storagePath: null,
  })
  if (!cloud) return Promise.resolve(dataUrl())
  return uploadToBucket(input, cloud).then((uploaded) =>
    uploaded
      ? {
          id: input.id,
          name: input.name,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          url: uploaded.signedUrl,
          storagePath: uploaded.path,
        }
      : dataUrl(),
  )
}

export async function persistGeneratedFiles(
  inputs: FileToPersist[],
  opts: PersistFilesOpts = {},
): Promise<PersistFilesResult> {
  if (inputs.length === 0) return { ok: true, files: [] }
  const cloud = opts.localFilesOnly ? null : await resolveCloudContext()
  const files = await Promise.all(inputs.map((f) => persistOne(f, cloud)))
  return { ok: true, files }
}
