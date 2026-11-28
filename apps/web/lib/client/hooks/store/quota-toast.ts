"use client"
import "client-only"

import { toast } from "sonner"

/**
 * localStorage quota handling for the debounced persist storage.
 *
 * When the persisted store outgrows the browser's localStorage quota
 * (5-10 MB) every `setItem` throws, and all later edits are silently
 * lost on reload. We can't make the write succeed, but we can tell the
 * user — once per session, not on every debounced flush.
 */

/** True for the various shapes browsers use for "storage full":
 *  `QuotaExceededError` (spec), `NS_ERROR_DOM_QUOTA_REACHED` (old
 *  Firefox), and the legacy numeric codes 22 (WebKit/Chromium) and
 *  1014 (Firefox). */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { name?: unknown; code?: unknown }
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  )
}

function showQuotaToast(): void {
  toast.error("Changes can't be saved on this device", {
    id: "local-storage-quota",
    description:
      "Browser storage is full, so edits made from now on will be lost when you reload. " +
      "Free up space by deleting large files or old conversations, then keep working — saving resumes automatically.",
    duration: 20_000,
  })
}

let notified = false

/**
 * Show the quota toast unless it was already shown this session.
 * Returns true when it actually showed. `show` is injectable for tests.
 */
export function notifyStorageQuotaExceeded(show: () => void = showQuotaToast): boolean {
  if (notified) return false
  notified = true
  try {
    show()
  } catch {
    // A toast failure must never break the persist path.
  }
  return true
}

/** Test-only: re-arm the once-per-session guard. */
export function __resetQuotaToastForTests(): void {
  notified = false
}
