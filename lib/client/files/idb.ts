import "client-only"
/**
 * Shared IndexedDB plumbing for the client-side file stores
 * (`local-store.ts` — raw file blobs; `blob-fields.ts` — the large
 * `UploadedFile` fields kept out of localStorage).
 *
 * Every helper resolves to `null` / `false` instead of rejecting when
 * IndexedDB isn't usable (SSR, private-mode Safari with quota = 0, an
 * upgrade blocked by another tab), so callers never need try/catch.
 */

let factoryOverride: IDBFactory | null | undefined

/** Test seam: route every database open through `factory` (e.g. a
 *  `fake-indexeddb` `IDBFactory`). `null` simulates "IndexedDB
 *  unavailable"; `undefined` restores the global. Clears the open-
 *  connection cache so the next call reopens against the new factory. */
export function __setIndexedDBFactoryForTests(
  factory: IDBFactory | null | undefined
): void {
  factoryOverride = factory
  for (const p of openConnections.values()) {
    void p.then((db) => db?.close())
  }
  openConnections.clear()
}

function resolveFactory(): IDBFactory | null {
  if (factoryOverride !== undefined) return factoryOverride
  if (typeof window === "undefined") return null
  return typeof window.indexedDB !== "undefined" ? window.indexedDB : null
}

const openConnections = new Map<string, Promise<IDBDatabase | null>>()

/** Drop the cached connection for `name` — only if it is still `p` (a
 *  newer connection may already be cached). */
function forget(name: string, p: Promise<IDBDatabase | null>): void {
  if (openConnections.get(name) === p) openConnections.delete(name)
}

/** Drop whatever connection is cached for `db.name` if it is `db`. */
function forgetDb(db: IDBDatabase): void {
  const cached = openConnections.get(db.name)
  if (!cached) return
  void cached.then((current) => {
    if (current === db) forget(db.name, cached)
  })
}

/**
 * Open (and cache) a database with the given object stores. The
 * connection closes itself on `versionchange` so a future schema bump
 * in another tab is never blocked by this one. A failed / blocked open
 * is NOT cached — the next call retries.
 */
export function openDatabase(
  name: string,
  version: number,
  stores: readonly string[]
): Promise<IDBDatabase | null> {
  const cached = openConnections.get(name)
  if (cached) return cached
  const factory = resolveFactory()
  if (!factory) return Promise.resolve(null)
  const p = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = factory.open(name, version)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of stores) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => {
        db.close()
        forget(name, p)
      }
      // The browser closed the connection on us (Safari drops it after
      // a while in the background, storage pressure, "clear site data").
      // Every op on the cached handle would now throw InvalidStateError
      // for the rest of the session: drop it so the next call reopens.
      db.onclose = () => forget(name, p)
      resolve(db)
    }
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  openConnections.set(name, p)
  void p.then((db) => {
    if (!db) forget(name, p)
  })
  return p
}

/** Run `fn` in one transaction over `store`; resolves once it commits.
 *  Rejects on abort / error so callers can treat the write as failed. */
export async function runTransaction<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => T
): Promise<T> {
  let transaction: IDBTransaction
  try {
    transaction = db.transaction(store, mode)
  } catch (err) {
    // InvalidStateError: the connection is closing / closed without a
    // `close` event reaching us. Forget it so the next call reopens.
    if (err instanceof DOMException && err.name === "InvalidStateError") {
      forgetDb(db)
    }
    throw err
  }
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  const result = fn(transaction.objectStore(store))
  await done
  return result
}
