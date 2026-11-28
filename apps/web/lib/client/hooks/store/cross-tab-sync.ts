import "client-only"

/**
 * Multi-tab coherence for the persisted main store.
 *
 * Problem: every tab writes the WHOLE persisted store to one
 * localStorage key, and nothing re-read it after boot — so a
 * conversation created in tab B was erased by tab A's next write.
 *
 * Fix: listen for `storage` events on that key (fired only in the
 * OTHER tabs) and three-way merge the other tab's write into this
 * tab's state (`cross-tab-merge.ts`) rather than calling
 * `persist.rehydrate()`:
 *
 *   - `rehydrate()` reads through the debounced storage, whose
 *     read-your-write cache returns THIS tab's buffered write — it
 *     would re-install our own state and then flush it over the other
 *     tab's write a few ms later. Dropping the buffer instead would
 *     silently lose this tab's last ~100 ms of edits. The merge keeps
 *     both: rows only we changed survive, rows only they changed are
 *     adopted, true conflicts go to the newer (their) write.
 *   - A plain rehydrate mid-stream would replace the conversation we
 *     are streaming into with the other tab's stale copy and drop the
 *     in-flight assistant message (later token updates target a
 *     message id that no longer exists). The merge pins conversations
 *     in `typingConversationIds` / `streamingConversationIds` to ours,
 *     so we can merge immediately instead of deferring until the
 *     stream ends (deferring would let our per-token writes clobber the
 *     other tab's change in storage meanwhile).
 *   - Per-tab view state (active conversation, panel widths, …) stays
 *     per tab.
 *
 * Write-back / loop safety: after merging we write back (keep the
 * buffered write) only if the merge kept shared data the other tab
 * doesn't have, or this tab already had an unflushed write; otherwise
 * the buffered write is discarded. The other tab then merges our
 * write-back, finds nothing new to contribute, and stays quiet — so
 * tabs converge instead of ping-ponging.
 *
 * Writes from a build with a different STORE_VERSION are ignored: we
 * can't trust (or migrate down) a shape we don't know; the next reload
 * reconciles.
 *
 * The sync queue (`hummingbird-sync-queue`) deliberately stays
 * tab-local: each tab flushes the ops it produced, and merged-in rows
 * are not re-enqueued (`withSyncDiffSuppressed`). See the note in
 * `lib/client/sync/sync-queue.ts`.
 */

import { withSyncDiffSuppressed } from "@/client/hooks/use-sync"
import {
  persistStorage,
  STORE_STORAGE_KEY,
  useStore,
  type AppState,
} from "@/client/hooks/use-store"

import { mergeCrossTabState } from "./cross-tab-merge"
import { heldConversationIds } from "./slices/chat"
import { STORE_VERSION } from "./migrate"
import { partializeState, reviveAndPruneState } from "./persist"

type Plain = Record<string, unknown>

export type CrossTabDecision =
  | { action: "ignore"; reason: string }
  | { action: "merge"; theirs: Plain }

/** Pure: should this `storage` event be merged into the store? */
export function decideCrossTabEvent(input: {
  key: string | null
  newValue: string | null
  isOwnStorageArea: boolean
  hydrated: boolean
  storeKey: string
  storeVersion: number
}): CrossTabDecision {
  if (!input.isOwnStorageArea) return { action: "ignore", reason: "other storage area" }
  if (input.key !== input.storeKey) return { action: "ignore", reason: "other key" }
  // Removal / `clear()` in another tab: keep our in-memory state; our
  // next write re-seeds storage.
  if (input.newValue === null) return { action: "ignore", reason: "removed" }
  if (!input.hydrated) return { action: "ignore", reason: "not hydrated" }
  let parsed: unknown
  try {
    parsed = JSON.parse(input.newValue)
  } catch {
    return { action: "ignore", reason: "unparseable" }
  }
  if (!parsed || typeof parsed !== "object") {
    return { action: "ignore", reason: "unparseable" }
  }
  const { state, version } = parsed as { state?: unknown; version?: unknown }
  if (version !== input.storeVersion) {
    return { action: "ignore", reason: "version mismatch" }
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { action: "ignore", reason: "no state" }
  }
  return { action: "merge", theirs: state as Plain }
}

/** Pure: keep this tab's buffered write after a merge? */
export function shouldWriteBack(oursWon: boolean, hadPendingWrite: boolean): boolean {
  return oursWon || hadPendingWrite
}

let installed = false

/** Install the listener once per page. Returns an uninstall function. */
export function installCrossTabSync(): () => void {
  if (installed || typeof window === "undefined") return () => {}
  installed = true

  // What this tab last agreed with storage on. Seeded at hydration,
  // advanced on each of our flushes and after each merge.
  let base: Plain | null = null
  const captureBase = () => {
    base = partializeState(useStore.getState()) as Plain
  }
  if (useStore.persist.hasHydrated()) captureBase()
  const offHydrate = useStore.persist.onFinishHydration(captureBase)
  const offFlush = persistStorage.subscribeFlush((name) => {
    if (name === STORE_STORAGE_KEY) captureBase()
  })

  const onStorage = (e: StorageEvent) => {
    const decision = decideCrossTabEvent({
      key: e.key,
      newValue: e.newValue,
      isOwnStorageArea: e.storageArea === window.localStorage,
      hydrated: useStore.persist.hasHydrated() && base !== null,
      storeKey: STORE_STORAGE_KEY,
      storeVersion: STORE_VERSION,
    })
    if (decision.action !== "merge" || base === null) return

    const current = useStore.getState()
    const { merged, nextBase, oursWon } = mergeCrossTabState({
      base,
      ours: partializeState(current) as Plain,
      theirs: decision.theirs,
      heldConversationIds: heldConversationIds(current),
    })
    const next = { ...current, ...merged } as AppState
    reviveAndPruneState(next)

    const hadPendingWrite = persistStorage.hasPending(STORE_STORAGE_KEY)
    withSyncDiffSuppressed(() => useStore.setState(next, true))
    if (!shouldWriteBack(oursWon, hadPendingWrite)) {
      persistStorage.discardPending(STORE_STORAGE_KEY)
    }
    base = nextBase
  }
  window.addEventListener("storage", onStorage)

  return () => {
    window.removeEventListener("storage", onStorage)
    offHydrate()
    offFlush()
    installed = false
  }
}
