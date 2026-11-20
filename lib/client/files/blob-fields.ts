import "client-only"
/**
 * Off-localStorage home for the heavy `UploadedFile` fields.
 *
 * `imageDataUrl` (a base64 photo is easily 2-6 MB) and
 * `extractedFullText` (up to ~1 MB) used to ride inside the persisted
 * Zustand blob, so one phone photo or a few long PDFs blew the 5-10 MB
 * localStorage quota and every later write failed. They now live in
 * IndexedDB (database `hummingbird-file-fields`, one record per file
 * id), and `partializeState` strips them from the persisted `files[]`.
 *
 * Lifecycle of a value:
 *
 *   1. Something puts it on a file row in memory — `setFileExtraction`
 *      after an upload, a cloud pull, a cross-tab merge, or a
 *      pre-v32 localStorage blob being rehydrated.
 *   2. `offloadFileBlobs` (wired to every `files` change + once after
 *      hydration in `use-store.ts`) writes it to IndexedDB.
 *   3. Only once that write has COMMITTED is the value recorded in the
 *      `durable` ledger; `stripDurableBlobFields` (used by
 *      `partializeState`) strips a field from the persisted row only
 *      when the ledger holds that exact value. Until then the value
 *      keeps persisting to localStorage as before — so a failed / slow /
 *      impossible IndexedDB write never loses data. That is also the
 *      private-mode fallback: with no IndexedDB nothing becomes durable
 *      and the old (quota-bound) localStorage behaviour stays in force.
 *   4. After a reload the row has no blob fields; readers go through
 *      the async accessors below (`getFileBlobFields`,
 *      `getFileImageDataUrl(s)`, the `useFileBlobFields` hook), which
 *      check the row itself, then the session cache, then IndexedDB.
 *   5. Tombstoning / clearing a file calls `deleteFileBlobFields` /
 *      `clearAllFileBlobFields` (via `cascade.ts` / the files slice).
 *
 * All IndexedDB ops for one file id run through a per-id queue, so a
 * delete issued after a write can't be overtaken by it.
 */

import type { UploadedFile } from "@/shared/types"

import { openDatabase, runTransaction } from "./idb"

export const FILE_BLOB_FIELDS = ["imageDataUrl", "extractedFullText"] as const
export type FileBlobField = (typeof FILE_BLOB_FIELDS)[number]
export type FileBlobFields = Partial<Pick<UploadedFile, FileBlobField>>

type FileLike = Pick<UploadedFile, "id"> & FileBlobFields

const DB_NAME = "hummingbird-file-fields"
const STORE = "fields"
const VERSION = 1

function openDB(): Promise<IDBDatabase | null> {
  return openDatabase(DB_NAME, VERSION, [STORE])
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/** The blob fields actually present (non-empty strings) on `file`, or
 *  `null` when it carries none. */
export function pickBlobFields(file: FileBlobFields): FileBlobFields | null {
  let out: FileBlobFields | null = null
  for (const key of FILE_BLOB_FIELDS) {
    const v = file[key]
    if (typeof v === "string" && v.length > 0) {
      out ??= {}
      out[key] = v
    }
  }
  return out
}

function sameFields(a: FileBlobFields | undefined, b: FileBlobFields): boolean {
  if (!a) return false
  for (const key of FILE_BLOB_FIELDS) {
    if (b[key] !== undefined && a[key] !== b[key]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Session state (in-memory, never persisted)
// ---------------------------------------------------------------------------

/** Values known for this session — from writes and IndexedDB reads. */
const cache = new Map<string, FileBlobFields>()
/** Values confirmed committed to IndexedDB. Gate for stripping. */
const durable = new Map<string, FileBlobFields>()
/** Bumped whenever `durable` changes — invalidates the array memo in
 *  `stripDurableBlobFieldsAll`. */
let durableEpoch = 0
/** Values queued for writing (dedup across rapid store changes). */
const inflight = new Map<string, FileBlobFields>()
/** Values whose write failed this session (not retried until reload). */
const failed = new Map<string, FileBlobFields>()
/** Ids whose IndexedDB record has been read into `cache` this session. */
const idbRead = new Set<string>()
/** Ids deleted this session — a late offload must not resurrect them. */
const deletedIds = new Set<string>()
/** Pending IndexedDB reads, de-duplicated per id. */
const loading = new Map<string, Promise<FileBlobFields>>()
/** Per-id op queue. */
const queues = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const cb of listeners) cb()
}

function enqueue<T>(id: string, op: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve()
  const next = prev.then(op, op)
  const tail = next.catch(() => undefined)
  queues.set(id, tail)
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id)
  })
  return next
}

function mergeInto(map: Map<string, FileBlobFields>, id: string, patch: FileBlobFields): void {
  if (map === durable) durableEpoch++
  map.set(id, { ...map.get(id), ...patch })
}

