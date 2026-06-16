import "client-only"

/**
 * Cloud persistence for account-level custom instructions.
 *
 * These two fields are singleton settings on the user's own `profiles`
 * row (NOT entity-rows), so they live outside the `lib/client/sync`
 * diff/queue machinery — a small, purpose-built read/write instead.
 *
 * Both helpers are best-effort and session-guarded by their callers:
 * anonymous users never reach here (no `userId`), so this module makes
 * zero Supabase calls for signed-out users.
 */

import { getSupabaseBrowserClient } from "@/client/supabase/client"

export interface AccountInstructionsRow {
  about: string
  style: string
}

/**
 * Read the two columns from the signed-in user's profile row. Returns
 * `null` on any error / missing client / missing row — callers should
 * leave local state alone in that case (server-wins only on success).
 */
export async function fetchAccountInstructions(
  userId: string
): Promise<AccountInstructionsRow | null> {
  const client = getSupabaseBrowserClient()
  if (!client) return null
  try {
    const { data, error } = await client
      .from("profiles")
      .select("custom_instructions_about, custom_instructions_style")
      .eq("id", userId)
      .single()
    if (error || !data) return null
    return {
      about: data.custom_instructions_about ?? "",
      style: data.custom_instructions_style ?? "",
    }
  } catch {
    return null
  }
}

/**
 * Write-through the two fields to the signed-in user's profile row.
 * Best-effort: the caller does not await this, and any failure is
 * swallowed (local state is already updated).
 */
export async function writeAccountInstructions(
  userId: string,
  fields: AccountInstructionsRow
): Promise<void> {
  const client = getSupabaseBrowserClient()
  if (!client) return
  try {
    await client
      .from("profiles")
      .update({
        custom_instructions_about: fields.about,
        custom_instructions_style: fields.style,
      })
      .eq("id", userId)
  } catch {
    // Best-effort — local state is authoritative until next load.
  }
}
