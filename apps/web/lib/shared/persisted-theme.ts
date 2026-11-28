/**
 * Read the `theme` out of the raw persisted store blob
 * (`localStorage['hummingbird-storage']`) WITHOUT `JSON.parse`-ing it.
 *
 * The blob holds every conversation + message and can run to megabytes;
 * parsing it just to pick one key blocks first paint (the pre-paint
 * script in `app/layout.tsx`) and store creation (`ui` slice). zustand
 * persist writes `{"state":{…},"version":N}` and `partializeState` lists
 * `theme` first, so the value sits at a fixed prefix. The fallback
 * takes the first unescaped `"theme":"…"` occurrence (inside a JSON
 * string value the quotes are escaped, so message text can't match).
 *
 * The regex sources are exported so the inline pre-paint script can
 * embed exactly the same patterns.
 */

export type PersistedTheme = "system" | "dark" | "light"

export const PERSISTED_THEME_PREFIX_RE =
  /^\{"state":\{"theme":"(system|dark|light)"/
export const PERSISTED_THEME_ANY_RE = /"theme":"(system|dark|light)"/

export function extractPersistedTheme(
  raw: string | null | undefined
): PersistedTheme | null {
  if (!raw) return null
  const m = PERSISTED_THEME_PREFIX_RE.exec(raw) ?? PERSISTED_THEME_ANY_RE.exec(raw)
  return m ? (m[1] as PersistedTheme) : null
}
