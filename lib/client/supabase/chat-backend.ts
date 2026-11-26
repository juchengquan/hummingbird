import "client-only"

/**
 * Cloud persistence for the account's chat backend (wave 11, Q111):
 * `profiles.chat_backend`, a singleton on the user's own profile row like
 * `memory_enabled` (`./memory.ts`) — outside the sync queue. NULL = never
 * chosen (the deploy's default applies). Best-effort and session-guarded by
 * the callers: signed-out users never reach here.
 */

import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { isChatBackend, type ChatBackendValue } from "@/shared/chat-backend"

/** The account's choice; `null` when unset — or on any error / missing
 *  client / row, so the caller leaves local state alone (`undefined` vs
 *  `null` is not distinguished: neither overrides the browser). */
export async function fetchChatBackend(userId: string): Promise<ChatBackendValue | null> {
  const client = getSupabaseBrowserClient()
  if (!client) return null
  try {
    const { data, error } = await client.from("profiles").select("chat_backend").eq("id", userId).single()
    if (error || !data) return null
    return isChatBackend(data.chat_backend) ? data.chat_backend : null
  } catch {
    return null
  }
}

/** Write-through of an explicit choice. Best-effort: local state already
 *  changed; a failure is retried by the next sign-in (an unset server value
 *  takes the browser's explicit choice). */
export async function writeChatBackend(userId: string, value: ChatBackendValue): Promise<void> {
  const client = getSupabaseBrowserClient()
  if (!client) return
  try {
    await client.from("profiles").update({ chat_backend: value }).eq("id", userId)
  } catch {
    // Best-effort.
  }
}
