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

import type { UploadedFile } from '@/lib/types'
import { getBlob } from './local-store'

export function useFileAvailability(file: UploadedFile, cacheVersion = 0): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    if (file.storagePath) {
      setAvailable(true)
      return
    }
    void getBlob(file.id).then((blob) => {
      if (!cancelled) setAvailable(blob !== null)
    })
    return () => {
      cancelled = true
    }
  }, [file.id, file.storagePath, cacheVersion])

  return available
}