function dropKeys(map: Map<string, FileBlobFields>, id: string, keys: readonly FileBlobField[]): void {
  const cur = map.get(id)
  if (!cur) return
  if (map === durable) durableEpoch++
  const next = { ...cur }
  for (const k of keys) delete next[k]
  if (pickBlobFields(next)) map.set(id, next)
  else map.delete(id)
}

// ---------------------------------------------------------------------------
// IndexedDB primitives
// ---------------------------------------------------------------------------

/** `undefined` = IndexedDB unusable; `null` = no record. */
async function idbGet(id: string): Promise<FileBlobFields | null | undefined> {
  const db = await openDB()
  if (!db) return undefined
  try {
    const req = await runTransaction(db, STORE, "readonly", (s) => s.get(id))
    const v = req.result as unknown
    if (!v || typeof v !== "object") return null
    return pickBlobFields(v as FileBlobFields)
  } catch {
    return undefined
  }
}

/** Read-modify-write in ONE transaction: merge `patch`, drop `remove`. */
async function idbMerge(
  id: string,
  patch: FileBlobFields,
  remove: readonly FileBlobField[] = []
): Promise<boolean> {
  const db = await openDB()
  if (!db) return false
  try {
    await runTransaction(db, STORE, "readwrite", (s) => {
      const getReq = s.get(id)
      getReq.onsuccess = () => {
        const cur = (getReq.result ?? {}) as FileBlobFields
        const next: FileBlobFields = { ...cur, ...patch }
        for (const k of remove) delete next[k]
        if (pickBlobFields(next)) s.put(next, id)
        else s.delete(id)
      }
    })
    return true
  } catch {
    return false
  }
}

