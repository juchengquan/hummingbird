import "client-only"
/**
 * Tiny IndexedDB wrapper for storing raw file blobs keyed by file id.
 *
 * Two callers use this:
 *   1. Local-files mode — the only home the blob has, since we deliberately
 *      don't upload to Supabase Storage.
 *   2. Cloud-files mode — best-effort cache so re-extraction or preview on
 *      the upload device doesn't need to refetch from Storage.
 *
 * Quota is browser-managed (~half of free disk by default, evictable under
 * pressure). The AccountMenu surfaces current usage via `estimateUsage` and
 * lets the user clear everything via `clearAll`.
 *
 * Operations resolve to `null` rather than rejecting when IndexedDB isn't
 * available (e.g. SSR, private-mode Safari with quota = 0) so callers
 * never need to wrap in try/catch.
 */

const DB_NAME = 'hummingbird-files'
const STORE = 'blobs'
const VERSION = 1

let dbPromise: Promise<IDBDatabase | null> | null = null

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'
}

function openDB(): Promise<IDBDatabase | null> {
  if (!isBrowser()) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    const req = window.indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode
): { store: IDBObjectStore; done: Promise<void> } {
  const transaction = db.transaction(STORE, mode)
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  return { store: transaction.objectStore(STORE), done }
}

export async function storeBlob(fileId: string, blob: Blob): Promise<boolean> {
  const db = await openDB()
  if (!db) return false
  try {
    const { store, done } = tx(db, 'readwrite')
    store.put(blob, fileId)
    await done
    return true
  } catch {
    return false
  }
}

export async function getBlob(fileId: string): Promise<Blob | null> {
  const db = await openDB()
  if (!db) return null
  try {
    const { store, done } = tx(db, 'readonly')
    const req = store.get(fileId)
    await done
    const value = req.result
    return value instanceof Blob ? value : null
  } catch {
    return null
  }
}

export async function deleteBlob(fileId: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const { store, done } = tx(db, 'readwrite')
    store.delete(fileId)
    await done
  } catch {
    /* swallow — IDB errors are best-effort here */
  }
}

export async function clearAll(): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const { store, done } = tx(db, 'readwrite')
    store.clear()
    await done
  } catch {
    /* swallow */
  }
}

export interface StorageEstimate {
  /** Bytes used by this origin in IndexedDB (best-effort — browsers may pool). */
  usage: number
  /** Bytes available before eviction (browser-reported quota). */
  quota: number
}

export async function estimateUsage(): Promise<StorageEstimate | null> {
  if (!isBrowser() || !('storage' in navigator) || !navigator.storage.estimate) {
    return null
  }
  try {
    const est = await navigator.storage.estimate()
    return {
      usage: est.usage ?? 0,
      quota: est.quota ?? 0,
    }
  } catch {
    return null
  }
}
