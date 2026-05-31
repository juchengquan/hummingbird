/**
 * Supabase Storage REST helpers — narrow port of agent-py's
 * `sign_storage_path`. We talk to the Storage REST API directly with
 * `fetch` so we don't have to bring `@supabase/supabase-js` into
 * agent-ts just to mint a signed URL.
 *
 * Auth via the service-role key (RLS bypassed); the caller (route
 * handler) is responsible for the path-prefix check against the JWT
 * sub claim, same pattern as agent-py.
 */

import { getEnv } from "./env"

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365 // 1 year — matches agent-py
const STORAGE_BUCKET = "user-files"

export function isStorageConfigured(): boolean {
  const env = getEnv()
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Mint a fresh signed URL for an object at `storagePath`. Returns
 * null when:
 *   - Storage isn't configured (URL or service key missing),
 *   - the sign call fails (404 / network / malformed response),
 *   - the response is missing the `signedURL` field.
 *
 * Mirrors agent-py's `sign_storage_path` shape exactly.
 */
export async function signStoragePath(storagePath: string): Promise<string | null> {
  if (!isStorageConfigured()) return null
  const env = getEnv()
  const base = env.SUPABASE_URL.replace(/\/+$/, "")
  const key = env.SUPABASE_SERVICE_ROLE_KEY.trim()
  let res: Response
  try {
    res = await fetch(
      `${base}/storage/v1/object/sign/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          apikey: key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
      },
    )
  } catch {
    return null
  }
  if (!res.ok) return null
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return null
  }
  const signed =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { signedURL?: unknown }).signedURL
      : null
  if (typeof signed !== "string" || !signed) return null
  return signed.startsWith("/") ? `${base}/storage/v1${signed}` : signed
}
