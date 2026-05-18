"use client"

import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseEnv } from "@/lib/supabase/env"
import type { Database } from "@/lib/supabase/types"

export type AppSupabaseClient = SupabaseClient<Database>

let cached: AppSupabaseClient | null = null

export function getSupabaseBrowserClient(): AppSupabaseClient | null {
  if (cached) return cached
  const env = getSupabaseEnv()
  if (!env) return null
  cached = createBrowserClient<Database>(env.url, env.anonKey)
  return cached
}
