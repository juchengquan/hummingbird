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
 *      localStorage set `hummingbird-reconciled-users` (`sync-owner.ts`).
 *
 *   2. **Silent cloud-pull on refresh / reconnect** — after the user has
 *      been reconciled once, every subsequent sign-in (including page
 *      refresh) and every `online` transition pulls cloud → applies to
 *      local store. Cloud is the source of truth when signed in, except
 *      for local-only fields (no DB column), which the apply preserves.
 *
 * Conflict policy: BEFORE pulling cloud, edits made while sync was
 * paused / signed out are queued (`resumeFromPause` — diffs the pause
 * baseline recorded when sync detached against the current store; local
 * edits win, rows deleted while paused are deleted in the cloud), then
 * we wait for the local sync queue to drain so they flush upward first.
 * Offline at that point → the ops stay queued and the pull is deferred
 * to the `online` re-pull. `whenDrained`
 * gives up after 30s, so the apply ALSO consults the queue: rows with a
 * pending delete aren't resurrected and rows with a pending upsert keep
 * their local version (see `mergeCloudSnapshot`).
 *
 * Shared machines: the local store may hold a DIFFERENT account's data
 * (tracked in `sync-owner.ts`). A first sign-in never silently uploads
 * such data into the new account — it goes through the reconcile prompt
 * even when the new account's cloud is empty.
 *
 * Pull UX is silent — no toast, no spinner. The UI just reflects the new
 * state once the snapshot lands.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { getDefaultConversations } from "@/client/hooks/store/slices/conversations"
import { getDefaultWorkspaces } from "@/client/hooks/store/slices/workspaces"
import {
  getSupabaseBrowserClient,
  type AppSupabaseClient,
} from "@/client/supabase/client"
import {
  applyCloudSnapshot,
  bulkUploadLocalState,
  fetchCloudSnapshot,
  localSnapshotFromStore,
  type CloudSnapshot,
} from "@/client/sync/reconcile"
import { resumeFromPause, seedSyncSnapshot } from "@/client/hooks/use-sync"
import {
  isSyncOnline,
  pendingOpsFor,
  syncQueueMark,
  whenDrained,
} from "@/client/sync/sync-queue"
import {
  getLocalDataOwner,
  hasReconciled,
  markReconciled,
  setLocalDataOwner,
} from "@/client/sync/sync-owner"
import type { ReconcileChoice } from "@/components/auth/reconcile-dialog"

export type ReconcileStatus = "idle" | "loading" | "prompt" | "done" | "error"

export interface ReconcileState {
  status: ReconcileStatus
  cloud?: CloudSnapshot
  error?: string
  /** True when the prompt is showing because the local data was created
   *  under a different account than the one signing in. */
  localFromOtherAccount: boolean
  decide: (choice: ReconcileChoice) => void
}

// ---------- helpers --------------------------------------------------------

/**
 * True when the local store holds anything beyond the pristine
 * first-run scaffolding (one default workspace + an empty welcome chat).
 * Used to decide whether another account's leftover data is worth a
 * prompt at all.
 */
export function localHasContent(local: CloudSnapshot): boolean {
  return (
    local.workspaces.length > 1 ||
    local.conversations.some((c) => c.messages.length > 0) ||
    local.documents.length > 0 ||
    local.files.length > 0 ||
    local.notes.length > 0 ||
    local.artifacts.length > 0 ||
    local.prompts.length > 0 ||
    local.projectTasks.length > 0 ||
    local.mcpServers.length > 0 ||
    local.urlBookmarks.length > 0
  )
}

/**
 * True when the local data is known to belong to another account. An
 * unknown owner (fresh device, or anonymous local-only use) is NOT
 * foreign — that's the intended "first sign-in uploads my local work"
 * path.
 */
function localBelongsToOtherAccount(userId: string): boolean {
  const owner = getLocalDataOwner()
  return owner !== null && owner !== userId
}

/** Cloud pull for an already-reconciled user (refresh / reconnect).
 *  "deferred" = offline; the `online` listener pulls later. */
