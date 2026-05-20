/**
 * React hook: "is this file's blob reachable from this device?"
 *
 * Returns `available: boolean | null` (null = still checking).
 *
 * A file is considered available if it has either a `storagePath` (Supabase
 * Storage — fetchable on demand) OR a hit in IndexedDB. Local-only files
 * uploaded on another device fall through to `false`, which the file row
 * surfaces as a small "On another device" badge.
 *
 * Re-checks whenever the file id, storagePath, or the local-cache token
 * changes. Callers that just cleared the IDB cache can bump the token to
 * force a re-read.
 */

import { useEffect, useState } from 'react'

import type { UploadedFile } from '@/shared/types'
import { getBlob } from './local-store'

export function useFileAvailability(file: UploadedFile, cacheVersion = 0): boolean | null {
  // When the file has a storagePath we know it's reachable (Supabase
  // Storage will serve it on demand). Return that synchronously from
  // render — no need to dip through `null` first. The async IDB lookup
  // only runs for files without a storagePath, where we genuinely don't
  // know yet.
  const hasStoragePath = !!file.storagePath
  const [localAvailable, setLocalAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    if (hasStoragePath) return
    let cancelled = false
    void getBlob(file.id).then((blob) => {
      if (!cancelled) setLocalAvailable(blob !== null)
    })
    return () => {
      cancelled = true
    }
  }, [file.id, hasStoragePath, cacheVersion])

  return hasStoragePath ? true : localAvailable
}
