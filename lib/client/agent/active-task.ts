"use client"
import "client-only"

/**
 * localStorage-backed pointer to the one in-flight old-path task, so a
 * reload can reconnect (resume-on-reload). The record shape + validation
 * live in the shared codec; this file is the browser I/O around it. Single
 * slot per user — the old path runs one task at a time.
 *
 * Keyed by the signed-in user (`humm.activeTask.<userId>`, Q68): another
 * account on the same browser never replays it (survey bug 6). A pointer
 * written before that (the unkeyed `humm.activeTask`) is handed to the
 * first account that looks and removed; if it was another account's, the
 * watch reads 404 and drops it without settling anything (`use-task-run`).
 * Without Supabase (no accounts: `userId` null) the unkeyed slot is used.
 *
 * It doesn't age out: a task may wait days for its user, and only the
 * server knows whether it still does. The watch replays the run and the
 * pointer is cleared once the run has ended (or is gone).
 */

import {
  parseActiveTask,
  serializeActiveTask,
  type ActiveTaskRecord,
} from "@/shared/agent/active-task"

const LEGACY_KEY = "humm.activeTask"
const keyFor = (userId: string | null) => (userId ? `${LEGACY_KEY}.${userId}` : LEGACY_KEY)

export function saveActiveTask(record: ActiveTaskRecord, userId: string | null): void {
  try {
    localStorage.setItem(keyFor(userId), serializeActiveTask(record))
  } catch {
    // Private mode / quota — non-fatal; resume-on-reload just won't work.
  }
}

export function loadActiveTask(userId: string | null): ActiveTaskRecord | null {
  try {
    const own = parseActiveTask(localStorage.getItem(keyFor(userId)))
    if (own || !userId) return own
    const legacy = parseActiveTask(localStorage.getItem(LEGACY_KEY))
    if (!legacy) return null
    localStorage.removeItem(LEGACY_KEY)
    localStorage.setItem(keyFor(userId), serializeActiveTask(legacy))
    return legacy
  } catch {
    return null
  }
}

/** Clear the user's pointer if it is `runId`'s — another tab may have
 *  started a newer task since. */
export function clearActiveTask(runId: string, userId: string | null): void {
  try {
    if (parseActiveTask(localStorage.getItem(keyFor(userId)))?.runId === runId) {
      localStorage.removeItem(keyFor(userId))
    }
  } catch {
    // ignore
  }
}
