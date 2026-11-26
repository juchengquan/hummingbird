"use client"
import "client-only"

/**
 * Wave 11 (Q110): a browser the v36 migration moved off its old default
 * (`'ts'`) onto the deploy's — "agent-py (runs)" — is told once, with where
 * to switch back. The flag lives in memory only (`chatBackendMoved`), so the
 * notice shows on the load that migrated and never again. Moved to a default
 * that is still the Next.js route (no agent-py): nothing changed, no notice.
 */

import { useEffect } from "react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"

export const BACKEND_MOVED_NOTICE =
  "Chat now runs on agent-py (runs). You can switch back in the account menu, under Chat backend."

export function noticeBackendMove(): void {
  const { chatBackendMoved, chatBackend, chatBackendExplicit } = useStore.getState()
  if (!chatBackendMoved) return
  useStore.setState({ chatBackendMoved: false })
  if (chatBackend === "python-runs" && !chatBackendExplicit) toast.info(BACKEND_MOVED_NOTICE)
}

export function useBackendMovedNotice(): void {
  useEffect(() => {
    if (useStore.persist.hasHydrated()) noticeBackendMove()
    return useStore.persist.onFinishHydration(() => noticeBackendMove())
  }, [])
}
