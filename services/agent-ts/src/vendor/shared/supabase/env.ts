// VENDORED from `lib/shared/supabase/env.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return { url, anonKey }
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseEnv() !== null
}
