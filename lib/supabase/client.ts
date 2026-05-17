"use client"

import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseEnv } from "@/lib/supabase/env"

let cached: SupabaseClient | null = null

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (cached) return cached
  const env = getSupabaseEnv()
  if (!env) return null
  cached = createBrowserClient(env.url, env.anonKey)
  return cached
}
