/**
 * Single decision point for "where does this blob live?" after the user
 * attaches a file. Three modes:
 *
 *   - cloud      — signed-in + Supabase configured + `localFilesOnly` off.
 *                  Blob → Supabase Storage at `{user_id}/{file_id}.{ext}`.
 *                  Mirror copy also written to IndexedDB for fast re-extraction
 *                  on this device.
 *   - local      — `localFilesOnly` toggle on, or no Supabase session.
 *                  Blob → IndexedDB only.
 *   - skip       — IDB unavailable (private mode, quota=0) and not signed in.
 *                  No persistence; blob is lost after extraction. We still
 *                  return ok so the file row exists with metadata + extracted
 *                  text.
 *
 * Returns the storagePath when Supabase Storage succeeded (so the caller can
 * record it on the `UploadedFile` row). Returns `null` for local/skip.
 *
 * Errors fall through silently — extraction has already happened and the
 * user has a usable file row regardless of where the blob ended up.
 */

import { storeBlob } from './local-store'
import { getSupabaseBrowserClient } from '@/client/supabase/client'
import { useStore } from '@/client/hooks/use-store'

export type PersistMode = 'cloud' | 'local' | 'skip'

export interface PersistResult {
  mode: PersistMode
  storagePath: string | null
  /** True when the blob is reachable from IndexedDB on this device. */
  cachedLocally: boolean
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i < 0 || i === name.length - 1) return 'bin'
  return name.slice(i + 1).toLowerCase()
}

async function uploadToSupabase(
  blob: Blob,
  fileId: string,
  name: string,
  userId: string
): Promise<string | null> {
  const client = getSupabaseBrowserClient()
  if (!client) return null
  const path = `${userId}/${fileId}.${extOf(name)}`
  const { error } = await client.storage
    .from('user-files')
    .upload(path, blob, {
      contentType: blob.type || 'application/octet-stream',
      upsert: false,
    })
  if (error) return null
  return path
}

export interface PersistOptions {
  /** Optional override for the userId — useful when caller already has it. */
  userId?: string
}

export async function persistFile(
  blob: Blob,
  fileId: string,
  name: string,
  opts: PersistOptions = {}
): Promise<PersistResult> {
  const localFilesOnly = useStore.getState().localFilesOnly
  const localOnlyMode = useStore.getState().localOnlyMode

  // Resolve userId without a hard dependency on the auth hook so this can
  // be called from non-React code paths.
  let userId = opts.userId
  if (!userId && !localOnlyMode) {
    const client = getSupabaseBrowserClient()
    if (client) {
      const { data } = await client.auth.getUser()
      userId = data.user?.id
    }
  }

  // Cloud branch: signed in, Supabase configured, toggle off.
  if (userId && !localFilesOnly && !localOnlyMode) {
    const path = await uploadToSupabase(blob, fileId, name, userId)
    if (path) {
      // Best-effort local cache so re-extraction doesn't refetch.
      const cached = await storeBlob(fileId, blob)
      return { mode: 'cloud', storagePath: path, cachedLocally: cached }
    }
    // Fall through to local on upload failure — better to keep the file than
    // to lose it. The user can re-upload to cloud later by toggling the
    // setting (future migration tool will sweep these up).
  }

  // Local branch — every other case.
  const cached = await storeBlob(fileId, blob)
  return {
    mode: cached ? 'local' : 'skip',
    storagePath: null,
    cachedLocally: cached,
  }
}