async function idbDelete(id: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    await runTransaction(db, STORE, "readwrite", (s) => s.delete(id))
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Persistence side (partialize + offload)
// ---------------------------------------------------------------------------

/** True when every blob field on `file` is committed to IndexedDB. */
export function isFileBlobDurable(file: FileLike): boolean {
  const fields = pickBlobFields(file)
  return fields === null || sameFields(durable.get(file.id), fields)
}

const strippedMemo = new WeakMap<object, UploadedFile>()

/**
 * The persisted form of a file row: blob fields removed iff they are
 * durable in IndexedDB, otherwise the row unchanged (so the value keeps
 * living in localStorage until a write succeeds). Memoised per row
 * object so the cross-tab merge's reference/JSON checks stay cheap.
 */
export function stripDurableBlobFields(file: UploadedFile): UploadedFile {
  const fields = pickBlobFields(file)
  if (!fields) return file
  if (!sameFields(durable.get(file.id), fields)) return file
  const memo = strippedMemo.get(file)
  if (memo) return memo
  const stripped: UploadedFile = { ...file }
  for (const key of FILE_BLOB_FIELDS) delete stripped[key]
  strippedMemo.set(file, stripped)
  return stripped
}

let lastStripped: {
  input: readonly UploadedFile[]
  epoch: number
  output: UploadedFile[]
} | null = null

/**
 * `stripDurableBlobFields` over a whole `files` array. Returns the input
 * array itself when nothing needs stripping, and memoises the last call
 * (keyed on array identity + ledger epoch) because `partializeState`
 * runs on every store write.
 */
export function stripDurableBlobFieldsAll(
  files: UploadedFile[]
): UploadedFile[] {
  if (
    lastStripped &&
    lastStripped.input === files &&
    lastStripped.epoch === durableEpoch
  ) {
    return lastStripped.output
  }
  let output: UploadedFile[] = files
  for (let i = 0; i < files.length; i++) {
    const next = stripDurableBlobFields(files[i])
    if (next !== files[i]) {
      if (output === files) output = files.slice()
      output[i] = next
    }
  }
  lastStripped = { input: files, epoch: durableEpoch, output }
  return output
}

/**
 * Write every not-yet-durable blob field found on `files` to IndexedDB.
 * Resolves `true` when at least one value newly became durable — the
 * caller then re-persists so localStorage drops the stripped values.
 * Never rejects. Tombstoned rows are skipped.
 */
export async function offloadFileBlobs(
  files: readonly UploadedFile[]
): Promise<boolean> {
  const writes: Promise<boolean>[] = []
  for (const file of files) {
    if (file.deletedAt || deletedIds.has(file.id)) continue
    const fields = pickBlobFields(file)
    if (!fields) continue
    // Make the value readable through the accessors immediately.
    if (!sameFields(cache.get(file.id), fields)) {
      mergeInto(cache, file.id, fields)
      emit()
    }
    if (sameFields(durable.get(file.id), fields)) continue
    if (sameFields(inflight.get(file.id), fields)) continue
    // Don't hammer a broken IndexedDB (private mode, quota 0) on every
    // store change: a value that failed once is retried next session.
    if (sameFields(failed.get(file.id), fields)) continue
    mergeInto(inflight, file.id, fields)
    const id = file.id
    writes.push(
      enqueue(id, async () => {
        if (deletedIds.has(id)) return false
        const ok = await idbMerge(id, fields)
        if (ok && !deletedIds.has(id)) mergeInto(durable, id, fields)
        if (!ok) mergeInto(failed, id, fields)
        return ok
      }).finally(() => {
        if (sameFields(inflight.get(id), fields)) inflight.delete(id)
      })
    )
  }
  if (writes.length === 0) return false
  const results = await Promise.all(writes)
  return results.some(Boolean)
}

/**
 * Explicitly clear some fields for a file that's still live (e.g. a
 * re-extraction that no longer produced a distinct full text), so a
 * stale value isn't served from IndexedDB later.
 */
export function clearFileBlobFields(
  fileId: string,
  fields: readonly FileBlobField[]
): Promise<void> {
  if (fields.length === 0) return Promise.resolve()
  dropKeys(cache, fileId, fields)
  dropKeys(durable, fileId, fields)
  dropKeys(inflight, fileId, fields)
  emit()
  return enqueue(fileId, async () => {
    await idbMerge(fileId, {}, fields)
  })
}

/** Cascade delete for a tombstoned / removed file. */
export function deleteFileBlobFields(fileId: string): Promise<void> {
  deletedIds.add(fileId)
  idbRead.delete(fileId)
  cache.delete(fileId)
  if (durable.delete(fileId)) durableEpoch++
  inflight.delete(fileId)
  emit()
  return enqueue(fileId, () => idbDelete(fileId))
}

/** Wipe every stored blob field (the "clear all files" action). */
export async function clearAllFileBlobFields(): Promise<void> {
  for (const id of [...cache.keys(), ...durable.keys(), ...inflight.keys()]) {
    deletedIds.add(id)
  }
  cache.clear()
  durable.clear()
  durableEpoch++
  inflight.clear()
  idbRead.clear()
  emit()
  // Let queued per-id ops settle first so none lands after the clear.
  await Promise.all([...queues.values()])
  const db = await openDB()
  if (!db) return
  try {
    await runTransaction(db, STORE, "readwrite", (s) => s.clear())
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Read side (async accessors)
// ---------------------------------------------------------------------------

/** Synchronous best-effort view: the row's own fields over the session
 *  cache. `undefined` when neither has anything yet. */
export function peekFileBlobFields(file: FileLike): FileBlobFields | undefined {
  const own = pickBlobFields(file)
  const cached = cache.get(file.id)
  if (!own && !cached) return undefined
  return { ...cached, ...own }
}

/** Resolve a file's blob fields: row → session cache → IndexedDB.
 *  Never rejects; resolves `{}` when nothing is stored. */
export async function getFileBlobFields(file: FileLike): Promise<FileBlobFields> {
  const own = pickBlobFields(file)
  // Fast path: the row already has both fields, or IndexedDB was
  // already read for this id (later writes keep `cache` current).
  if (own && own.imageDataUrl && own.extractedFullText) return own
  if (idbRead.has(file.id) || deletedIds.has(file.id)) {
    return { ...cache.get(file.id), ...own }
  }
  let p = loading.get(file.id)
  if (!p) {
    const id = file.id
    p = enqueue(id, async () => {
      const stored = await idbGet(id)
      if (stored !== undefined && !deletedIds.has(id)) idbRead.add(id)
      if (stored && !deletedIds.has(id)) {
        // Don't let an older IDB value shadow a newer one written
        // through `offloadFileBlobs` while the read was queued.
        cache.set(id, { ...stored, ...cache.get(id) })
        if (!durable.has(id)) mergeInto(durable, id, stored)
        emit()
      }
      return cache.get(id) ?? {}
    }).finally(() => loading.delete(id))
    loading.set(id, p)
  }
  const loaded = await p
  return { ...loaded, ...own }
}

export async function getFileImageDataUrl(file: FileLike): Promise<string | undefined> {
  return (await getFileBlobFields(file)).imageDataUrl
}

/** Image data URLs for `files`, in order, skipping files without one. */
export async function getFileImageDataUrls(
  files: readonly FileLike[]
): Promise<string[]> {
  const urls = await Promise.all(files.map(getFileImageDataUrl))
  return urls.filter((u): u is string => typeof u === "string")
}

/** Bulk accessor keyed by file id (used by the cloud bulk upload). */
export async function loadFileBlobFieldsMap(
  files: readonly FileLike[]
): Promise<Map<string, FileBlobFields>> {
  const entries = await Promise.all(
    files.map(async (f) => [f.id, await getFileBlobFields(f)] as const)
  )
  return new Map(entries)
}

/** Subscribe to session-cache changes (for `useSyncExternalStore`). */
export function subscribeFileBlobFields(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Session-cache snapshot for one id (stable reference until changed). */
export function getCachedFileBlobFields(fileId: string): FileBlobFields | undefined {
  return cache.get(fileId)
}

/** Test-only: forget all session state. */
export function __resetFileBlobFieldsForTests(): void {
  cache.clear()
  durable.clear()
  durableEpoch++
  lastStripped = null
  inflight.clear()
  failed.clear()
  idbRead.clear()
  deletedIds.clear()
  loading.clear()
  queues.clear()
  listeners.clear()
}
