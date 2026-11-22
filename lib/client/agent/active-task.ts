"use client"
import "client-only"

/**
 * localStorage-backed pointer to the one in-flight task, so a reload
 * can reconnect (resume-on-reload). The record shape + validation live
 * in the shared codec; this file is the browser I/O around it. Single
 * slot — v1 runs one task at a time.
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

const STORAGE_KEY = "humm.activeTask"

export function saveActiveTask(record: ActiveTaskRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeActiveTask(record))
  } catch {
    // Private mode / quota — non-fatal; resume-on-reload just won't work.
  }
}

export function loadActiveTask(): ActiveTaskRecord | null {
  try {
    return parseActiveTask(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

/** Clear the pointer if it is `runId`'s — another tab may have started a
 *  newer task since. */
export function clearActiveTask(runId: string): void {
  try {
    if (parseActiveTask(localStorage.getItem(STORAGE_KEY))?.runId === runId) {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // ignore
  }
}
