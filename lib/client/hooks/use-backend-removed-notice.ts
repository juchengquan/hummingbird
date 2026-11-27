"use client"
import "client-only"

/**
 * Wave 13 (Q138/Q145): the chat-backend setting is gone — chat runs on
 * agent-py, the only path. A browser that had picked another backend is
 * told once: the v37 migration sets `backendSettingRemoved` (in memory
 * only — `partializeState` doesn't keep it), so the note shows on the load
 * that migrated and never again. It replaces v36's "moved" notice: one
 * note, never two.
 */

import { useEffect } from "react"
import { toast } from "sonner"

import { useStore } from "@/client/hooks/use-store"

export const BACKEND_REMOVED_NOTICE = "Chat now runs on agent-py. The backend setting was removed."

export function noticeBackendSettingRemoved(
  show: (message: string) => void = (message) => void toast.info(message),
): void {
  if (!useStore.getState().backendSettingRemoved) return
  useStore.setState({ backendSettingRemoved: false })
  show(BACKEND_REMOVED_NOTICE)
}

export function useBackendRemovedNotice(): void {
  useEffect(() => {
    if (useStore.persist.hasHydrated()) noticeBackendSettingRemoved()
    return useStore.persist.onFinishHydration(() => noticeBackendSettingRemoved())
  }, [])
}
