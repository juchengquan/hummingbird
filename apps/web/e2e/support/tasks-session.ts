/**
 * The signed-in session the e2e specs give the browser: a GoTrue session
 * for the fake Supabase (`tasks-runs-backend.ts`), as the cookie
 * `@supabase/ssr` reads. Its token isn't signed; the fake only reads `sub`.
 */

import type { BrowserContext } from "@playwright/test"

export const USER_ID = "00000000-0000-4000-8000-0000000000aa"

export function session() {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const accessToken = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER_ID, role: "authenticated", aud: "authenticated", exp })}.sig`
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    refresh_token: "e2e-refresh",
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "e2e@example.test", app_metadata: {}, user_metadata: {} },
  }
}

/** Sign the context in: the cookie of a Supabase at 127.0.0.1 (`sb-127-…`). */
export async function signIn(context: BrowserContext): Promise<void> {
  const raw = "base64-" + Buffer.from(JSON.stringify(session())).toString("base64url")
  await context.addCookies([{ name: "sb-127-auth-token", value: raw, domain: "127.0.0.1", path: "/" }])
}
