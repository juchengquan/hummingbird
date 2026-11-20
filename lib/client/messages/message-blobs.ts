import "client-only"
/**
 * Off-localStorage home for the `data:` URL payloads on message
 * generated images / files (store v33). Sibling of
 * `client/files/blob-fields.ts` (v32, `UploadedFile` blob fields) and
 * built on the same rules + the same IndexedDB plumbing (`files/idb.ts`).
 *
 * When cloud storage isn't configured, `message.generatedImages[].url`
 * and `message.generatedFiles[].url` are base64 `data:` URLs — MBs each,
 * and they used to ride inside the persisted Zustand blob. They now live
 * in IndexedDB (database `hummingbird-message-blobs`, one record per
 * `<messageId>/<itemId>` key), and `partializeState` replaces each one in
 * the persisted copy with a placeholder REFERENCE (`hb-blob:<key>`, see
 * `shared/message-blob-ref.ts`). http(s) / signed URLs are left alone.
 *
 * Lifecycle of a value:
 *
 *   1. A `data:` URL lands on a message item in memory — a `tool_image` /
 *      `tool_file` stream frame, a cloud pull, a pre-v33 localStorage
 *      blob being rehydrated.
 *   2. `offloadMessageBlobs` (wired to every `conversations` change + once
 *      after hydration in `use-store.ts`) writes it to IndexedDB.
 *   3. Only once that write has COMMITTED is the value recorded in the
 *      `durable` ledger; `stripDurableMessageBlobs` (used by
 *      `partializeState`) swaps an item's URL for its reference only when
 *      the ledger holds that exact value. Until then the `data:` URL keeps
 *      persisting to localStorage as before — a failed / slow / impossible
 *      IndexedDB write never loses data, and with no IndexedDB at all
 *      (private mode) the pre-v33 behaviour stays in force.
 *   4. After a reload (or a cross-tab merge) the in-memory item carries
 *      the reference. Renderers resolve it through `resolveMessageBlobUrl`
 *      / `useMessageBlobUrl` (session cache → IndexedDB) and show a
 *      loading state meanwhile. The sync queue resolves it at flush time
 *      (`prepareMessageRowForUpload`) — a reference never reaches the cloud.
 *   5. When the last message referencing a key goes away (message /
 *      conversation / workspace delete, truncation, a pull that dropped
 *      it) `use-store.ts` calls `deleteMessageBlobs` for it
 *      (`removedMessageBlobKeys`).
 *
 * All IndexedDB ops for one key run through a per-key queue, and every
 * delete bumps the key's generation, so a write queued before a delete
 * can neither land after it nor mark the key durable afterwards.
 */

import type { Conversation, GeneratedFile, GeneratedImage, Message } from "@/shared/types"
import {
  blobKeyForItem,
  isInlineDataUrl,
  isMessageBlobRef,
  MESSAGE_BLOB_COLUMNS,
  messageBlobKey,
  messageBlobRef,
  parseMessageBlobRef,
  type BlobBearingItem,
} from "@/shared/message-blob-ref"

import { openDatabase, runTransaction } from "../files/idb"

const DB_NAME = "hummingbird-message-blobs"
const STORE = "blobs"
const VERSION = 1

function openDB(): Promise<IDBDatabase | null> {
  return openDatabase(DB_NAME, VERSION, [STORE])
}

// ---------------------------------------------------------------------------
// Session state (in-memory, never persisted)
// ---------------------------------------------------------------------------

/** Values known this session — from messages seen in memory and from
 *  IndexedDB reads. key → `data:` URL. */
const cache = new Map<string, string>()
/** Values confirmed committed to IndexedDB. The gate for stripping. */
const durable = new Map<string, string>()
/** Bumped whenever `durable` changes — invalidates the strip memos. */
let durableEpoch = 0
/** Values queued for writing (dedup across rapid store changes). */
const inflight = new Map<string, string>()
/** Values whose write failed this session (retried next session). */
const failed = new Map<string, string>()
/** Keys IndexedDB was asked for and didn't have (or couldn't answer).
 *  Lets readers show "unavailable" instead of loading forever. */
const missing = new Set<string>()
/** Per-key generation, bumped by every delete (see header). */
const generation = new Map<string, number>()
/** Pending IndexedDB reads, de-duplicated per key. */
const loading = new Map<string, Promise<string | undefined>>()
/** Per-key op queue. */
const queues = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()
/** Conversation objects already walked by the offload (store updates are
 *  immutable, so a walked object never needs walking again). */
let scanned = new WeakSet<Conversation>()

function emit(): void {
  for (const cb of listeners) cb()
}

function genOf(key: string): number {
  return generation.get(key) ?? 0
}

function enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(op, op)
  const tail = next.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

