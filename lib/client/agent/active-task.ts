"use client"
import "client-only"

/**
 * localStorage-backed pointer to the one in-flight task, so a reload
 * can reconnect (resume-on-reload). The record shape + validation live
 * in the shared codec; this file is the browser I/O around it. Single
 * slot — v1 runs one task at a time.
 */

import {
  parseActiveTask,
  serializeActiveTask,
  type ActiveTaskRecord,
} from "@/shared/agent/active-task"

const STORAGE_KEY = "humm.activeTask"

/** A stale pointer (producer died, tab closed for a long time) is aged
 *  out so we don't try to resume a run that finished hours ago. */
const MAX_AGE_MS = 60 * 60_000

export function saveActiveTask(record: ActiveTaskRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeActiveTask(record))
  } catch {
    // Private mode / quota — non-fatal; resume-on-reload just won't work.
  }
}

export function loadActiveTask(): ActiveTaskRecord | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  const record = parseActiveTask(raw)
  if (!record) return null
  if (Date.now() - new Date(record.updatedAt).getTime() > MAX_AGE_MS) {
    clearActiveTask()
    return null
  }
  return record
}

export function clearActiveTask(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
