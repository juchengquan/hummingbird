import "server-only"

import { createHash } from "node:crypto"

import { rateLimitKey } from "@/server/rate-limit"
import { getSupabaseServerClient } from "@/server/supabase/server"

/**
 * Per-caller partition for the response cache. A near-match hit
 * (cosine ≥ threshold) serves the answer to a *similar* input — which
 * could be another user's document — so cache entries are scoped to
 * the caller that produced them.
 *
 * - Signed in → `user:<supabase user id>`.
 * - Anonymous → `anon:<sha256(rate-limit client key)>` (the client IP;
 *   hashed so raw IPs don't sit in cache keys). Anonymous callers
 *   behind the same IP — or all of them, on a deploy with no trusted
 *   proxy header (`rateLimitKey` → "default") — share one scope.
 */
export function callerScopeFrom(parts: {
  userId: string | null | undefined
  clientKey: string
}): string {
  if (parts.userId) return `user:${parts.userId}`
  const digest = createHash("sha256")
    .update(parts.clientKey)
    .digest("hex")
    .slice(0, 32)
  return `anon:${digest}`
}

/** Resolve the caller scope for a request. Never throws — any auth
 *  lookup failure degrades to the anonymous (IP-hash) scope. */
export async function resolveCallerScope(req: {
  headers: { get(name: string): string | null }
}): Promise<string> {
  let userId: string | null = null
  try {
    const supabase = await getSupabaseServerClient()
    if (supabase) {
      const { data } = await supabase.auth.getUser()
      userId = data?.user?.id ?? null
    }
  } catch {
    userId = null
  }
  return callerScopeFrom({ userId, clientKey: rateLimitKey(req) })
}
