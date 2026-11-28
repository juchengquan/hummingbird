/**
 * Placeholder references for the heavy `data:` URL payloads on message
 * generated images / files (store v33).
 *
 * When cloud storage isn't configured, `message.generatedImages[].url` and
 * `message.generatedFiles[].url` are base64 `data:` URLs (MBs each). The
 * client moves those bytes to IndexedDB (`client/messages/message-blobs.ts`)
 * and the persisted store keeps, in their place, a short REFERENCE:
 *
 *     hb-blob:<messageId>/<itemId>
 *
 * naming the IndexedDB key that holds the bytes. A reference is never a
 * loadable URL — renderers resolve it through the async accessors, and the
 * sync layer resolves it back to the real `data:` URL at flush time (or
 * omits the column), so a reference never reaches Supabase.
 *
 * The key is embedded in the reference (rather than derived from the
 * owning message) so a forked message — copied with a fresh message id —
 * still points at the bytes it was copied from.
 *
 * Pure helpers only; isomorphic so the sync diff (`handlers.ts`), the
 * snapshot merge and the library collector can all recognise references.
 */

export const MESSAGE_BLOB_REF_PREFIX = "hb-blob:"

/** Minimal shape shared by `GeneratedImage` and `GeneratedFile`. */
export interface BlobBearingItem {
  id: string
  url: string
}

/** IndexedDB key for item `itemId` of message `messageId`. */
export function messageBlobKey(messageId: string, itemId: string): string {
  return `${messageId}/${itemId}`
}

/** The placeholder reference for `key`. */
export function messageBlobRef(key: string): string {
  return MESSAGE_BLOB_REF_PREFIX + key
}

export function isMessageBlobRef(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(MESSAGE_BLOB_REF_PREFIX)
}

/** The key a reference names, or `null` for anything else. */
export function parseMessageBlobRef(url: unknown): string | null {
  if (!isMessageBlobRef(url)) return null
  const key = url.slice(MESSAGE_BLOB_REF_PREFIX.length)
  return key.length > 0 ? key : null
}

/** An inline payload that belongs in IndexedDB rather than localStorage. */
export function isInlineDataUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("data:")
}

/**
 * The IndexedDB key whose bytes an item carries or points at: its own
 * `<messageId>/<itemId>` for an inline `data:` URL, the referenced key
 * for a placeholder, `null` for http(s) / signed URLs (left alone).
 */
export function blobKeyForItem(messageId: string, item: BlobBearingItem): string | null {
  if (isInlineDataUrl(item.url)) return messageBlobKey(messageId, item.id)
  return parseMessageBlobRef(item.url)
}

/**
 * Canonical (sync / hashing) form of an item list: every inline `data:`
 * URL is replaced by the reference it will be stored under, references
 * stay as they are. So "data URL in memory" and "stripped to a reference
 * after the IndexedDB write" compare and hash identically — a strip is
 * never mistaken for an edit. Returns the input array when nothing changed.
 */
export function canonicalBlobItems<T extends BlobBearingItem>(
  messageId: string,
  items: readonly T[]
): readonly T[] {
  let out: T[] | null = null
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!isInlineDataUrl(item.url)) continue
    out ??= items.slice()
    out[i] = { ...item, url: messageBlobRef(messageBlobKey(messageId, item.id)) }
  }
  return out ?? items
}

/** Message columns that may carry blob-bearing items. */
export const MESSAGE_BLOB_COLUMNS = ["generated_images", "generated_files"] as const

// ---------------------------------------------------------------------------
// Artifacts (store v34)
// ---------------------------------------------------------------------------
//
// `Artifact.storagePath` of an image / file artifact created from a
// generated item used to be a copy of the item's URL — so an inline
// `data:` payload was stored twice (message + artifact). From v34 such an
// artifact carries a reference into the SAME IndexedDB store instead:
//
//   - created from a generated item → the item's own key
//     (`hb-blob:<messageId>/<itemId>`), so both share one record;
//   - an inline value with no matching item (pre-v34 data, a pull, an
//     orphaned artifact) → its own key, `hb-blob:artifact/<artifactId>`.
//
// A Supabase Storage path / signed URL in `storagePath` is untouched.

/** IndexedDB key for an artifact's own (unshared) bytes. Never collides
 *  with a `<messageId>/<itemId>` key: message ids are uuids. */
export function artifactBlobKey(artifactId: string): string {
  return `artifact/${artifactId}`
}

/** The artifact column that may carry a reference. */
export const ARTIFACT_BLOB_COLUMN = "storage_path"