function setDurable(key: string, value: string): void {
  if (durable.get(key) === value) return
  durable.set(key, value)
  durableEpoch++
}

// ---------------------------------------------------------------------------
// IndexedDB primitives
// ---------------------------------------------------------------------------

/** `undefined` = IndexedDB unusable; `null` = no record. */
async function idbGet(key: string): Promise<string | null | undefined> {
  const db = await openDB()
  if (!db) return undefined
  try {
    const req = await runTransaction(db, STORE, "readonly", (s) => s.get(key))
    const v = req.result as unknown
    return typeof v === "string" && v.length > 0 ? v : null
  } catch {
    return undefined
  }
}

async function idbPut(key: string, value: string): Promise<boolean> {
  const db = await openDB()
  if (!db) return false
  try {
    await runTransaction(db, STORE, "readwrite", (s) => s.put(value, key))
    return true
  } catch {
    return false
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    await runTransaction(db, STORE, "readwrite", (s) => s.delete(key))
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Walking messages
// ---------------------------------------------------------------------------

type ItemVisitor = (key: string, item: BlobBearingItem, message: Message) => void

function forEachBlobItem(message: Message, visit: ItemVisitor): void {
  const lists: ReadonlyArray<readonly BlobBearingItem[] | undefined> = [
    message.generatedImages,
    message.generatedFiles,
  ]
  for (const list of lists) {
    if (!list) continue
    for (const item of list) {
      if (!item || typeof item.url !== "string") continue
      const key = blobKeyForItem(message.id, item)
      if (key) visit(key, item, message)
    }
  }
}

function messageHasBlobItems(m: Message): boolean {
  return (m.generatedImages?.length ?? 0) > 0 || (m.generatedFiles?.length ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Persistence side (prime + offload + strip)
// ---------------------------------------------------------------------------

/**
 * Make every inline `data:` URL in `conversations` readable through the
 * accessors / the flush-time resolver immediately (no IndexedDB).
 * Called synchronously at hydration so a sync flush that runs before the
 * deferred offload can still resolve its references.
 */
export function primeMessageBlobCache(conversations: readonly Conversation[]): void {
  let changed = false
  for (const c of conversations) {
    for (const m of c.messages ?? []) {
      if (!messageHasBlobItems(m)) continue
      forEachBlobItem(m, (key, item) => {
        if (!isInlineDataUrl(item.url) || cache.get(key) === item.url) return
        cache.set(key, item.url)
        missing.delete(key)
        changed = true
      })
    }
  }
  if (changed) emit()
}

/**
 * Write every not-yet-durable inline `data:` URL found in
 * `conversations` to IndexedDB. Resolves `true` when at least one value
 * newly became durable — the caller then re-persists so localStorage
 * drops it. Never rejects.
 */
export async function offloadMessageBlobs(
  conversations: readonly Conversation[]
): Promise<boolean> {
  const writes: Promise<boolean>[] = []
  let changed = false
  for (const c of conversations) {
    if (scanned.has(c)) continue
    scanned.add(c)
    for (const m of c.messages ?? []) {
      if (!messageHasBlobItems(m)) continue
      forEachBlobItem(m, (key, item) => {
        if (!isInlineDataUrl(item.url)) return
        const value = item.url
        // Readable through the accessors right away.
        if (cache.get(key) !== value) {
          cache.set(key, value)
          changed = true
        }
        if (missing.delete(key)) changed = true
        if (durable.get(key) === value) return
        if (inflight.get(key) === value) return
        // Don't hammer a broken IndexedDB (private mode, quota 0) on
        // every store change: a value that failed once is retried next
        // session.
        if (failed.get(key) === value) return
        writes.push(scheduleWrite(key, value))
      })
    }
  }
  if (changed) emit()
  if (writes.length === 0) return false
  const results = await Promise.all(writes)
  return results.some(Boolean)
}

function scheduleWrite(key: string, value: string): Promise<boolean> {
  const g = genOf(key)
  inflight.set(key, value)
  return enqueue(key, async () => {
    if (genOf(key) !== g) return false
    const ok = await idbPut(key, value)
    // Deleted while the write was in flight: the queued delete runs next
    // and removes the record; never mark it durable.
    if (genOf(key) !== g) return false
    if (ok) setDurable(key, value)
    else failed.set(key, value)
    return ok
  }).finally(() => {
    if (inflight.get(key) === value) inflight.delete(key)
  })
}

/** True when the inline value at `key` is committed to IndexedDB. */
export function isMessageBlobDurable(key: string, value: string): boolean {
  return durable.get(key) === value
}

function stripItems<T extends BlobBearingItem>(
  messageId: string,
  items: T[] | undefined
): T[] | undefined {
  if (!items) return items
  let out: T[] | null = null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || !isInlineDataUrl(item.url)) continue
    const key = messageBlobKey(messageId, item.id)
    if (durable.get(key) !== item.url) continue
    out ??= items.slice()
    out[i] = { ...item, url: messageBlobRef(key) }
  }
  return out ?? items
}

function stripMessage(m: Message): Message {
  if (!messageHasBlobItems(m)) return m
  const images = stripItems<GeneratedImage>(m.id, m.generatedImages)
  const files = stripItems<GeneratedFile>(m.id, m.generatedFiles)
  if (images === m.generatedImages && files === m.generatedFiles) return m
  return {
    ...m,
    ...(images !== m.generatedImages ? { generatedImages: images } : {}),
    ...(files !== m.generatedFiles ? { generatedFiles: files } : {}),
  }
}

const convMemo = new WeakMap<Conversation, { epoch: number; out: Conversation }>()

/** The persisted form of one conversation: durable inline payloads
 *  replaced by references (memoised per object + ledger epoch). */
export function stripDurableMessageBlobsInConversation(c: Conversation): Conversation {
  const hit = convMemo.get(c)
  if (hit && hit.epoch === durableEpoch) return hit.out
  let messages: Message[] | null = null
  const src = c.messages ?? []
  for (let i = 0; i < src.length; i++) {
    const next = stripMessage(src[i])
    if (next === src[i]) continue
    messages ??= src.slice()
    messages[i] = next
  }
  // Keep the previous output object when nothing it depends on changed,
  // so the cross-tab merge's reference checks stay cheap.
  const out = messages ? { ...c, messages } : c
  convMemo.set(c, { epoch: durableEpoch, out })
  return out
}

let lastStripped: {
  input: readonly Conversation[]
  epoch: number
  output: Conversation[]
} | null = null

/**
 * `partializeState` hook: the conversations array with every DURABLE
 * inline payload swapped for its reference. Values not yet confirmed in
 * IndexedDB keep persisting as `data:` URLs. Returns the input array
 * when nothing needs stripping.
 */
export function stripDurableMessageBlobs(conversations: Conversation[]): Conversation[] {
  if (
    lastStripped &&
    lastStripped.input === conversations &&
    lastStripped.epoch === durableEpoch
  ) {
    return lastStripped.output
  }
  let output: Conversation[] = conversations
  if (durable.size > 0) {
    for (let i = 0; i < conversations.length; i++) {
      const next = stripDurableMessageBlobsInConversation(conversations[i])
      if (next === conversations[i]) continue
      if (output === conversations) output = conversations.slice()
      output[i] = next
    }
  }
  lastStripped = { input: conversations, epoch: durableEpoch, output }
  return output
}

// ---------------------------------------------------------------------------
// Cascade deletes
// ---------------------------------------------------------------------------

const keysMemo = new WeakMap<Conversation, ReadonlySet<string>>()
const EMPTY_KEYS: ReadonlySet<string> = new Set()

/** Every IndexedDB key `c`'s messages carry or reference. */
export function collectMessageBlobKeys(c: Conversation): ReadonlySet<string> {
  const hit = keysMemo.get(c)
  if (hit) return hit
  let keys: Set<string> | null = null
  for (const m of c.messages ?? []) {
    if (!messageHasBlobItems(m)) continue
    forEachBlobItem(m, (key) => {
      keys ??= new Set()
      keys.add(key)
    })
  }
  const out = keys ?? EMPTY_KEYS
  keysMemo.set(c, out)
  return out
}

/**
 * Keys referenced by `prev` and by nothing in `next` — the IndexedDB
 * records a store change orphaned (deleted message / conversation /
 * workspace, truncated thread, a pull that dropped the row). A key still
 * referenced anywhere (e.g. by a fork's copied placeholder) is kept.
 * Cheap on the hot path: unchanged conversation objects are skipped.
 */
export function removedMessageBlobKeys(
  prev: readonly Conversation[],
  next: readonly Conversation[]
): string[] {
  if (prev === next) return []
  const nextById = new Map<string, Conversation>()
  for (const c of next) nextById.set(c.id, c)
  const candidates = new Set<string>()
  for (const p of prev) {
    const n = nextById.get(p.id)
    if (n === p) continue
    const before = collectMessageBlobKeys(p)
    if (before.size === 0) continue
    const after = n ? collectMessageBlobKeys(n) : EMPTY_KEYS
    for (const k of before) if (!after.has(k)) candidates.add(k)
  }
  if (candidates.size === 0) return []
  for (const c of next) {
    for (const k of collectMessageBlobKeys(c)) candidates.delete(k)
    if (candidates.size === 0) return []
  }
  return [...candidates]
}

/** Cascade delete: forget `keys` this session and remove their records. */
export function deleteMessageBlobs(keys: Iterable<string>): Promise<void> {
  const ops: Promise<void>[] = []
  let changed = false
  for (const key of keys) {
    generation.set(key, genOf(key) + 1)
    if (cache.delete(key)) changed = true
    if (durable.delete(key)) durableEpoch++
    inflight.delete(key)
    failed.delete(key)
    loading.delete(key)
    missing.add(key)
    ops.push(enqueue(key, () => idbDelete(key)))
  }
  if (changed) emit()
  return Promise.all(ops).then(() => undefined)
}

// ---------------------------------------------------------------------------
// Read side (async accessors)
// ---------------------------------------------------------------------------

/** Synchronous best-effort view: a non-reference URL as-is, a
 *  reference's value from the session cache, else `undefined`. */
export function peekMessageBlobUrl(url: string): string | undefined {
  const key = parseMessageBlobRef(url)
  if (!key) return url
  return cache.get(key)
}

/** Session-cache value for `key` (stable until changed). */
export function getCachedMessageBlob(key: string): string | undefined {
  return cache.get(key)
}

/** True once a lookup for `key` found nothing (or IndexedDB was unusable). */
export function isMessageBlobMissing(key: string): boolean {
  return missing.has(key)
}

/**
 * Resolve an item URL to something loadable: non-reference URLs come
 * back unchanged; a reference resolves through the session cache, then
 * IndexedDB. `undefined` when the bytes aren't available. Never rejects.
 */
export async function resolveMessageBlobUrl(url: string): Promise<string | undefined> {
  const key = parseMessageBlobRef(url)
  if (!key) return url
  const hit = cache.get(key)
  if (hit) return hit
  let p = loading.get(key)
  if (!p) {
    const g = genOf(key)
    p = enqueue(key, async () => {
      // A value written (or seen in memory) while this read was queued wins.
      const fresh = cache.get(key)
      if (fresh) return fresh
      const stored = await idbGet(key)
      if (genOf(key) !== g) return cache.get(key)
      if (stored) {
        // Session cache only. Deliberately NOT recorded as durable: the
        // strip ledger tracks this session's own confirmed writes, and a
        // read must not churn the persist memos. (An identical inline
        // copy that shows up later — e.g. via a pull — is simply
        // re-written once, then stripped.)
        cache.set(key, stored)
        missing.delete(key)
      } else {
        missing.add(key)
      }
      emit()
      return stored ?? undefined
    }).finally(() => {
      if (loading.get(key) === p) loading.delete(key)
    })
    loading.set(key, p)
  }
  return p
}

/** Items with every reference resolved; `null` when any can't be. */
export async function resolveMessageBlobItems<T extends BlobBearingItem>(
  items: readonly T[]
): Promise<T[] | null> {
  const out = await Promise.all(
    items.map(async (item) => {
      if (!item || !isMessageBlobRef(item.url)) return item
      const url = await resolveMessageBlobUrl(item.url)
      return url ? { ...item, url } : null
    })
  )
  return out.every((x) => x !== null) ? (out as T[]) : null
}

/**
 * Flush-time preparation of a `messages` upsert row (`sync-queue.ts`) and
 * of the bulk upload (`reconcile.ts`). Every placeholder reference in
 * `generated_images` / `generated_files` is resolved back to its real
 * `data:` URL. If any item of a column can't be resolved, the column is
 * OMITTED from the row: Supabase's single-row upsert then leaves the
 * cloud value untouched instead of overwriting it with a placeholder or
 * a partial list. The returned row never contains a reference. Never
 * rejects.
 */
export async function prepareMessageRowForUpload(
  row: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let out = row
  for (const col of MESSAGE_BLOB_COLUMNS) {
    const items = row[col]
    if (!Array.isArray(items)) continue
    if (!items.some((it) => isMessageBlobRef((it as BlobBearingItem | null)?.url))) continue
    let resolved: BlobBearingItem[] | null = null
    try {
      resolved = await resolveMessageBlobItems(items as BlobBearingItem[])
    } catch {
      resolved = null
    }
    out = { ...out }
    if (resolved && !resolved.some((it) => isMessageBlobRef(it?.url))) {
      out[col] = resolved
    } else {
      delete out[col]
    }
  }
  return out
}

/** Subscribe to session-cache changes (for `useSyncExternalStore`). */
export function subscribeMessageBlobs(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Test-only: forget all session state (what a page reload does). */
export function __resetMessageBlobsForTests(): void {
  cache.clear()
  durable.clear()
  durableEpoch++
  lastStripped = null
  inflight.clear()
  failed.clear()
  missing.clear()
  generation.clear()
  loading.clear()
  queues.clear()
  listeners.clear()
  scanned = new WeakSet()
}

/** Test-only: settle every queued IndexedDB op. */
export async function __flushMessageBlobOpsForTests(): Promise<void> {
  while (queues.size > 0) await Promise.all([...queues.values()])
}
