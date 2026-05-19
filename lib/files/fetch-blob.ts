/**
 * Resolve a stored `UploadedFile` back to a `Blob` for re-extraction or
 * preview. Tries the local IndexedDB cache first, then a short-lived
 * Supabase signed URL when the file has a `storagePath`. Returns `null`
 * when neither path works — caller should surface a "stored on another
 * device" or "blob unavailable" state.
 */

import type { UploadedFile } from '@/lib/types'
import { getBlob } from './local-store'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

const SIGNED_URL_TTL_SECONDS = 60

export async function fetchFileBlob(file: UploadedFile): Promise<Blob | null> {
  const local = await getBlob(file.id)
  if (local) return local

  if (!file.storagePath) return null

  const client = getSupabaseBrowserClient()
  if (!client) return null

  const signed = await client.storage
    .from('user-files')
    .createSignedUrl(file.storagePath, SIGNED_URL_TTL_SECONDS)
  if (signed.error || !signed.data?.signedUrl) return null

  try {
    const res = await fetch(signed.data.signedUrl)
    if (!res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
}

/**
 * Cheap "is this file reachable on this device?" check used by the row
 * UI to decide whether to render a "stored on another device" badge.
 *
 * Local IDB hit → true. Has `storagePath` → true (we can fetch it on
 * demand). Otherwise false.
 */
export async function isFileLocallyAvailable(file: UploadedFile): Promise<boolean> {
  if (file.storagePath) return true
  const local = await getBlob(file.id)
  return local !== null
}
