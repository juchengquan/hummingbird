import "client-only"

/**
 * localStorage-backed pointers to each conversation's in-flight or
 * interrupted run (Q35/Q36), so a reload can rejoin the answer from its
 * cursor or show the interrupt's answer cards. Mirrors
 * `lib/client/agent/active-task.ts` (record shape + validation in the
 * shared codec, `lib/shared/runs/active-run.ts`), with one slot per
 * conversation instead of one in total: several conversations may be
 * answering at once.
 *
 * Who writes it (wave 4b-A): save on `RUN_STARTED` (`status: "running"`),
 * update the cursor as events arrive (throttled — `onCursor`), set
 * `status: "interrupted"` when the run pauses, clear it when the run
 * ends any other way or the conversation is deleted.
 */

import {
  parseActiveRuns,
  serializeActiveRuns,
  type ActiveRunMap,
  type ActiveRunRecord,
} from "@/shared/runs/active-run"

import type { TokenStorage } from "./run-tokens"

export type { ActiveRunRecord }

const STORAGE_KEY = "humm.activeRuns"

/** A pointer untouched for this long is dropped: an interactive run that
 *  old is over (a dead process fails it, Q28), and rejoining a finished
 *  run only replays it. */
export const MAX_AGE_MS = 24 * 60 * 60_000

function defaultStorage(): TokenStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function read(storage: TokenStorage | null, now: number): ActiveRunMap {
  if (!storage) return {}
  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  const map = parseActiveRuns(raw)
  for (const [conversationId, record] of Object.entries(map)) {
    if (now - new Date(record.updatedAt).getTime() > MAX_AGE_MS) delete map[conversationId]
  }
  return map
}

function write(storage: TokenStorage | null, map: ActiveRunMap): void {
  if (!storage) return
  try {
    if (Object.keys(map).length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, serializeActiveRuns(map))
  } catch {
    // Private mode / quota — non-fatal; rejoin-on-reload just won't work.
  }
}

/** Save (or replace) the conversation's pointer; `updatedAt` is stamped. */
export function saveActiveRun(
  record: Omit<ActiveRunRecord, "updatedAt">,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const map = read(storage, now)
  map[record.conversationId] = { ...record, updatedAt: new Date(now).toISOString() }
  write(storage, map)
}

/** Patch the conversation's pointer — only while it still names `runId`
 *  (a newer run of the same conversation owns the slot otherwise). */
export function updateActiveRun(
  conversationId: string,
  runId: string,
  patch: Partial<Pick<ActiveRunRecord, "cursor" | "status">>,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const map = read(storage, now)
  const current = map[conversationId]
  if (!current || current.runId !== runId) return
  map[conversationId] = { ...current, ...patch, updatedAt: new Date(now).toISOString() }
  write(storage, map)
}

export function loadActiveRun(
  conversationId: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): ActiveRunRecord | null {
  return read(storage, now)[conversationId] ?? null
}

/** Every live pointer (e.g. to rejoin all of them on app start). */
export function listActiveRuns(
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): ActiveRunRecord[] {
  return Object.values(read(storage, now))
}

/** Clear the conversation's pointer; with `runId`, only if it still names
 *  that run (the "still my run" guard, like `setConversationStreaming`'s). */
export function clearActiveRun(
  conversationId: string,
  runId?: string,
  storage: TokenStorage | null = defaultStorage(),
  now: number = Date.now(),
): void {
  const map = read(storage, now)
  const current = map[conversationId]
  if (!current) return
  if (runId !== undefined && current.runId !== runId) return
  delete map[conversationId]
  write(storage, map)
}
