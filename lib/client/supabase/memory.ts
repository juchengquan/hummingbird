import "client-only"

/**
 * Cloud persistence for the `memory_enabled` toggle.
 *
 * Like the account-instructions fields, this is a singleton setting on
 * the user's own `profiles` row (NOT an entity-row), so it lives outside
 * the `lib/client/sync` diff/queue machinery — a small, purpose-built
 * read/write instead. Mirrors `account-instructions.ts`.
 *
 * Both helpers are best-effort and session-guarded by their callers:
 * anonymous users never reach here (no `userId`), so this module makes
 * zero Supabase calls for signed-out users.
 */

import { getSupabaseBrowserClient } from "@/client/supabase/client"

/**
 * Read `memory_enabled` from the signed-in user's profile row. Returns
 * `null` on any error / missing client / missing row — callers should
 * leave local state alone in that case (server-wins only on success).
 */
export async function fetchMemoryEnabled(
  userId: string
): Promise<boolean | null> {
  const client = getSupabaseBrowserClient()
  if (!client) return null
  try {
    const { data, error } = await client
      .from("profiles")
      .select("memory_enabled")
      .eq("id", userId)
      .single()
    if (error || !data) return null
    return data.memory_enabled ?? false
  } catch {
    return null
  }
}

/**
 * Write-through `memory_enabled` to the signed-in user's profile row.
 * Best-effort: the caller does not await this, and any failure is
 * swallowed (local state is already updated).
 */
export async function writeMemoryEnabled(
  userId: string,
  enabled: boolean
): Promise<void> {
  const client = getSupabaseBrowserClient()
  if (!client) return
  try {
    await client
      .from("profiles")
      .update({ memory_enabled: enabled })
      .eq("id", userId)
  } catch {
    // Best-effort — local state is authoritative until next load.
  }
}