async function silentPull(
  client: AppSupabaseClient,
  userId: string,
  isCancelled: () => boolean
): Promise<"ok" | "cancelled" | "failed" | "deferred"> {
  if (!isSyncOnline()) return "deferred"
  await whenDrained()
  if (isCancelled()) return "cancelled"
  // Went offline while draining: the queue still holds this user's
  // edits; a pull now would only fail. Wait for `online`.
  if (!isSyncOnline()) return "deferred"
  // Ops that flush while the fetch is in flight still count as pending:
  // the snapshot may predate them.
  const mark = syncQueueMark()
  const snap = await fetchCloudSnapshot(client, userId)
  if (isCancelled()) return "cancelled"
  if (!snap) return "failed"
  applyCloudSnapshot(snap, {
    pendingOps: pendingOpsFor(userId, { since: mark }),
    // Don't graft another account's local-only fields onto same-id rows
    // (the default workspace / welcome chat ids collide across accounts).
    keepLocalOnlyFields: !localBelongsToOtherAccount(userId),
  })
  setLocalDataOwner(userId)
  return "ok"
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
  const [localFromOtherAccount, setLocalFromOtherAccount] = useState(false)

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
      setLocalFromOtherAccount(false)
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
      // Queue the edits made while paused / signed out BEFORE the pull
      // waits for the queue to drain. `useSync`'s attach does the same;
      // whichever runs first claims the baseline, the other is a no-op.
      resumeFromPause(userId)
      setStatus("loading")
      void (async () => {
        try {
          const result = await silentPull(client, userId, () => cancelled)
          if (result === "cancelled") return
          if (result === "deferred") {
            setStatus("done")
            return
          }
          if (result === "failed") {
            setStatus("error")
            setError("Failed to fetch cloud state")
            return
          }
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
      const local = localSnapshotFromStore()
      // Another account's leftovers on a shared machine: never upload
      // them into this account without asking, even into an empty cloud.
      const foreignLocal =
        localBelongsToOtherAccount(userId) && localHasContent(local)
      if (!cloudHasData && !foreignLocal) {
        const result = await bulkUploadLocalState(client, userId, local)
        if (cancelled) return
        if (!result.ok) {
          setStatus("error")
          setError(result.error ?? "Bulk upload failed")
          return
        }
        seedSyncSnapshot()
        markReconciled(userId)
        setLocalDataOwner(userId)
        setStatus("done")
        return
      }
      setCloud(snap)
      setLocalFromOtherAccount(foreignLocal)
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
      await silentPull(client, userId, () => false)
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [enabled, userId])

  // ---- decide() — only used when the prompt is showing ------------------
  const decide = useCallback(
    (choice: ReconcileChoice) => {
      const client = getSupabaseBrowserClient()
      if (!client || !userId || !cloud) return
      const finish = () => {
        markReconciled(userId)
        setLocalDataOwner(userId)
        setStatus("done")
        setCloud(undefined)
        setLocalFromOtherAccount(false)
      }
      const uploadLocal = async () => {
        const result = await bulkUploadLocalState(
          client,
          userId,
          localSnapshotFromStore()
        )
        if (!result.ok) {
          setStatus("error")
          setError(result.error ?? "Bulk upload failed")
          return
        }
        seedSyncSnapshot()
        finish()
      }
      if (choice === "overwrite-cloud") {
        void uploadLocal()
        return
      }
      if (cloud.workspaces.length > 0) {
        // seeds sync snapshot internally
        applyCloudSnapshot(cloud, { keepLocalOnlyFields: !localFromOtherAccount })
        finish()
        return
      }
      // "Discard local" against a cloud with no workspaces (reachable when
      // the local data belonged to another account): start this account
      // from the same first-run scaffolding a fresh device gets, and
      // upload it so later edits have their parent rows.
      applyCloudSnapshot(
        {
          ...cloud,
          workspaces: getDefaultWorkspaces(),
          // (No workspaces ⇒ no conversations either: FK.)
          conversations: getDefaultConversations(),
        },
        { keepLocalOnlyFields: false }
      )
      void uploadLocal()
    },
    [cloud, userId, localFromOtherAccount]
  )

  return { status, cloud, error, localFromOtherAccount, decide }
}
