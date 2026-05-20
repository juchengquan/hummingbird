/**
 * Random ID generator that works in both secure and non-secure browser
 * contexts.
 *
 * Background: `crypto.randomUUID()` only exists when the page is loaded in
 * a "secure context" — HTTPS or `localhost`. If the user opens the dev
 * server via an LAN IP (e.g. `http://192.168.x.y:3000`) or via a non-HTTPS
 * tunnel, `crypto.randomUUID` is `undefined` and any call site that
 * relied on it throws.
 *
 * These IDs aren't cryptographically meaningful — they're just keys for
 * client-side records (messages, files, conversations, etc.) — so a
 * `Math.random` + timestamp fallback is fine when the secure path isn't
 * available.
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Fallback: 36-char string built from time + double random. Collisions
  // are astronomically unlikely for the volumes this app produces.
  const rand = () => Math.random().toString(36).slice(2, 11)
  return `${Date.now().toString(36)}-${rand()}-${rand()}`
}
