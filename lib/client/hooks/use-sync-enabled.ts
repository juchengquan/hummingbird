"use client"

/**
 * Computed gate for whether cloud-sync machinery should run.
 *
 * Three things must be true for sync to be active:
 * 1. Supabase env vars are set (`auth.status !== 'unconfigured'`).
 * 2. The user is signed in (`auth.status === 'signed-in'` and `user.id`).
 * 3. The user hasn't toggled the local-only opt-out
 *    (`store.localOnlyMode === false`).
 *
 * Used by `useSync` and `useReconcile` instead of checking auth status
 * directly, so the local-only toggle short-circuits the same control
 * paths as "not signed in".
 *
 * Returns the user id when sync is enabled, `null` otherwise — so call
 * sites can use it as a single-value gate AND as the user identifier
 * for queue ops.
 */

import { useAuth } from "@/client/hooks/use-auth"
import { useStore } from "@/client/hooks/use-store"

export function useSyncEnabled(): { enabled: boolean; userId: string | null } {
  const { status, user } = useAuth()
  const localOnlyMode = useStore((s) => s.localOnlyMode)
  const userId = user?.id ?? null
  const enabled = status === "signed-in" && !!userId && !localOnlyMode
  return { enabled, userId: enabled ? userId : null }
}
