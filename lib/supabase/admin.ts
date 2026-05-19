/**
 * Server-only admin client backed by SUPABASE_SERVICE_ROLE_KEY. Bypasses
 * RLS — use sparingly and only for narrowly-scoped reads keyed by a
 * caller-provided opaque token (e.g. share resolution). Never expose to
 * the browser bundle.
 *
 * Returns `null` when the service role key isn't configured; callers
 * surface a 404 for share lookups in that case rather than a 500.
 */

import { createClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"

import { getSupabaseEnv } from "@/lib/supabase/env"
import type { Database } from "@/lib/supabase/types"

let cached: SupabaseClient<Database> | null = null

export function getSupabaseAdminClient(): SupabaseClient<Database> | null {
  if (cached) return cached
  const env = getSupabaseEnv()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!env || !serviceKey) return null
  cached = createClient<Database>(env.url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  return cached
}
