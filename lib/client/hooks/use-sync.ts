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
 *
 * Pause / resume (`lib/client/sync/pause-baseline.ts`): while sync is
 * paused (local-only toggle) or the user is signed out the subscriber is
 * detached. Detaching records a compact pause baseline (persisted, so a
 * reload while paused keeps it); re-attaching for the same user diffs
 * that baseline against the current store and enqueues the result
 * BEFORE the reconcile pull runs (`resumeFromPause`, also called by
 * `use-reconcile.ts`). Local edits made while paused win.
 */

import { useEffect, useRef } from "react"
import { useStore } from "@/client/hooks/use-store"
import { heldConversationIds } from "@/client/hooks/store/slices/chat"
import { useSyncEnabled } from "@/client/hooks/use-sync-enabled"
import { getSupabaseBrowserClient } from "@/client/supabase/client"
import { fetchAccountInstructions } from "@/client/supabase/account-instructions"
import { fetchChatBackend, writeChatBackend } from "@/client/supabase/chat-backend"
import { fetchMemoryEnabled } from "@/client/supabase/memory"
import { reconcileChatBackend } from "@/shared/chat-backend"
import {
  configureSync,
  enqueue,
  enqueueMany,
  takeRecentlyDroppedOps,
} from "@/client/sync/sync-queue"
import {
  allDeferredOps,
  computeSyncOps,
  type DeferredDependentOps,
  type SyncSnapshot as Snapshot,
} from "@/client/sync/compute-sync-ops"
import {
  buildPauseBaseline,
  claimPauseBaseline,
  computeResumeOps,
  savePauseBaseline,
  shouldCapturePauseBaseline,
  type OwnershipContext,
} from "@/client/sync/pause-baseline"
import { getLocalDataOwner, hasReconciled } from "@/client/sync/sync-owner"
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

/**
 * Artifact / note ops parked until the held message they reference is
 * uploaded (see `computeSyncOps`). Survives a pull's rebase (the cloud
 * still lacks those rows); cleared with the subscriber.
 */
const deferredDependentOps: DeferredDependentOps = new Map()

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

function ownershipFor(userId: string): OwnershipContext {
  return { localOwner: getLocalDataOwner(), reconciled: hasReconciled(userId) }
}

function storeHydrated(): boolean {
  return useStore.persist.hasHydrated()
}

/**
 * Called when the diff subscriber detaches (pause, sign-out, user
 * switch, unmount): records what the cloud is known to hold for
 * `userId`, so the edits made while detached can be uploaded on resume.
 *
 * The baseline is the diff baseline (`lastSnapshot`), with streaming
 * conversations rolled back to their pre-stream messages (those diffs
 * were held, never queued). Ops still queued need nothing: they stay
 * queued and flush first on resume. Ops a sign-out reset just dropped
 * are marked dirty (see `takeRecentlyDroppedOps`).
 */
function capturePauseBaseline(userId: string): void {
  if (!storeHydrated()) return
  if (!shouldCapturePauseBaseline(userId, ownershipFor(userId))) return
  const base = lastSnapshot ?? takeSnapshot()
  const snapshot: Snapshot =
    heldMessageBaselines.size === 0
      ? base
      : {
          ...base,
          conversations: base.conversations.map((c) => {
            const held = heldMessageBaselines.get(c.id)
            return held ? { ...c, messages: held } : c
          }),
        }
  savePauseBaseline(
    buildPauseBaseline({
      userId,
      snapshot,
      // Parked ops never reached the queue, yet their rows are in the
      // diff baseline: mark them dirty so the resume re-sends them.
      droppedOps: [
        ...takeRecentlyDroppedOps(userId),
        ...allDeferredOps(deferredDependentOps).map((op) => ({
          ...op,
          ownerUserId: userId,
        })),
      ],
    })
  )
}

/**
 * Uploads the edits made while sync was paused for `userId`: claims the
 * pause baseline (if it is this user's and the local data is still
 * theirs), diffs it against the current store, enqueues the ops owner-
 * scoped and makes the current store the diff baseline. Idempotent —
 * the claim removes the baseline, so a second call (or a second tab)
 * is a no-op. Synchronous, so a caller that then awaits `whenDrained()`
 * is guaranteed to wait for these ops.
 *
 * Returns the number of ops enqueued.
 */
export function resumeFromPause(userId: string): number {
  // Pre-hydration the store holds defaults; diffing those would read as
  // "everything was deleted". Leave the baseline for the next attach.
  if (!storeHydrated()) return 0
  const baseline = claimPauseBaseline(userId, ownershipFor(userId))
  if (!baseline) return 0
  const current = takeSnapshot()
  const ops = computeResumeOps(baseline, current)
  enqueueMany(ops.map((op) => ({ ...op, ownerUserId: userId })))
  lastSnapshot = current
  heldMessageBaselines.clear()
  deferredDependentOps.clear()
  return ops.length
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
  // re-enable re-seeds cleanly (the subscriber's cleanup has already
  // recorded the pause baseline from it).
  useEffect(() => {
    if (!enabled) {
      lastSnapshot = null
      heldMessageBaselines.clear()
      deferredDependentOps.clear()
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
    // The chat backend follows the account (wave 11, Q111): a set value
    // wins; an unset one takes this browser's explicit choice.
    void (async () => {
      const server = await fetchChatBackend(userId)
      if (cancelled) return
      const { chatBackend, chatBackendExplicit, setChatBackend } = useStore.getState()
      const step = reconcileChatBackend({ server, local: chatBackend, localExplicit: chatBackendExplicit })
      if (step.apply) setChatBackend(step.apply)
      if (step.push) void writeChatBackend(userId, step.push)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, userId])

  // Subscribe to store changes and produce SyncOps. Attaching first
  // uploads whatever changed while detached (pause baseline), then seeds
  // the snapshot if reconciliation hasn't already.
  useEffect(() => {
    if (!enabled || !userId) return

    resumeFromPause(userId)
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
        heldMessageBaselines,
        deferredDependentOps
      )
      for (const op of ops) enqueue(op)

      lastSnapshot = next
    })

    return () => {
      unsubscribe()
      // Detached: from here on edits produce no ops. Record the pause
      // baseline so they upload when this user re-attaches.
      capturePauseBaseline(userId)
      lastSnapshot = null
      heldMessageBaselines.clear()
      deferredDependentOps.clear()
    }
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
  // Held message baselines are KEPT: a pull keeps a streaming
  // conversation's local messages (`mergeCloudSnapshot`), and the cloud
  // still lacks the in-flight placeholder. Re-capturing the baseline
  // from the merged snapshot would count the placeholder as uploaded,
  // so artifacts / notes created on it afterwards would no longer be
  // parked behind its upsert (`computeSyncOps`).
}
