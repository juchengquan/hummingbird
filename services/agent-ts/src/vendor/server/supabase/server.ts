// VENDORED from `lib/server/supabase/server.ts` (Next app) at commit afc33009135d6166adb4196598350638a8aafc3f.
// Frozen copy — agent-ts is frozen (docs/PLAN-frontend-backend-split.md Q11); do not extend.
// Fixes to the original no longer propagate here. Only import specifiers were rewritten
// (`@/server/*` / `@/shared/*` → relative, `@/config/*` → `@config/*`) unless a
// "VENDOR DEVIATION" note below says otherwise.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseEnv } from "../../shared/supabase/env"
import type { Database } from "../../shared/supabase/types"

// VENDOR DEVIATION: the original builds a cookie-bound client via
// `@supabase/ssr` + `next/headers` `cookies()`. agent-ts has no Next.js
// request scope (the original's `cookies()` call throws outside one), and
// this function is unreachable here anyway: its only caller is the shared
// `searchFilesSkill.buildTool`, which `src/skills.ts` never invokes — it
// swaps in the Postgres-driver tool from `src/search-files.ts`. So the
// cookie path is replaced by an explicit throw, which drops the `next` and
// `@supabase/ssr` dependencies. The env-unset → `null` branch is unchanged.
export async function getSupabaseServerClient(): Promise<SupabaseClient<Database> | null> {
  const env = getSupabaseEnv()
  if (!env) return null

  throw new Error(
    "getSupabaseServerClient: no Next.js request scope in agent-ts (cookie-bound Supabase client unavailable)"
  )
}
