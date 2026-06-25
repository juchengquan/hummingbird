/** The path segment that precedes the durable object path in a Supabase
 *  Storage *signed* URL for the `user-files` bucket (where generated
 *  images + files live). */
const SIGNED_MARKER = "/object/sign/user-files/"

/**
 * Extract the durable Supabase object path (e.g.
 * `<uid>/generated/<id>-report.csv`) from a generated-asset signed URL,
 * so it can be re-signed via the refresh endpoints. Returns null when the
 * URL isn't a recognizable `user-files` signed URL — a `data:` URL, a
 * non-Supabase URL, or an unexpected shape — in which case the caller
 * leaves the URL untouched (it either never expires or can't be repaired).
 *
 * Pure string logic, isomorphic. The returned path keeps its leading
 * `<uid>` segment, which the refresh route's owner-check requires.
 */
export function parseStorageObjectPath(url: string): string | null {
  if (!url || url.startsWith("data:")) return null
  const i = url.indexOf(SIGNED_MARKER)
  if (i === -1) return null
  const after = url.slice(i + SIGNED_MARKER.length)
  const q = after.indexOf("?")
  const raw = q === -1 ? after : after.slice(0, q)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
