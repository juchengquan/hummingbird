import "server-only"

import { getSupabaseServerClient } from "@/server/supabase/server"

/** Load the signed-in user's active facts (RLS-scoped), gated on
 *  `profiles.memory_enabled`. Returns [] when signed-out, disabled, or on
 *  any error — never throws. */
export async function loadActiveFacts(): Promise<{ fact: string; category: string | null }[]> {
  try {
    const supabase = await getSupabaseServerClient()
    if (!supabase) return []
    const { data: prof } = await supabase.from("profiles").select("memory_enabled").single()
    if (!prof?.memory_enabled) return []
    const { data } = await supabase
      .from("user_memories")
      .select("fact, category")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
    return (data ?? []).map((r) => ({ fact: r.fact as string, category: (r.category as string) ?? null }))
  } catch {
    return []
  }
}
