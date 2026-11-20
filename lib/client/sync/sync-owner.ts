"use client"
import "client-only"

/**
 * Device-level bookkeeping of WHICH account the local data belongs to.
 *
 * Two localStorage keys, both outside the Zustand persisted store (so
 * they don't touch the frozen `STORE_VERSION` contract):
 *
 *  - `hummingbird-reconciled-users` — every user id that has completed
 *    first-sign-in reconciliation on this device. Drives "prompt vs.
 *    silent pull" in `use-reconcile.ts`.
 *  - `hummingbird-local-data-owner` — the user id whose cloud graph the
 *    local store was last reconciled / pulled against. Lets a DIFFERENT
 *    account signing in on a shared machine detect that the local data
 *    isn't theirs (so it's never silently bulk-uploaded into their
 *    account), and lets the sync queue attribute legacy ops that were
 *    persisted before ops carried an owner.
 *
 * Neither key is cleared on sign-out: the local data still belongs to
 * the previous account until someone explicitly reconciles over it.
 */

const RECONCILED_KEY = "hummingbird-reconciled-users"
const LOCAL_OWNER_KEY = "hummingbird-local-data-owner"

function hasStorage(): boolean {
  return typeof localStorage !== "undefined"
}

export function readReconciledSet(): Set<string> {
  if (!hasStorage()) return new Set()
  try {
    const raw = localStorage.getItem(RECONCILED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? new Set((parsed as unknown[]).filter((v): v is string => typeof v === "string"))
      : new Set()
  } catch {
    return new Set()
  }
}

export function markReconciled(userId: string): void {
  if (!hasStorage()) return
  const set = readReconciledSet()
  set.add(userId)
  try {
    localStorage.setItem(RECONCILED_KEY, JSON.stringify([...set]))
  } catch {
    // localStorage full / blocked — accept that we'll re-prompt next time.
  }
}

export function hasReconciled(userId: string): boolean {
  return readReconciledSet().has(userId)
}

/**
 * The account the local data belongs to, or null when unknown.
 *
 * Falls back to the sole entry of the reconciled-users set for installs
 * that predate the explicit owner key: if exactly one account has ever
 * reconciled on this device, the local data (and any queued op) can only
 * be theirs. With zero or 2+ reconciled accounts the answer is ambiguous
 * → null, and callers must take their conservative branch.
 */
export function getLocalDataOwner(): string | null {
  if (!hasStorage()) return null
  try {
    const raw = localStorage.getItem(LOCAL_OWNER_KEY)
    if (raw) return raw
  } catch {
    // fall through to the legacy inference
  }
  const reconciled = readReconciledSet()
  return reconciled.size === 1 ? [...reconciled][0] : null
}

export function setLocalDataOwner(userId: string): void {
  if (!hasStorage()) return
  try {
    localStorage.setItem(LOCAL_OWNER_KEY, userId)
  } catch {
    // Best-effort. A missing owner only makes the next foreign sign-in
    // fall back to the reconciled-set inference.
  }
}
