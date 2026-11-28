"use client"

import { useEffect } from "react"

import { installCrossTabSync } from "@/client/hooks/store/cross-tab-sync"

/**
 * Mounted once in the root layout: merges writes another tab makes to
 * the persisted store into this tab (see `store/cross-tab-sync.ts`).
 * Renders nothing.
 */
export function CrossTabStoreSync() {
  useEffect(() => installCrossTabSync(), [])
  return null
}
