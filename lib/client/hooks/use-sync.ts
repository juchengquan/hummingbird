"use client"
import "client-only"

/**
 * Wires the sync queue into the Zustand store. Mount once near the root
 * of `/dashboard` (see `app/dashboard/page.tsx`).
 *
 * Mechanism: subscribe to the relevant store slices. On every change,
 * diff the previous snapshot against the current snapshot per entity and
 * enqueue the resulting SyncOps. The diff functions are pure
 * (`lib/sync/handlers.ts`); the queue handles retries / persistence.
 *
 * We deliberately don't touch `lib/hooks/use-store.ts`. This keeps the
 * sync layer reversible — comment out one hook in the dashboard and
 * everything still works locally.
 */

import { useEffect, useRef } from "react"
import { useStore } from "@/client/hooks/use-store"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { fetchAccountInstructions } from "@/client/supabase/account-instructions"
import { fetchMemoryEnabled } from "@/client/supabase/memory"
import { configureSync, enqueue } from "@/client/sync/sync-queue"
import {
  computeSyncOps,
  type SyncSnapshot as Snapshot,
} from "@/client/sync/compute-sync-ops"
import type { Message } from "@/shared/types"

// Module-level so the reconciliation flow can reset it after hydration.
let lastSnapshot: Snapshot | null = null

/** Set while `withSyncDiffSuppressed` runs — see that helper. */
let suppressDiff = false

/**
 * Run `fn` (which must update the store synchronously) without turning
 * the resulting change into SyncOps; the diff baseline just advances.
 * Used by the cross-tab merge (`store/cross-tab-sync.ts`): the rows it
 * installs were authored — and enqueued — by the other tab (or by this
 * one, earlier), so re-diffing them would double-upload, and a stale
 * row from a write race could even overwrite a newer cloud row.
 */
export function withSyncDiffSuppressed(fn: () => void): void {
  const prev = suppressDiff
  suppressDiff = true
  try {
    fn()
  } finally {
    suppressDiff = prev
  }
}

/**
 * Message baselines for conversations whose message diffs are being
 * held (mid-stream). Keyed by conversation id; the value is that
 * conversation's messages as they stood in the diff baseline when the
 * hold began. `lastSnapshot` keeps advancing per token while a hold is
 * on, so it can't serve as the "before" for the deferred diff — this
 * map does. Released (diffed against the live messages, then deleted)
 * when the id leaves the held set.
 */
const heldMessageBaselines = new Map<string, Message[]>()

/** Conversations whose message diffs are deferred: still showing the
 *  typing dots, or with an in-flight stream (the typing flag clears on
 *  the first chunk, the streaming flag only when the stream settles). */
function heldConversationIds(state: {
  typingConversationIds: string[]
  streamingConversationIds: string[]
}): Set<string> {
  return new Set([
    ...state.typingConversationIds,
    ...state.streamingConversationIds,
  ])
}

function snapshotOf(s: Snapshot): Snapshot {
  return {
    workspaces: s.workspaces,
    documents: s.documents,
    conversations: s.conversations,
    files: s.files,
    resources: s.resources,
    conversationFiles: s.conversationFiles,
    notes: s.notes,
    artifacts: s.artifacts,
    prompts: s.prompts,
    projectTasks: s.projectTasks,
    mcpServers: s.mcpServers,
    mcpResources: s.mcpResources,
    mcpResourceBindings: s.mcpResourceBindings,
    conversationMcpResources: s.conversationMcpResources,
    urlBookmarks: s.urlBookmarks,
    conversationUrlBookmarks: s.conversationUrlBookmarks,
  }
}

function takeSnapshot(): Snapshot {
  return snapshotOf(useStore.getState())
}

export function useSync(): void {
  // `useSyncEnabled` folds in the local-only opt-out so disabling cloud
  // sync via the toggle behaves identically to being signed out.
  const { enabled, userId } = useSyncEnabled()

  // Wire the queue's client+user.
  useEffect(() => {
    const client = getSupabaseBrowserClient()
    configureSync({
      client,
      userId: enabled ? userId : null,
    })
  }, [enabled, userId])

  // On sign-out / local-mode-toggled-on, clear the snapshot so a future
  // re-enable re-seeds cleanly.
  useEffect(() => {
    if (!enabled) {
      lastSnapshot = null
      heldMessageBaselines.clear()
    }
  }, [enabled])

  // Load account custom instructions from the user's profile row once per
  // sign-in (server wins on first load — prevents a stale-localStorage
  // clobber). These are singleton settings, not entity-rows, so they live
  // outside the diff/queue machinery. Best-effort: a failed read leaves
  // local state alone. Anonymous / local-only users never run this
  // (gated on `enabled && userId`), so they make zero Supabase calls.
  const loadedInstructionsFor = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !userId) {
      loadedInstructionsFor.current = null
      return
    }
    if (loadedInstructionsFor.current === userId) return
    loadedInstructionsFor.current = userId

    let cancelled = false
    void (async () => {
      const row = await fetchAccountInstructions(userId)
      if (cancelled || !row) return
      useStore.getState().setAccountInstructions({
        about: row.about,
        style: row.style,
      })
    })()
    // Cross-conversation memory opt-in — same singleton-profile-setting
    // shape, same server-wins-on-load contract. Best-effort: a failed /
    // null read leaves the local toggle alone.
    void (async () => {
      const memoryEnabled = await fetchMemoryEnabled(userId)
      if (cancelled || memoryEnabled === null) return
      useStore.getState().setMemoryEnabled(memoryEnabled)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, userId])

  // Subscribe to store changes and produce SyncOps. The first change
  // after enabling seeds the snapshot if reconciliation hasn't already.
  useEffect(() => {
    if (!enabled || !userId) return

    if (lastSnapshot === null) {
      lastSnapshot = takeSnapshot()
    }

    const unsubscribe = useStore.subscribe((state) => {
      const next: Snapshot = snapshotOf(state)
      const prev = lastSnapshot
      // A cross-tab merge only installs rows another tab already
      // enqueued (or rows this tab enqueued earlier) — rebase instead
      // of re-uploading them. Held message baselines are kept so an
      // in-flight stream still diffs against its pre-stream baseline.
      if (!prev || suppressDiff) {
        lastSnapshot = next
        return
      }

      const ops = computeSyncOps(
        prev,
        next,
        heldConversationIds(state),
        heldMessageBaselines
      )
      for (const op of ops) enqueue(op)

      lastSnapshot = next
    })

    return () => unsubscribe()
  }, [enabled, userId])
}

/**
 * Imperative helper for the reconciliation flow. Call right after
 * hydrating Zustand from the cloud so the next diff doesn't re-upload
 * the rows we just downloaded.
 *
 * Reads the current store state — so it MUST be called AFTER the store
 * has the new snapshot. If you can hand the snapshot in directly, prefer
 * `setSyncSnapshot()` and call it BEFORE the setState — that way
 * `useSync`'s subscriber sees prev === next on the synchronous
 * notification.
 */
export function seedSyncSnapshot(): void {
  lastSnapshot = takeSnapshot()
  // A rebased baseline invalidates held message baselines; any still-
  // streaming conversation re-captures from the new snapshot.
  heldMessageBaselines.clear()
}

/**
 * Synchronously sets the diff baseline. Use this when you already have
 * the exact snapshot you're about to commit to the store, so the
 * Zustand subscriber fires with `prev === next` and emits zero ops.
 */
export function setSyncSnapshot(snapshot: Snapshot): void {
  lastSnapshot = snapshot
  heldMessageBaselines.clear()
}
