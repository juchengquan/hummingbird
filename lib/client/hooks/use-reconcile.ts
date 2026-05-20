"use client"
import "client-only"

/**
 * Reconciliation + ongoing cloud-pull orchestrator. Mount once near the
 * root of `/dashboard`, alongside `useSync`.
 *
 * Two concerns:
 *
 *   1. **First-sign-in reconciliation** — the very first time a given
 *      user_id signs in on this device, we may need to decide whether to
 *      keep local data, take cloud data, or merge. Tracked via a
 *      localStorage set `hummingbird-reconciled-users`.
 *
 *   2. **Silent cloud-pull on refresh / reconnect** — after the user has
 *      been reconciled once, every subsequent sign-in (including page
 *      refresh) and every `online` transition pulls cloud → applies to
 *      local store. Cloud is the source of truth when signed in.
 *
 * Conflict policy: BEFORE pulling cloud, we wait for the local sync queue
 * to drain so any local-only edits flush upward first. Otherwise a
 * reconnect would overwrite local writes that hadn't pushed yet.
 *
 * Pull UX is silent — no toast, no spinner. The UI just reflects the new
 * state once the snapshot lands.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useStore } from "@/client/hooks/use-store"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { getSupabaseBrowserClient } from "@/client/supabase/client"
import {
  applyCloudSnapshot,
  bulkUploadLocalState,
  fetchCloudSnapshot,
  type CloudSnapshot,
} from "@/client/sync/reconcile"
import { seedSyncSnapshot } from "@/client/hooks/use-sync"
import { whenDrained } from "@/client/sync/sync-queue"
import type { ReconcileChoice } from "@/components/auth/reconcile-dialog"

export type ReconcileStatus = "idle" | "loading" | "prompt" | "done" | "error"

export interface ReconcileState {
  status: ReconcileStatus
  cloud?: CloudSnapshot
  error?: string
  decide: (choice: ReconcileChoice) => void
}

// ---------- reconciled-users persistence -----------------------------------

const RECONCILED_KEY = "hummingbird-reconciled-users"

function readReconciledSet(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = localStorage.getItem(RECONCILED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function markReconciled(userId: string): void {
  if (typeof window === "undefined") return
  const set = readReconciledSet()
  set.add(userId)
  try {
    localStorage.setItem(RECONCILED_KEY, JSON.stringify([...set]))
  } catch {
    // localStorage full / blocked — accept that we'll re-prompt next time.
  }
}

function hasReconciled(userId: string): boolean {
  return readReconciledSet().has(userId)
}

// ---------- helpers --------------------------------------------------------

function localSnapshotFromStore(): CloudSnapshot {
  const s = useStore.getState()
  return {
    workspaces: s.workspaces,
    documents: s.documents,
    conversations: s.conversations,
    files: s.files,
    resources: s.resources,
    notes: s.notes,
    artifacts: s.artifacts,
  }
}

// ---------- hook -----------------------------------------------------------

export function useReconcile(): ReconcileState {
  // `useSyncEnabled` folds in the local-only opt-out, so toggling local
  // mode short-circuits reconciliation just like signing out would.
  // `useSyncEnabled` exposes a stable userId string when enabled, NOT the
  // user object reference, so onAuthStateChange firing INITIAL_SESSION /
  // TOKEN_REFRESHED with a new object doesn't tear down an in-flight pull.
  // The `enabled` boolean also folds in the local-only opt-out toggle.
  const { enabled, userId } = useSyncEnabled()
  const [status, setStatus] = useState<ReconcileStatus>("idle")
  const [cloud, setCloud] = useState<CloudSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  // Per-session sticky so we don't loop the same flow. Reset on sign-out
  // and on user change.
  const handledUserId = useRef<string | null>(null)

  // Sign-in / refresh-while-signed-in branch.
  useEffect(() => {
    if (!enabled || !userId) {
      handledUserId.current = null
      setStatus("idle")
      setCloud(undefined)
      setError(undefined)
      return
    }
    if (handledUserId.current === userId) {
      return
    }
    handledUserId.current = userId

    const client = getSupabaseBrowserClient()
    if (!client) {
      setStatus("error")
      setError("Supabase client unavailable")
      return
    }

    let cancelled = false

    // ---- already-reconciled user: silent pull, skip the prompt --------
    if (hasReconciled(userId)) {
      setStatus("loading")
      void (async () => {
        try {
          await whenDrained()
          if (cancelled) return
          const snap = await fetchCloudSnapshot(client, userId)
          if (cancelled) return
          if (!snap) {
            setStatus("error")
            setError("Failed to fetch cloud state")
            return
          }
          applyCloudSnapshot(snap)
          setStatus("done")
        } catch (err) {
          setStatus("error")
          setError(err instanceof Error ? err.message : "Unknown sync error")
        }
      })()
      return () => {
        cancelled = true
      }
    }

    // ---- first-time reconciliation ----------------------------------
    setStatus("loading")
    void fetchCloudSnapshot(client, userId).then(async (snap) => {
      if (cancelled) return
      if (!snap) {
        setStatus("error")
        setError("Failed to fetch cloud state")
        return
      }
      const cloudHasData =
        snap.workspaces.length > 0 ||
        snap.conversations.length > 0 ||
        snap.files.length > 0
      if (!cloudHasData) {
        const local = localSnapshotFromStore()
        const result = await bulkUploadLocalState(client, userId, local)
        if (cancelled) return
        if (!result.ok) {
          setStatus("error")
          setError(result.error ?? "Bulk upload failed")
          return
        }
        seedSyncSnapshot()
        markReconciled(userId)
        setStatus("done")
        return
      }
      setCloud(snap)
      setStatus("prompt")
    })

    return () => {
      cancelled = true
    }
  }, [enabled, userId])

  // ---- `online` re-pull ---------------------------------------------------
  useEffect(() => {
    if (!enabled || !userId) return
    const client = getSupabaseBrowserClient()
    if (!client) return

    const onOnline = async () => {
      if (!hasReconciled(userId)) return
      await whenDrained()
      const snap = await fetchCloudSnapshot(client, userId)
      if (!snap) return
      applyCloudSnapshot(snap)
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [enabled, userId])

  // ---- decide() — only used when the prompt is showing ------------------
  const decide = useCallback(
    (choice: ReconcileChoice) => {
      const client = getSupabaseBrowserClient()
      if (!client || !userId || !cloud) return
      if (choice === "use-cloud") {
        applyCloudSnapshot(cloud) // seeds sync snapshot internally
        markReconciled(userId)
        setStatus("done")
        setCloud(undefined)
        return
      }
      void (async () => {
        const local = localSnapshotFromStore()
        const result = await bulkUploadLocalState(client, userId, local)
        if (!result.ok) {
          setStatus("error")
          setError(result.error ?? "Bulk upload failed")
          return
        }
        seedSyncSnapshot()
        markReconciled(userId)
        setStatus("done")
        setCloud(undefined)
      })()
    },
    [cloud, userId]
  )

  return { status, cloud, error, decide }
}
